import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createTopic,
  createUniqueTopicName,
  httpJson,
  startTestApplication,
  type HttpJsonResponse,
  type TestApplication,
} from './harness.js';
import { waitForBroker } from './readiness.js';
import type {
  GroupDeletionResult,
  KafkaGroupAdmin,
} from '../../src/application/ports/kafka-consumer.js';

const skipMessage =
  'Consumer reopen integration tests skipped: Kafka broker is unavailable at the configured address.';
const check = { headers: [], values: [] };

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

describe('consumer reopen and records published during downtime', () => {
  let brokerReady = false;
  const applications: TestApplication[] = [];

  beforeAll(async () => {
    brokerReady = await waitForBroker();
    if (!brokerReady) console.warn(`[integration] ${skipMessage}`);
  }, 10_000);

  afterAll(async () => {
    try {
      for (const application of applications) await application.cleanup();
    } finally {
      await cleanup();
    }
  }, 30_000);

  async function openApplication(
    groupAdmin?: KafkaGroupAdmin & { readonly close: () => Promise<void> },
  ): Promise<TestApplication> {
    const application = await startTestApplication({
      env: { KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS: '0' },
      ...(groupAdmin === undefined ? {} : { groupAdmin }),
    });
    applications.push(application);
    return application;
  }

  async function createTestTopic(prefix: string): Promise<string> {
    const topic = createUniqueTopicName(prefix);
    await createTopic(topic);
    return topic;
  }

  async function publish(
    application: TestApplication,
    topic: string,
    status: string,
  ): Promise<HttpJsonResponse> {
    return httpJson(
      application.baseUrl,
      'POST',
      `/api/v1/topics/${encodeURIComponent(topic)}/records`,
      { value: { type: 'JSON', data: { status } } },
    );
  }

  async function registerSlot(application: TestApplication, topic: string): Promise<string> {
    const response = await httpJson(application.baseUrl, 'POST', '/api/v1/slots', {
      topic,
      checks: [check],
      autoDeleteSeconds: 1,
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String) });
    return (response.body as { id: string }).id;
  }

  function checkPath(id: string): string {
    return `/api/v1/slots/${encodeURIComponent(id)}/checks/0`;
  }

  async function waitForOne(application: TestApplication, id: string): Promise<HttpJsonResponse> {
    return httpJson(application.baseUrl, 'POST', `${checkPath(id)}/wait?n=1&timeoutMs=10000`);
  }

  async function readOne(application: TestApplication, id: string): Promise<HttpJsonResponse> {
    return httpJson(application.baseUrl, 'GET', checkPath(id));
  }

  async function closeIdleConsumer(
    application: TestApplication,
    id: string,
    topic: string,
  ): Promise<void> {
    await expect(
      pollUntil(
        () => application.test.slots.runPass(),
        (deleted) => deleted.includes(id),
        'slot expiration',
      ),
    ).resolves.toEqual([id]);
    await expect(
      pollUntil(
        () => application.test.consumerIdle.runPass(),
        (results) =>
          results.some((result) => result.topic === topic && result.outcome === 'closed'),
        'consumer idle close',
      ),
    ).resolves.toEqual([{ topic, outcome: 'closed' }]);
  }

  async function verifyOnlyNewRecord(
    application: TestApplication,
    topic: string,
    firstGroupId: string,
    reopenedId?: string,
  ): Promise<void> {
    const reopenedGroupId = application.test.getGroupId(topic);
    expect(reopenedGroupId).toBe(firstGroupId);

    const slotId = reopenedId ?? (await registerSlot(application, topic));
    const waiting = waitForOne(application, slotId);
    const publication = await publish(application, topic, 'C');
    expect(publication.status).toBe(201);
    await expect(waiting).resolves.toMatchObject({ status: 200, body: {} });

    const count = await httpJson(application.baseUrl, 'GET', `${checkPath(slotId)}/count`);
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ count: 1 });

    const records = await readOne(application, slotId);
    expect(records.status).toBe(200);
    expect(records.body).toEqual([
      expect.objectContaining({ value: { type: 'JSON', data: { status: 'C' } } }),
    ]);
  }

  it('reopens with the same group and skips records published while closed', async ({ skip }) => {
    if (!brokerReady) {
      skip(skipMessage);
      return;
    }

    const application = await openApplication();
    const topic = await createTestTopic('consumer-reopen-basic');
    const firstId = await registerSlot(application, topic);
    const firstGroupId = application.test.getGroupId(topic);

    const firstPublication = await publish(application, topic, 'A');
    expect(firstPublication.status).toBe(201);
    await expect(waitForOne(application, firstId)).resolves.toMatchObject({
      status: 200,
      body: {},
    });

    await closeIdleConsumer(application, firstId, topic);
    expect(application.test.consumers.getState(topic)).toBe('absent');

    const downtimePublication = await publish(application, topic, 'B');
    expect(downtimePublication.status).toBe(201);
    await verifyOnlyNewRecord(application, topic, firstGroupId);
  }, 20_000);

  it('reopens after a completed failed group deletion and skips downtime records', async ({
    skip,
  }) => {
    if (!brokerReady) {
      skip(skipMessage);
      return;
    }

    let startDeletion!: () => void;
    let releaseDeletion!: (result: GroupDeletionResult) => void;
    const deletionStarted = new Promise<void>((resolve) => {
      startDeletion = resolve;
    });
    const deletionResult = new Promise<GroupDeletionResult>((resolve) => {
      releaseDeletion = resolve;
    });
    const groupAdmin = {
      deleteGroup: async (): Promise<GroupDeletionResult> => {
        startDeletion();
        return deletionResult;
      },
      close: async (): Promise<void> => undefined,
    };
    const application = await openApplication(groupAdmin);
    const topic = await createTestTopic('consumer-reopen-delete-failure');
    const firstId = await registerSlot(application, topic);
    const firstGroupId = application.test.getGroupId(topic);

    const firstPublication = await publish(application, topic, 'A');
    expect(firstPublication.status).toBe(201);
    await expect(waitForOne(application, firstId)).resolves.toMatchObject({
      status: 200,
      body: {},
    });

    await expect(
      pollUntil(
        () => application.test.slots.runPass(),
        (deleted) => deleted.includes(firstId),
        'slot expiration',
      ),
    ).resolves.toEqual([firstId]);
    const closing = pollUntil(
      () => application.test.consumerIdle.runPass(),
      (results) => results.some((result) => result.topic === topic && result.outcome === 'closed'),
      'consumer idle close',
    );
    await deletionStarted;

    const downtimePublication = await publish(application, topic, 'B');
    expect(downtimePublication.status).toBe(201);

    let reopened = false;
    const reopening = registerSlot(application, topic).then((id) => {
      reopened = true;
      return id;
    });
    await Promise.resolve();
    expect(reopened).toBe(false);

    releaseDeletion({ kind: 'failed', reason: 'broker' });
    await expect(closing).resolves.toEqual([{ topic, outcome: 'closed' }]);
    const reopenedId = await reopening;
    expect(reopenedId).toEqual(expect.any(String));

    await verifyOnlyNewRecord(application, topic, firstGroupId, reopenedId);
  }, 20_000);
});
