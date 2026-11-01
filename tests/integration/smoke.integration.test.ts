import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kafka, type Admin } from 'kafkajs';
import { getBrokerAddress } from './env.js';
import { waitForBroker } from './readiness.js';

const skipMessage =
  'Integration smoke test skipped: Kafka broker is unavailable at the configured address.';

describe('Kafka integration smoke test', () => {
  let brokerReady = false;
  let admin: Admin | undefined;

  beforeAll(async () => {
    brokerReady = await waitForBroker();
    if (!brokerReady) {
      console.warn(`[integration] ${skipMessage}`);
      return;
    }

    admin = new Kafka({
      clientId: 'kafka-testing-rest-integration-smoke',
      brokers: [getBrokerAddress()],
    }).admin();
    await admin.connect();
  });

  afterAll(async () => {
    if (admin !== undefined) {
      await admin.disconnect();
    }
  });

  it('lists topics through the native Kafka client', async ({ skip }) => {
    if (!brokerReady || admin === undefined) {
      skip(skipMessage);
      return;
    }

    const topics = await admin.listTopics();

    expect(Array.isArray(topics)).toBe(true);
  });
});
