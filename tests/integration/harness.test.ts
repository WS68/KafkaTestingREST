import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Kafka, type Admin, type Producer } from 'kafkajs';
import {
  cleanup,
  createTopic,
  createUniqueTopicName,
  deleteTopics,
  readRawMessages,
} from './harness.js';
import { getBrokerAddress } from './env.js';
import { waitForBroker } from './readiness.js';

const skipMessage =
  'Integration harness tests skipped: Kafka broker is unavailable at the configured address.';

const client = new Kafka({
  clientId: `kafka-testing-rest-integration-harness-test-${randomUUID()}`,
  brokers: [getBrokerAddress()],
});

describe('integration test harness', () => {
  let brokerReady = false;
  let admin: Admin | undefined;
  let producer: Producer | undefined;
  let foreignTopic: string | undefined;

  beforeAll(async () => {
    brokerReady = await waitForBroker();
    if (!brokerReady) {
      console.warn(`[integration] ${skipMessage}`);
      return;
    }
    admin = client.admin();
    producer = client.producer();
    await admin.connect();
    await producer.connect();
  });

  afterAll(async () => {
    await cleanup();
    if (foreignTopic !== undefined && admin !== undefined) {
      try {
        await admin.deleteTopics({ topics: [foreignTopic] });
      } catch {
        // Топик мог быть удалён вручную при диагностике падения теста.
      }
    }
    await Promise.allSettled([
      producer?.disconnect() ?? Promise.resolve(),
      admin?.disconnect() ?? Promise.resolve(),
    ]);
  });

  it('generates different names for repeated calls', ({ skip }) => {
    if (!brokerReady) {
      skip(skipMessage);
      return;
    }
    expect(createUniqueTopicName('harness-name')).not.toBe(createUniqueTopicName('harness-name'));
  });

  it('creates and deletes its own topic', async ({ skip }) => {
    if (!brokerReady || admin === undefined) {
      skip(skipMessage);
      return;
    }
    const topic = createUniqueTopicName('harness-owned');
    await createTopic(topic);
    expect(await admin.listTopics()).toContain(topic);
    await deleteTopics([topic]);
    expect(await admin.listTopics()).not.toContain(topic);
  }, 15_000);

  it('does not delete a topic created outside the harness', async ({ skip }) => {
    if (!brokerReady || admin === undefined) {
      skip(skipMessage);
      return;
    }
    foreignTopic = `harness-foreign-${randomUUID()}`;
    await admin.createTopics({ topics: [{ topic: foreignTopic, numPartitions: 1 }] });
    await cleanup();
    expect(await admin.listTopics()).toContain(foreignTopic);
  }, 15_000);

  it('reads published bytes with an independent native consumer', async ({ skip }) => {
    if (!brokerReady || producer === undefined) {
      skip(skipMessage);
      return;
    }
    const topic = createUniqueTopicName('harness-bytes');
    await createTopic(topic);
    const key = Buffer.from([0, 255, 1]);
    const value = Buffer.from([255, 0, 127, 42]);
    await producer.send({
      topic,
      messages: [{ key, value, headers: { 'x-test': Buffer.from([3, 4, 5]) } }],
    });

    const [message] = await readRawMessages(topic, 1, 5_000);
    expect(message?.key).toEqual(key);
    expect(message?.value).toEqual(value);
    expect(message?.headers).toEqual([{ name: 'x-test', value: Buffer.from([3, 4, 5]) }]);
  }, 15_000);
});
