export function getBrokerAddress(): string {
  return process.env['KAFKA_TESTING_REST_CLUSTER'] ?? 'localhost:9092';
}

/** Адрес по умолчанию задан, поэтому отдельная настройка не обязательна. */
export function isBrokerConfigured(): boolean {
  return true;
}
