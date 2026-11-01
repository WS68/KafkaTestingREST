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

const skipMessage =
  'Slot pagination integration tests skipped: Kafka broker is unavailable at the configured address.';

type RecordBody = {
  readonly value?: {
    readonly data?: {
      readonly seq?: number;
    };
  };
};

describe('end-to-end slot counting, pagination, and deletion', () => {
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

  async function registerSlot(topic: string, checks: readonly unknown[]): Promise<string> {
    if (application === undefined) throw new Error('Test application is unavailable');
    const response = await httpJson(application.baseUrl, 'POST', '/api/v1/slots', {
      topic,
      checks,
      autoDeleteSeconds: 60,
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String) });
    const id = (response.body as { id: string }).id;
    expect(id.length).toBeGreaterThan(0);
    return id;
  }

  async function publish(
    topic: string,
    seq: number,
    options: { readonly type?: string; readonly status?: string } = {},
  ): Promise<void> {
    if (application === undefined) throw new Error('Test application is unavailable');
    const response = await httpJson(
      application.baseUrl,
      'POST',
      `/api/v1/topics/${encodeURIComponent(topic)}/records`,
      {
        headers: options.type === undefined ? [] : [{ name: 'type', value: options.type }],
        value: {
          type: 'JSON',
          data: {
            seq,
            ...(options.status === undefined ? {} : { status: options.status }),
          },
        },
      },
    );
    expect(response.status).toBe(201);
  }

  function checkPath(id: string, index = 0): string {
    return `/api/v1/slots/${encodeURIComponent(id)}/checks/${index}`;
  }

  async function count(id: string, index = 0): Promise<HttpJsonResponse> {
    if (application === undefined) throw new Error('Test application is unavailable');
    return httpJson(application.baseUrl, 'GET', `${checkPath(id, index)}/count`);
  }

  async function read(id: string, index: number, offset: number, count: number) {
    if (application === undefined) throw new Error('Test application is unavailable');
    return httpJson(
      application.baseUrl,
      'GET',
      `${checkPath(id, index)}?offset=${offset}&count=${count}`,
    );
  }

  async function waitForCount(id: string, index: number, n: number): Promise<HttpJsonResponse> {
    if (application === undefined) throw new Error('Test application is unavailable');
    return httpJson(
      application.baseUrl,
      'POST',
      `${checkPath(id, index)}/wait?n=${n}&timeoutMs=${10_000}`,
    );
  }

  function sequenceNumbers(response: HttpJsonResponse): number[] {
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    return (response.body as RecordBody[]).map((record) => record.value?.data?.seq as number);
  }

  it('counts five records and returns ordered pages without changing the count', async ({
    skip,
  }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('slot-pagination-pages');
    const id = await registerSlot(topic, [{}]);
    for (let seq = 1; seq <= 5; seq += 1) await publish(topic, seq);

    const ready = await waitForCount(id, 0, 5);
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({});
    expect(await count(id)).toMatchObject({ status: 200, body: { count: 5 } });

    expect(sequenceNumbers(await read(id, 0, 0, 2))).toEqual([1, 2]);
    expect(await count(id)).toMatchObject({ status: 200, body: { count: 5 } });
    expect(sequenceNumbers(await read(id, 0, 2, 2))).toEqual([3, 4]);
    expect(sequenceNumbers(await read(id, 0, 4, 2))).toEqual([5]);
    const beyondEnd = await read(id, 0, 10, 2);
    expect(beyondEnd.status).toBe(200);
    expect(beyondEnd.body).toEqual([]);
    expect(sequenceNumbers(await read(id, 0, 0, 20))).toEqual([1, 2, 3, 4, 5]);
  }, 20_000);

  it('keeps check counts independent and makes deletion observable and repeatable', async ({
    skip,
  }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('slot-pagination-checks');
    const id = await registerSlot(topic, [
      { headers: [{ name: 'type', value: 'a' }] },
      { values: [{ jsonPath: '$.status', value: 'DONE' }] },
    ]);
    await publish(topic, 1, { type: 'a', status: 'PENDING' });
    await publish(topic, 2, { type: 'b', status: 'DONE' });
    await publish(topic, 3, { type: 'a', status: 'DONE' });
    await publish(topic, 4, { type: 'b', status: 'PENDING' });

    const firstReady = await waitForCount(id, 0, 2);
    const secondReady = await waitForCount(id, 1, 2);
    expect(firstReady.status).toBe(200);
    expect(secondReady.status).toBe(200);
    expect(await count(id, 0)).toMatchObject({ status: 200, body: { count: 2 } });
    expect(await count(id, 1)).toMatchObject({ status: 200, body: { count: 2 } });
    expect(sequenceNumbers(await read(id, 0, 0, 10))).toEqual([1, 3]);
    expect(await count(id, 1)).toMatchObject({ status: 200, body: { count: 2 } });
    expect(sequenceNumbers(await read(id, 1, 0, 10))).toEqual([2, 3]);

    const deleted = await httpJson(application.baseUrl, 'DELETE', `/api/v1/slots/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({});

    expect(await count(id)).toMatchObject({ status: 404, body: { code: 'SLOT_NOT_FOUND' } });
    expect(await read(id, 0, 0, 10)).toMatchObject({
      status: 404,
      body: { code: 'SLOT_NOT_FOUND' },
    });
    expect(await waitForCount(id, 0, 1)).toMatchObject({
      status: 404,
      body: { code: 'SLOT_NOT_FOUND' },
    });
    expect(await httpJson(application.baseUrl, 'DELETE', `/api/v1/slots/${id}`)).toMatchObject({
      status: 404,
      body: { code: 'SLOT_NOT_FOUND' },
    });
  }, 20_000);

  it('does not let reading records interfere with a pending wait', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('slot-pagination-wait-read');
    const id = await registerSlot(topic, [{}]);
    await publish(topic, 1);
    expect(await waitForCount(id, 0, 1)).toMatchObject({ status: 200, body: {} });

    const waiting = waitForCount(id, 0, 3);
    expect(sequenceNumbers(await read(id, 0, 0, 10))).toEqual([1]);
    await publish(topic, 2);
    await publish(topic, 3);

    const response = await waiting;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
    expect(await count(id)).toMatchObject({ status: 200, body: { count: 3 } });
  }, 20_000);
});
