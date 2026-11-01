import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createTopic,
  createUniqueTopicName,
  httpJson,
  readRawMessages,
  startTestApplication,
  type HttpJsonResponse,
  type TestApplication,
} from './harness.js';
import { waitForBroker } from './readiness.js';

const skipMessage =
  'Slot flow integration tests skipped: Kafka broker is unavailable at the configured address.';
const check = {
  headers: [{ name: 'correlationId', value: 'corr-1' }],
  values: [{ jsonPath: '$.status', value: 'COMPLETED' }],
};
const originalJson = Buffer.from('{"status":"COMPLETED"}');

describe('end-to-end slot registration and waiting', () => {
  let brokerReady = false;
  let application: TestApplication | undefined;

  beforeAll(async () => {
    brokerReady = await waitForBroker();
    if (!brokerReady) {
      console.warn(`[integration] ${skipMessage}`);
      return;
    }

    try {
      application = await startTestApplication();
    } catch (error: unknown) {
      brokerReady = false;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[integration] ${skipMessage} Startup failed: ${reason}`);
    }
  }, 20_000);

  afterAll(async () => {
    try {
      await application?.cleanup();
    } finally {
      await cleanup();
    }
  });

  async function createTestTopic(prefix: string): Promise<string> {
    const topic = createUniqueTopicName(prefix);
    await createTopic(topic);
    return topic;
  }

  async function publish(topic: string, status: string): Promise<HttpJsonResponse> {
    if (application === undefined) throw new Error('Test application is unavailable');
    return httpJson(
      application.baseUrl,
      'POST',
      `/api/v1/topics/${encodeURIComponent(topic)}/records`,
      {
        headers: [{ name: 'correlationId', value: 'corr-1' }],
        value: { type: 'JSON', data: { status } },
      },
    );
  }

  async function registerSlot(topic: string): Promise<string> {
    if (application === undefined) throw new Error('Test application is unavailable');
    const response = await httpJson(application.baseUrl, 'POST', '/api/v1/slots', {
      topic,
      checks: [check],
      autoDeleteSeconds: 60,
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String) });
    const id = (response.body as { id: string }).id;
    expect(id.length).toBeGreaterThan(0);
    return id;
  }

  function checkPath(id: string): string {
    return `/api/v1/slots/${encodeURIComponent(id)}/checks/0`;
  }

  function waitPath(id: string): string {
    return `${checkPath(id)}/wait`;
  }

  async function startWait(id: string, n: number, timeoutMs: number): Promise<HttpJsonResponse> {
    if (application === undefined) throw new Error('Test application is unavailable');
    return httpJson(application.baseUrl, 'POST', `${waitPath(id)}?n=${n}&timeoutMs=${timeoutMs}`);
  }

  it('registers a ready slot and observes only records published afterward', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('slot-flow-history');
    const earlierPublication = await publish(topic, 'COMPLETED');
    expect(earlierPublication.status).toBe(201);

    const earlierMessages = await readRawMessages(topic, 1, 5_000);
    expect(earlierMessages[0]?.value).toEqual(originalJson);
    expect(earlierMessages[0]?.headers).toEqual([
      { name: 'correlationId', value: Buffer.from('corr-1') },
    ]);

    const id = await registerSlot(topic);
    const waitStartedAt = performance.now();
    let waitCompletedAt: number | undefined;
    const waiting = startWait(id, 1, 10_000).then((response) => {
      waitCompletedAt = performance.now();
      return response;
    });

    const publication = await publish(topic, 'COMPLETED');
    expect(publication.status).toBe(201);
    const waitResponse = await waiting;
    expect(waitResponse.status).toBe(200);
    expect(waitResponse.body).toEqual({});
    expect(waitCompletedAt).toBeDefined();
    expect((waitCompletedAt as number) - waitStartedAt).toBeLessThan(10_000);

    const messages = await readRawMessages(topic, 2, 5_000);
    expect(messages[1]?.value).toEqual(originalJson);
    expect(messages[1]?.headers).toEqual([{ name: 'correlationId', value: Buffer.from('corr-1') }]);

    const count = await httpJson(application.baseUrl, 'GET', `${checkPath(id)}/count`);
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ count: 1 });

    const records = await httpJson(application.baseUrl, 'GET', checkPath(id));
    expect(records.status).toBe(200);
    expect(records.body).toHaveLength(1);
    expect(records.body).toEqual([
      expect.objectContaining({
        headers: [{ name: 'correlationId', value: 'corr-1' }],
        value: { type: 'JSON', data: { status: 'COMPLETED' } },
      }),
    ]);
  }, 20_000);

  it('does not complete a wait for a nonmatching record', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('slot-flow-mismatch');
    const id = await registerSlot(topic);
    let waitCompleted = false;
    const waiting = startWait(id, 1, 10_000).then((response) => {
      waitCompleted = true;
      return response;
    });

    const mismatch = await publish(topic, 'PENDING');
    expect(mismatch.status).toBe(201);
    const messages = await readRawMessages(topic, 1, 5_000);
    expect(messages[0]?.value).toEqual(Buffer.from('{"status":"PENDING"}'));
    expect(waitCompleted).toBe(false);

    const matching = await publish(topic, 'COMPLETED');
    expect(matching.status).toBe(201);
    const response = await waiting;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});

    const count = await httpJson(application.baseUrl, 'GET', `${checkPath(id)}/count`);
    expect(count.body).toEqual({ count: 1 });
  }, 20_000);

  it('continues accumulating after a wait times out', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('slot-flow-timeout');
    const id = await registerSlot(topic);

    const firstPublication = await publish(topic, 'COMPLETED');
    expect(firstPublication.status).toBe(201);
    const firstWait = await startWait(id, 1, 10_000);
    expect(firstWait.status).toBe(200);
    expect(firstWait.body).toEqual({});

    const timedOut = await startWait(id, 2, 500);
    expect(timedOut.status).toBe(504);
    expect(timedOut.body).toEqual({});

    const secondPublication = await publish(topic, 'COMPLETED');
    expect(secondPublication.status).toBe(201);
    const accumulated = await startWait(id, 2, 10_000);
    expect(accumulated.status).toBe(200);
    expect(accumulated.body).toEqual({});

    const count = await httpJson(application.baseUrl, 'GET', `${checkPath(id)}/count`);
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ count: 2 });
  }, 20_000);
});
