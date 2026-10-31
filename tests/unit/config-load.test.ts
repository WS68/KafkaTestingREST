import { expect, test } from 'vitest';
import { loadConfig } from '../../src/infrastructure/config/index.js';

const clusterEnv = { KAFKA_TESTING_REST_CLUSTER: 'localhost:9092' };

test.each([
  ['cluster', 'KAFKA_TESTING_REST_CLUSTER', 'localhost:9092'],
  ['httpHost', 'KAFKA_TESTING_REST_HTTP_HOST', '0.0.0.0'],
  ['httpPort', 'KAFKA_TESTING_REST_HTTP_PORT', '8080'],
  ['publisherTopics', 'KAFKA_TESTING_REST_PUBLISHER_TOPICS', '["^orders\\\\.", "payments"]'],
  ['autoDeleteSlotsSeconds', 'KAFKA_TESTING_REST_AUTO_DELETE_SLOTS_SECONDS', '1'],
  ['consumerIdleSeconds', 'KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS', '0'],
  ['consumerGroupPrefix', 'KAFKA_TESTING_REST_CONSUMER_GROUP_PREFIX', 'custom_prefix'],
  ['defaultWaitSeconds', 'KAFKA_TESTING_REST_DEFAULT_WAIT_SECONDS', '2'],
] as const)('uses an explicit %s value instead of its default', (field, envName, value) => {
  const result = loadConfig({ ...clusterEnv, [envName]: value });

  expect(result.kind).toBe('ok');
  if (result.kind === 'ok') {
    const expected: string | number | readonly string[] =
      field === 'publisherTopics'
        ? ['^orders\\.', 'payments']
        : field === 'httpPort' || field.endsWith('Seconds')
          ? Number(value)
          : value;
    expect(result.config[field]).toEqual(expected);
  }
});

test.each([
  ['httpHost', 'httpHost', '127.0.0.1'],
  ['httpPort', 'httpPort', 3000],
  ['publisherTopics', 'publisherTopics', []],
  ['autoDeleteSlotsSeconds', 'autoDeleteSlotsSeconds', 60],
  ['consumerIdleSeconds', 'consumerIdleSeconds', 3600],
  ['consumerGroupPrefix', 'consumerGroupPrefix', 'testing-REST-API'],
  ['defaultWaitSeconds', 'defaultWaitSeconds', 60],
] as const)('uses the default when %s is absent', (_label, field, expected) => {
  const result = loadConfig(clusterEnv);

  expect(result.kind).toBe('ok');
  if (result.kind === 'ok') expect(result.config[field]).toEqual(expected);
});

test('reports a missing cluster instead of applying a default', () => {
  expect(loadConfig({})).toEqual({
    kind: 'error',
    issues: [{ field: 'cluster', reason: 'missing' }],
  });
});

test.each([
  ['KAFKA_TESTING_REST_CLUSTER', 'cluster'],
  ['KAFKA_TESTING_REST_HTTP_HOST', 'httpHost'],
  ['KAFKA_TESTING_REST_HTTP_PORT', 'httpPort'],
  ['KAFKA_TESTING_REST_PUBLISHER_TOPICS', 'publisherTopics'],
  ['KAFKA_TESTING_REST_AUTO_DELETE_SLOTS_SECONDS', 'autoDeleteSlotsSeconds'],
  ['KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS', 'consumerIdleSeconds'],
  ['KAFKA_TESTING_REST_CONSUMER_GROUP_PREFIX', 'consumerGroupPrefix'],
  ['KAFKA_TESTING_REST_DEFAULT_WAIT_SECONDS', 'defaultWaitSeconds'],
] as const)('reports an empty %s value rather than using a default', (envName, field) => {
  const result = loadConfig({ ...clusterEnv, [envName]: '' });

  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.issues).toContainEqual({ field, reason: 'empty' });
});

const invalidNumberValues = ['+1', ' 1', '1 ', '1.0', '1e3', '1,000', '-1', '01', 'abc'];
const numericVariables = [
  ['KAFKA_TESTING_REST_HTTP_PORT', 'httpPort'],
  ['KAFKA_TESTING_REST_AUTO_DELETE_SLOTS_SECONDS', 'autoDeleteSlotsSeconds'],
  ['KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS', 'consumerIdleSeconds'],
  ['KAFKA_TESTING_REST_DEFAULT_WAIT_SECONDS', 'defaultWaitSeconds'],
] as const;
const invalidNumberCases = numericVariables.flatMap(([envName, field]) =>
  invalidNumberValues.map((value) => [envName, field, value] as const),
);

test.each(invalidNumberCases)('rejects %s=%s as an invalid number', (envName, field, value) => {
  const result = loadConfig({ ...clusterEnv, [envName]: value });

  expect(result.kind).toBe('error');
  if (result.kind === 'error')
    expect(result.issues).toContainEqual({ field, reason: 'invalid-number' });
});

test('preserves an explicitly configured zero idle time', () => {
  const result = loadConfig({
    ...clusterEnv,
    KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS: '0',
  });

  expect(result).toEqual({
    kind: 'ok',
    config: expect.objectContaining({ consumerIdleSeconds: 0 }),
  });
});

test('parses publisher topics in order and rejects non-string JSON arrays', () => {
  expect(
    loadConfig({
      ...clusterEnv,
      KAFKA_TESTING_REST_PUBLISHER_TOPICS: '[]',
    }),
  ).toEqual({ kind: 'ok', config: expect.objectContaining({ publisherTopics: [] }) });
  expect(
    loadConfig({
      ...clusterEnv,
      KAFKA_TESTING_REST_PUBLISHER_TOPICS: '["^a\\\\.", "b"]',
    }),
  ).toEqual({
    kind: 'ok',
    config: expect.objectContaining({ publisherTopics: ['^a\\.', 'b'] }),
  });

  for (const value of ['{}', '["a", 1]', 'not-json']) {
    const result = loadConfig({ ...clusterEnv, KAFKA_TESTING_REST_PUBLISHER_TOPICS: value });
    expect(result).toEqual({
      kind: 'error',
      issues: [{ field: 'publisherTopics', reason: 'invalid-json' }],
    });
  }
});

test('reports all errors found in one environment object', () => {
  const result = loadConfig({
    KAFKA_TESTING_REST_CLUSTER: '',
    KAFKA_TESTING_REST_HTTP_PORT: 'abc',
  });

  expect(result.kind).toBe('error');
  if (result.kind === 'error') {
    expect(result.issues).toContainEqual({ field: 'cluster', reason: 'empty' });
    expect(result.issues).toContainEqual({ field: 'httpPort', reason: 'invalid-number' });
  }
});
