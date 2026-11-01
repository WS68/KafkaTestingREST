import { Kafka } from 'kafkajs';
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
import { getBrokerAddress } from './env.js';
import { waitForBroker } from './readiness.js';
import type { KafkaPorts } from '../../src/infrastructure/kafka/create-kafka-ports.js';

const skipMessage =
  'Wait failure integration tests skipped: Kafka broker is unavailable at the configured address.';
const check = { values: [{ jsonPath: '$.status', value: 'COMPLETED' }] };

describe('end-to-end wait failures and publishing independence', () => {
  let brokerReady = false;
  let application: TestApplication | undefined;
  const applications: TestApplication[] = [];

  beforeAll(async () => {
    brokerReady = await waitForBroker();
    if (!brokerReady) {
      console.warn(`[integration] ${skipMessage}`);
      return;
    }

    try {
      application = await startTestApplication();
      applications.push(application);
    } catch (error: unknown) {
      brokerReady = false;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[integration] ${skipMessage} Startup failed: ${reason}`);
    }
  }, 20_000);

  afterAll(async () => {
    try {
      for (const testApplication of applications) await testApplication.cleanup();
    } finally {
      await cleanup();
    }
  });

  async function createTestTopic(prefix: string): Promise<string> {
    const topic = createUniqueTopicName(prefix);
    await createTopic(topic);
    return topic;
  }

  function checkPath(id: string): string {
    return `/api/v1/slots/${encodeURIComponent(id)}/checks/0`;
  }

  async function registerSlot(testApplication: TestApplication, topic: string): Promise<string> {
    const response = await httpJson(testApplication.baseUrl, 'POST', '/api/v1/slots', {
      topic,
      checks: [check],
      autoDeleteSeconds: 60,
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String) });
    return (response.body as { id: string }).id;
  }

  async function publish(
    testApplication: TestApplication,
    topic: string,
    status = 'COMPLETED',
  ): Promise<HttpJsonResponse> {
    return httpJson(
      testApplication.baseUrl,
      'POST',
      `/api/v1/topics/${encodeURIComponent(topic)}/records`,
      { value: { type: 'JSON', data: { status } } },
    );
  }

  async function startWait(
    testApplication: TestApplication,
    id: string,
    n: number,
    timeoutMs: number,
  ): Promise<HttpJsonResponse> {
    return httpJson(
      testApplication.baseUrl,
      'POST',
      `${checkPath(id)}/wait?n=${n}&timeoutMs=${timeoutMs}`,
    );
  }

  async function waitForPendingWaits(
    testApplication: TestApplication,
    expected: number,
  ): Promise<void> {
    const waits = testApplication.test.waits;
    if (waits === undefined) throw new Error('Wait registry is unavailable');
    const deadline = Date.now() + 2_000;
    while (waits.pendingCount() < expected) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for HTTP waits to register');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async function publishDirectly(topic: string): Promise<void> {
    const producer = new Kafka({
      clientId: `kafka-testing-rest-wait-failure-${Date.now()}`,
      brokers: [getBrokerAddress()],
    }).producer();
    try {
      await producer.connect();
      await producer.send({
        topic,
        messages: [{ value: JSON.stringify({ status: 'COMPLETED' }) }],
      });
    } finally {
      await producer.disconnect();
    }
  }

  function failedPublisher(): KafkaPorts['publisher'] {
    return {
      publish: async () => ({ kind: 'failed', reason: 'broker' }),
      close: async () => undefined,
      drain: async () => true,
      get inFlightCount() {
        return 0;
      },
    };
  }

  it('distinguishes timeout from deletion and keeps the slot after deletion', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const timeoutTopic = await createTestTopic('wait-failures-timeout');
    const deletionTopic = await createTestTopic('wait-failures-deletion');
    const timeoutSlot = await registerSlot(application, timeoutTopic);
    const deletionSlot = await registerSlot(application, deletionTopic);

    const timedOut = startWait(application, timeoutSlot, 1, 500);
    const deleted = startWait(application, deletionSlot, 1, 10_000);
    await waitForPendingWaits(application, 2);
    const deletion = await httpJson(
      application.baseUrl,
      'DELETE',
      `/api/v1/slots/${encodeURIComponent(deletionSlot)}`,
    );
    expect(deletion.status).toBe(200);

    const [timeoutResponse, deletedResponse] = await Promise.all([timedOut, deleted]);
    expect(timeoutResponse.status).toBe(504);
    expect(timeoutResponse.body).toEqual({});
    expect(deletedResponse.status).toBe(409);
    expect(deletedResponse.body).toMatchObject({ code: 'SLOT_DELETED' });
    expect(timeoutResponse.body).not.toEqual(deletedResponse.body);

    expect(
      await httpJson(application.baseUrl, 'GET', `${checkPath(deletionSlot)}/count`),
    ).toMatchObject({
      status: 404,
      body: { code: 'SLOT_NOT_FOUND' },
    });
    expect(await httpJson(application.baseUrl, 'GET', checkPath(deletionSlot))).toMatchObject({
      status: 404,
      body: { code: 'SLOT_NOT_FOUND' },
    });
  }, 20_000);

  it('continues accumulating after a wait timeout', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('wait-failures-accumulation');
    const id = await registerSlot(application, topic);
    const timedOut = await startWait(application, id, 1, 500);
    expect(timedOut.status).toBe(504);
    expect(timedOut.body).toEqual({});

    const publication = await publish(application, topic);
    expect(publication.status).toBe(201);
    const ready = await startWait(application, id, 1, 10_000);
    expect(ready.status).toBe(200);

    expect(await httpJson(application.baseUrl, 'GET', `${checkPath(id)}/count`)).toEqual({
      status: 200,
      headers: expect.any(Object),
      body: { count: 1 },
    });
    expect(await httpJson(application.baseUrl, 'GET', checkPath(id))).toMatchObject({
      status: 200,
      body: [expect.objectContaining({ value: { type: 'JSON', data: { status: 'COMPLETED' } } })],
    });
  }, 20_000);

  it('keeps slot state and allows a new wait after an isolated publishing failure', async ({
    skip,
  }) => {
    if (!brokerReady) {
      skip(skipMessage);
      return;
    }

    const failedApplication = await startTestApplication({ publisher: failedPublisher() });
    applications.push(failedApplication);
    const topic = await createTestTopic('wait-failures-publisher');
    const id = await registerSlot(failedApplication, topic);
    await publishDirectly(topic);
    const accumulated = await startWait(failedApplication, id, 1, 10_000);
    expect(accumulated.status).toBe(200);

    const beforeFailure = await httpJson(
      failedApplication.baseUrl,
      'GET',
      `${checkPath(id)}/count`,
    );
    expect(beforeFailure).toMatchObject({ status: 200, body: { count: 1 } });

    const failedPublication = await publish(failedApplication, topic);
    expect(failedPublication.status).toBe(503);
    const failureBody = failedPublication.body as { code: string; message: string };
    expect(failureBody.code).toBe('KAFKA_UNAVAILABLE');
    expect(failureBody.message).not.toMatch(/не передан|не отправлен|не доставлен/i);

    expect(
      await httpJson(failedApplication.baseUrl, 'GET', `${checkPath(id)}/count`),
    ).toMatchObject({
      status: 200,
      body: { count: 1 },
    });
    expect(await httpJson(failedApplication.baseUrl, 'GET', checkPath(id))).toMatchObject({
      status: 200,
      body: [expect.any(Object)],
    });
    const stillWaiting = await startWait(failedApplication, id, 2, 500);
    expect(stillWaiting.status).toBe(504);
    expect(stillWaiting.body).toEqual({});
  }, 20_000);

  it('does not promise observation when the shared broker is unavailable', async ({ skip }) => {
    if (!brokerReady) {
      skip(skipMessage);
      return;
    }

    let unavailable: TestApplication;
    try {
      unavailable = await startTestApplication({
        skipBrokerCheck: true,
        env: { KAFKA_TESTING_REST_CLUSTER: '127.0.0.1:1' },
      });
      applications.push(unavailable);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      skip(`Kafka client did not return within the bounded unavailable-broker case: ${reason}`);
      return;
    }

    const response = await httpJson(unavailable.baseUrl, 'POST', '/api/v1/slots', {
      topic: createUniqueTopicName('wait-failures-unavailable'),
      checks: [check],
      autoDeleteSeconds: 1,
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'KAFKA_UNAVAILABLE' });
  }, 20_000);
});
