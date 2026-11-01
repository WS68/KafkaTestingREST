import { Kafka } from 'kafkajs';
import { getBrokerAddress } from './env.js';

const readinessClientId = 'kafka-testing-rest-integration-readiness';

/** Проверяет только доступность уже запущенного брокера через нативный протокол Kafka. */
export async function waitForBroker(timeoutMs = 5_000): Promise<boolean> {
  const admin = new Kafka({
    clientId: readinessClientId,
    brokers: [getBrokerAddress()],
  }).admin();
  let timeout: NodeJS.Timeout | undefined;

  const readiness = (async (): Promise<boolean> => {
    try {
      await admin.connect();
      await admin.listTopics();
      return true;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      console.warn(`[integration] Kafka broker readiness check failed: ${reason}`);
      return false;
    }
  })();

  try {
    const deadline = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });

    return await Promise.race([readiness, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    try {
      await admin.disconnect();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      console.warn(`[integration] Kafka readiness client close failed: ${reason}`);
    }
  }
}
