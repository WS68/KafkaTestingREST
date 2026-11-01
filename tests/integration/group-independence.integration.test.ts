import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kafka, type Admin } from 'kafkajs';
import { topicHash } from '../../src/infrastructure/consumers/group-name.js';
import {
  cleanup,
  createTopic,
  createUniqueTopicName,
  httpJson,
  startTestApplication,
  type TestApplication,
} from './harness.js';
import { getBrokerAddress } from './env.js';
import { waitForBroker } from './readiness.js';

const skipMessage =
  'Group independence integration tests skipped: Kafka broker is unavailable at the configured address.';
const consumerGroupPrefix = 'group-independence';
const check = { headers: [], values: [] };

type GroupState = 'absent' | 'empty' | 'active';

async function pollUntil<T>(
  operation: () => Promise<T>,
  isReady: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let value = await operation();
  while (!isReady(value)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    value = await operation();
  }
  return value;
}

async function groupState(admin: Admin, groupId: string): Promise<GroupState> {
  const groups = await admin.listGroups();
  if (!groups.groups.some((group) => group.groupId === groupId)) return 'absent';

  try {
    const described = await admin.describeGroups([groupId]);
    const group = described.groups.find((candidate) => candidate.groupId === groupId);
    if (group === undefined || group.members.length === 0) return 'empty';
    return 'active';
  } catch {
    return 'absent';
  }
}

function groupParts(groupId: string): { readonly runId: string; readonly hash: string } {
  const match = new RegExp(
    `^${consumerGroupPrefix}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9]+)$`,
  ).exec(groupId);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Unexpected consumer group name: ${groupId}`);
  }
  return { runId: match[1], hash: match[2] };
}

describe('independent consumer groups and resource release', () => {
  let brokerReady = false;
  let admin: Admin | undefined;
  let application: TestApplication | undefined;

  beforeAll(async () => {
    brokerReady = await waitForBroker();
    if (!brokerReady) {
      console.warn(`[integration] ${skipMessage}`);
      return;
    }

    admin = new Kafka({
      clientId: `kafka-testing-rest-integration-group-independence-${randomUUID()}`,
      brokers: [getBrokerAddress()],
    }).admin();
    await admin.connect();

    try {
      application = await startTestApplication({
        env: {
          KAFKA_TESTING_REST_CONSUMER_GROUP_PREFIX: consumerGroupPrefix,
          KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS: '0',
        },
      });
    } catch (error: unknown) {
      brokerReady = false;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[integration] ${skipMessage} Startup failed: ${reason}`);
    }
  }, 15_000);

  afterAll(async () => {
    try {
      if (application !== undefined) await application.cleanup();
    } finally {
      await cleanup();
      if (admin !== undefined) {
        await admin.disconnect();
        admin = undefined;
      }
    }
  }, 30_000);

  async function registerSlot(topic: string): Promise<string> {
    if (application === undefined) throw new Error('Test application is unavailable');
    const response = await httpJson(application.baseUrl, 'POST', '/api/v1/slots', {
      topic,
      checks: [check],
      autoDeleteSeconds: 1,
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String) });
    return (response.body as { id: string }).id;
  }

  function checkPath(slotId: string): string {
    return `/api/v1/slots/${encodeURIComponent(slotId)}/checks/0`;
  }

  async function waitForRecord(slotId: string): Promise<void> {
    if (application === undefined) throw new Error('Test application is unavailable');
    const response = await httpJson(
      application.baseUrl,
      'POST',
      `${checkPath(slotId)}/wait?n=1&timeoutMs=10000`,
    );
    expect(response.status).toBe(200);
  }

  async function publish(topic: string, sequence: number): Promise<void> {
    if (application === undefined) throw new Error('Test application is unavailable');
    const response = await httpJson(
      application.baseUrl,
      'POST',
      `/api/v1/topics/${encodeURIComponent(topic)}/records`,
      { value: { type: 'JSON', data: { sequence } } },
    );
    expect(response.status).toBe(201);
  }

  async function count(slotId: string, expected: number): Promise<void> {
    if (application === undefined) throw new Error('Test application is unavailable');
    const response = await httpJson(application.baseUrl, 'GET', `${checkPath(slotId)}/count`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: expected });
  }

  it('keeps two topic groups independent and releases all service clients', async ({ skip }) => {
    if (!brokerReady || admin === undefined || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topicA = createUniqueTopicName('group-independence-a');
    const topicB = createUniqueTopicName('group-independence-b');
    await createTopic(topicA);
    await createTopic(topicB);

    const slotA = await registerSlot(topicA);
    const slotB = await registerSlot(topicB);
    const groupA = application.test.getGroupId(topicA);
    const groupB = application.test.getGroupId(topicB);
    const partsA = groupParts(groupA);
    const partsB = groupParts(groupB);

    expect(groupA).toContain(consumerGroupPrefix);
    expect(groupB).toContain(consumerGroupPrefix);
    expect(partsA.runId).toBe(partsB.runId);
    expect(partsA.hash).toBe(topicHash(topicA));
    expect(partsB.hash).toBe(topicHash(topicB));
    expect(partsA.hash).not.toBe(partsB.hash);
    expect(groupA).not.toBe(groupB);

    const firstWaitA = waitForRecord(slotA);
    const firstWaitB = waitForRecord(slotB);
    await publish(topicA, 1);
    await publish(topicB, 1);
    await Promise.all([firstWaitA, firstWaitB]);
    await count(slotA, 1);
    await count(slotB, 1);

    const deletion = await httpJson(
      application.baseUrl,
      'DELETE',
      `/api/v1/slots/${encodeURIComponent(slotA)}`,
    );
    expect(deletion.status).toBe(200);
    await expect(application.test.consumers.close(topicA, 'idle')).resolves.toBeUndefined();
    const kafkaAdmin = admin;
    await expect(
      pollUntil(
        () => groupState(kafkaAdmin, groupA),
        (state) => state === 'absent' || state === 'empty',
        'topic A consumer group deletion',
      ),
    ).resolves.toMatch(/absent|empty/);
    await expect(
      pollUntil(
        () => groupState(kafkaAdmin, groupB),
        (state) => state !== 'absent',
        'topic B group',
      ),
    ).resolves.toBe('active');

    const secondWaitB = waitForRecord(slotB);
    await publish(topicB, 2);
    await secondWaitB;
    await count(slotB, 2);

    const runningApplication = application;
    await expect(runningApplication.shutdown()).resolves.toBeUndefined();
    await expect(fetch(runningApplication.baseUrl)).rejects.toThrow();

    const finalStateA = await pollUntil(
      () => groupState(kafkaAdmin, groupA),
      (state) => state !== 'active',
      'topic A clients after shutdown',
    );
    const finalStateB = await pollUntil(
      () => groupState(kafkaAdmin, groupB),
      (state) => state !== 'active',
      'topic B clients after shutdown',
    );
    if (finalStateA !== 'absent' || finalStateB !== 'absent') {
      console.warn(
        `[integration] Kafka group deletion result after shutdown: ${groupA}=${finalStateA}, ${groupB}=${finalStateB}`,
      );
    }
    expect(finalStateA).not.toBe('active');
    expect(finalStateB).not.toBe('active');
    await expect(runningApplication.shutdown()).resolves.toBeUndefined();
  }, 30_000);
});
