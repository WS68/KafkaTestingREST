import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createTopic,
  createUniqueTopicName,
  httpJson,
  readRawMessages,
  startTestApplication,
  type HttpJsonResponse,
  type RawMessage,
  type TestApplication,
} from './harness.js';
import { waitForBroker } from './readiness.js';

const skipMessage =
  'Publish integration tests skipped: Kafka broker is unavailable at the configured address.';

const stringPublication = {
  headers: [{ name: 'correlationId', value: 'corr-1' }],
  key: { type: 'STRING', data: 'order-42' },
  value: { type: 'STRING', data: 'hello' },
};

async function createTestTopic(prefix: string): Promise<string> {
  const topic = createUniqueTopicName(prefix);
  await createTopic(topic);
  return topic;
}

async function publish(
  application: TestApplication,
  topic: string,
  body: unknown,
  ack?: 0 | 1,
): Promise<HttpJsonResponse> {
  const suffix = ack === undefined ? '' : `?ack=${ack}`;
  return httpJson(
    application.baseUrl,
    'POST',
    `/api/v1/topics/${encodeURIComponent(topic)}/records${suffix}`,
    body,
  );
}

async function readOne(topic: string, timeoutMs = 5_000): Promise<RawMessage> {
  const [message] = await readRawMessages(topic, 1, timeoutMs);
  expect(message).toBeDefined();
  return message as RawMessage;
}

describe('HTTP publication and native Kafka bytes', () => {
  let brokerReady = false;
  let application: TestApplication | undefined;
  let restrictedApplication: TestApplication | undefined;

  beforeAll(async () => {
    brokerReady = await waitForBroker();
    if (!brokerReady) {
      console.warn(`[integration] ${skipMessage}`);
      return;
    }

    try {
      application = await startTestApplication();
      restrictedApplication = await startTestApplication({
        env: { KAFKA_TESTING_REST_PUBLISHER_TOPICS: JSON.stringify(['^allowed\\.']) },
      });
    } catch (error: unknown) {
      brokerReady = false;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[integration] ${skipMessage} Startup failed: ${reason}`);
    }
  });

  afterAll(async () => {
    await application?.cleanup();
    await restrictedApplication?.cleanup();
    await cleanup();
  });

  it('publishes a STRING record with broker acknowledgement and preserves headers and key', async ({
    skip,
  }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('publish-ack-1');
    const response = await publish(application, topic, stringPublication, 1);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({});

    const message = await readOne(topic);
    expect(message.value).toEqual(Buffer.from('hello'));
    expect(message.key).toEqual(Buffer.from('order-42'));
    expect(message.headers).toEqual([{ name: 'correlationId', value: Buffer.from('corr-1') }]);
  }, 15_000);

  it('publishes a STRING record with none acknowledgement and verifies eventual Kafka delivery', async ({
    skip,
  }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('publish-ack-0');
    const response = await publish(application, topic, stringPublication, 0);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({});

    // Ответ 202 не является гарантией доставки; эта проверка отдельно подтверждает появление записи.
    const message = await readOne(topic, 5_000);
    expect(message.value).toEqual(Buffer.from('hello'));
    expect(message.key).toEqual(Buffer.from('order-42'));
    expect(message.headers).toEqual([{ name: 'correlationId', value: Buffer.from('corr-1') }]);
  }, 15_000);

  it('serializes JSON objects compactly and JSON strings as JSON strings', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('publish-json');
    const objectResponse = await publish(application, topic, {
      value: { type: 'JSON', data: { orderId: '42' } },
    });
    const stringResponse = await publish(application, topic, {
      value: { type: 'JSON', data: 'foo' },
    });

    expect(objectResponse.status).toBe(201);
    expect(stringResponse.status).toBe(201);
    const messages = await readRawMessages(topic, 2);
    expect(messages[0]?.value).toEqual(Buffer.from('{"orderId":"42"}'));
    expect(messages[1]?.value).toEqual(Buffer.from('"foo"'));
  }, 15_000);

  it('publishes binary value and binary key bytes, including duplicate headers', async ({
    skip,
  }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const topic = await createTestTopic('publish-binary');
    const response = await publish(application, topic, {
      headers: [
        { name: 'tag', value: 'a' },
        { name: 'tag', value: 'b' },
      ],
      key: { type: 'BINARY', data: 'AAEC' },
      value: { type: 'BINARY', data: 'Zm9vYmFy' },
    });

    expect(response.status).toBe(201);
    // Слот не создавался: двоичное значение проверяется напрямую в Kafka,
    // а не через GET /api/v1/slots/... JSON API сервиса.
    const message = await readOne(topic);
    expect(message.key).toEqual(Buffer.from([0x00, 0x01, 0x02]));
    expect(message.value).toEqual(Buffer.from('foobar'));
    expect(message.headers).toEqual([
      { name: 'tag', value: Buffer.from('a') },
      { name: 'tag', value: Buffer.from('b') },
    ]);
  }, 15_000);

  it('rejects publication to a topic outside publisherTopics', async ({ skip }) => {
    if (!brokerReady || restrictedApplication === undefined) {
      skip(skipMessage);
      return;
    }

    const response = await publish(restrictedApplication, 'other.topic', {
      value: { type: 'STRING', data: 'must-not-be-published' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'TOPIC_NOT_ALLOWED' });
  });

  it('rejects non-canonical base64 data', async ({ skip }) => {
    if (!brokerReady || application === undefined) {
      skip(skipMessage);
      return;
    }

    const response = await publish(application, createUniqueTopicName('publish-invalid-base64'), {
      value: { type: 'BINARY', data: 'Zh==' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'INVALID_BASE64' });
  });
});
