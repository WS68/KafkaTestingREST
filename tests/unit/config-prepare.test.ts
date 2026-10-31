import { expect, test } from 'vitest';
import {
  createTopicMatcher,
  loadConfig,
  prepareConfig,
  type AppConfig,
} from '../../src/infrastructure/config/index.js';

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  cluster: 'localhost:9092',
  httpHost: '127.0.0.1',
  httpPort: 3000,
  publisherTopics: ['^orders\\.'],
  autoDeleteSlotsSeconds: 60,
  consumerIdleSeconds: 3600,
  consumerGroupPrefix: 'testing-REST-API',
  defaultWaitSeconds: 60,
  ...overrides,
});

test('prepares a valid configuration and converts seconds to milliseconds', () => {
  const result = prepareConfig(config());

  expect(result.kind).toBe('ok');
  if (result.kind === 'ok') {
    expect(result.config.cluster).toEqual({ host: 'localhost', port: 9092 });
    expect(result.config.publisherTopics[0]).toBeInstanceOf(RegExp);
    expect(result.config.autoDeleteSlotsMs).toBe(60_000);
    expect(result.config.consumerIdleMs).toBe(3_600_000);
    expect(result.config.defaultWaitMs).toBe(60_000);
  }
});

test.each([
  ['kafka:0', 'invalid-cluster'],
  ['kafka:65536', 'invalid-cluster'],
  ['kafka', 'invalid-cluster'],
  ['kafka://h:9092', 'invalid-cluster'],
  ['h:9092/path', 'invalid-cluster'],
  ['u@h:9092', 'invalid-cluster'],
  ['a:1,b:2', 'invalid-cluster'],
  [' h:9092', 'invalid-cluster'],
  ['h :9092', 'invalid-cluster'],
] as const)('rejects cluster %s', (cluster, reason) => {
  const result = prepareConfig(config({ cluster }));

  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.issues).toContainEqual({ field: 'cluster', reason });
});

test.each([0, 65_536, 1.5, Number.NaN])('rejects HTTP port %s as out of range', (httpPort) => {
  const result = prepareConfig(config({ httpPort }));

  expect(result.kind).toBe('error');
  if (result.kind === 'error')
    expect(result.issues).toContainEqual({ field: 'httpPort', reason: 'out-of-range' });
});

test.each([
  ['', 'empty'],
  [' 127.0.0.1', 'invalid-host'],
] as const)('rejects HTTP host %j', (httpHost, reason) => {
  const result = prepareConfig(config({ httpHost }));

  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.issues).toContainEqual({ field: 'httpHost', reason });
});

test.each([
  ['', 'empty'],
  ['bad prefix', 'invalid-prefix'],
  ['bad*prefix', 'invalid-prefix'],
] as const)('rejects consumer group prefix %j', (consumerGroupPrefix, reason) => {
  const result = prepareConfig(config({ consumerGroupPrefix }));

  expect(result.kind).toBe('error');
  if (result.kind === 'error')
    expect(result.issues).toContainEqual({ field: 'consumerGroupPrefix', reason });
});

test.each(['testing-REST-API', 'a.b_c-d'])(
  'accepts consumer group prefix %s',
  (consumerGroupPrefix) => {
    expect(prepareConfig(config({ consumerGroupPrefix })).kind).toBe('ok');
  },
);

test.each([
  ['autoDeleteSlotsSeconds', 0],
  ['autoDeleteSlotsSeconds', 2_147_483_648],
  ['defaultWaitSeconds', 0],
  ['defaultWaitSeconds', 2_147_483_648],
  ['consumerIdleSeconds', 2_147_483_648],
] as const)('rejects %s=%s as out of range', (field, value) => {
  const result = prepareConfig(config({ [field]: value }));

  expect(result.kind).toBe('error');
  if (result.kind === 'error')
    expect(result.issues).toContainEqual({ field, reason: 'out-of-range' });
});

test('allows zero consumer idle time and preserves it after conversion', () => {
  const result = prepareConfig(config({ consumerIdleSeconds: 0 }));

  expect(result.kind).toBe('ok');
  if (result.kind === 'ok') expect(result.config.consumerIdleMs).toBe(0);
});

test('converts the largest valid seconds value to safe milliseconds', () => {
  const result = prepareConfig(
    config({
      autoDeleteSlotsSeconds: 2_147_483_647,
      consumerIdleSeconds: 2_147_483_647,
      defaultWaitSeconds: 2_147_483_647,
    }),
  );

  expect(result.kind).toBe('ok');
  if (result.kind === 'ok') {
    expect(result.config.autoDeleteSlotsMs).toBe(2_147_483_647_000);
    expect(result.config.autoDeleteSlotsMs).toBe(2_147_483_647_000);
    expect(Number.isSafeInteger(result.config.autoDeleteSlotsMs)).toBe(true);
  }
});

test.each([['[', 'invalid-regex']] as const)(
  'rejects publisher expression %s',
  (expression, reason) => {
    const result = prepareConfig(config({ publisherTopics: [expression] }));

    expect(result.kind).toBe('error');
    if (result.kind === 'error')
      expect(result.issues).toContainEqual({ field: 'publisherTopics', reason });
  },
);

test('prepares valid publisher expressions as regular expressions', () => {
  const result = prepareConfig(config({ publisherTopics: ['^orders\\.'] }));

  expect(result.kind).toBe('ok');
  if (result.kind === 'ok') expect(result.config.publisherTopics[0]).toBeInstanceOf(RegExp);
});

test.each([
  [[], '', true],
  [[], 'arbitrary-topic', true],
  [[/^orders\./], 'orders.results', true],
  [[/^orders\./], 'xorders.results', false],
  [[/^orders\./], 'ordersXresults', false],
  [[/results/], 'results', true],
  [[/results/], 'my-results-x', false],
  [[/^results$/], 'results', true],
  [[/^orders\./, /^payments\./], 'payments.events', true],
  [[/^orders\./, /^payments\./], 'invoices.events', false],
] as const)(
  'matches complete topic names according to the configured patterns',
  (patterns, topic, expected) => {
    expect(createTopicMatcher(patterns)(topic)).toBe(expected);
  },
);

test('resets a global expression lastIndex between matcher calls', () => {
  const matcher = createTopicMatcher([/orders/g]);

  expect(matcher('orders')).toBe(true);
  expect(matcher('orders')).toBe(true);
});

test('does not check network availability while loading or preparing configuration', () => {
  const loaded = loadConfig({ KAFKA_TESTING_REST_CLUSTER: 'unreachable-host:9092' });

  expect(loaded.kind).toBe('ok');
  if (loaded.kind !== 'ok') return;

  const result = prepareConfig(loaded.config);
  expect(result.kind).toBe('ok');
  if (result.kind === 'ok')
    expect(result.config.cluster).toEqual({ host: 'unreachable-host', port: 9092 });
});
