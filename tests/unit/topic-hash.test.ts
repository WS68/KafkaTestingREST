import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import type { LogFields, LogLevel, Logger } from '../../src/application/ports/logger.js';
import {
  createGroupNameProvider,
  topicHash,
} from '../../src/infrastructure/consumers/group-name.js';

const topics = [
  '',
  'a',
  'A',
  'orders.results',
  'orders.results ',
  'ORDER.RESULTS',
  'очень.длинное.имя.топика.тест',
  'x'.repeat(1000),
];

function independentlyCalculatedHash(topic: string): string {
  const bytes = createHash('md5').update(topic, 'utf8').digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  return value.toString(10);
}

test('uses the independently verified empty-topic control value', () => {
  expect(topicHash('')).toBe('15284527576400310788');
  expect(topicHash('')).toBe(independentlyCalculatedHash(''));
});

test('matches an independent UTF-8 MD5 and 64-bit calculation', () => {
  for (const topic of topics) {
    expect(topicHash(topic)).toBe(independentlyCalculatedHash(topic));
  }
});

test('preserves case, spaces, and the unsigned 64-bit decimal format', () => {
  expect(topicHash('orders.results')).not.toBe(topicHash('ORDER.RESULTS'));
  expect(topicHash('topic')).not.toBe(topicHash('topic '));
  expect(topicHash('topic')).not.toBe(topicHash(' topic'));

  for (const topic of topics) {
    const result = topicHash(topic);
    expect(result).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(result).toHaveLength(Math.min(result.length, 20));
    expect(result.length).toBeLessThanOrEqual(20);
    expect(BigInt(result)).toBeLessThanOrEqual(2n ** 64n - 1n);
    expect(result === '0' || !result.startsWith('0')).toBe(true);
  }
});

type LogCall = {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields?: LogFields;
};

function createLoggerSpy(): { readonly logger: Logger; readonly calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record = (level: LogLevel, event: string, fields?: LogFields): void => {
    calls.push(fields === undefined ? { level, event } : { level, event, fields });
  };
  return {
    logger: {
      log: record,
      debug: record.bind(undefined, 'debug'),
      info: record.bind(undefined, 'info'),
      warn: record.bind(undefined, 'warn'),
      error: record.bind(undefined, 'error'),
    },
    calls,
  };
}

test('formats and caches group names within a run', () => {
  const { logger, calls } = createLoggerSpy();
  let hashCalls = 0;
  const provider = createGroupNameProvider({
    prefix: 'testing-REST-API',
    runId: 'run-1',
    logger,
    hash: (topic) => {
      hashCalls += 1;
      return topicHash(topic);
    },
  });

  const first = provider.getGroupId('orders.results');
  const second = provider.getGroupId('orders.results');
  const hashSeparator = first.lastIndexOf('-');
  const prefixAndRunId = first.slice(0, hashSeparator);

  expect(second).toBe(first);
  expect(prefixAndRunId.startsWith('testing-REST-API-')).toBe(true);
  expect(prefixAndRunId.slice('testing-REST-API-'.length)).toBe('run-1');
  expect(first.slice(hashSeparator + 1)).toBe(topicHash('orders.results'));
  expect(hashCalls).toBe(1);
  expect(calls.filter((call) => call.event === 'consumer-group-name-collision')).toHaveLength(0);
});

test('changes the group name between runs but keeps the topic hash', () => {
  const firstLogger = createLoggerSpy();
  const secondLogger = createLoggerSpy();
  const firstProvider = createGroupNameProvider({
    prefix: 'testing-REST-API',
    runId: 'run-1',
    logger: firstLogger.logger,
  });
  const secondProvider = createGroupNameProvider({
    prefix: 'testing-REST-API',
    runId: 'run-2',
    logger: secondLogger.logger,
  });

  const first = firstProvider.getGroupId('orders.results');
  const second = secondProvider.getGroupId('orders.results');

  expect(first).not.toBe(second);
  expect(first.slice(first.lastIndexOf('-') + 1)).toBe(topicHash('orders.results'));
  expect(second.slice(second.lastIndexOf('-') + 1)).toBe(topicHash('orders.results'));
  expect(firstProvider.getGroupId('payments.results')).not.toBe(first);
});

test('records one collision for different topics with an injected hash', () => {
  const { logger, calls } = createLoggerSpy();
  const provider = createGroupNameProvider({
    prefix: 'testing-REST-API',
    runId: 'run-1',
    logger,
    hash: () => '42',
  });

  const first = provider.getGroupId('orders.results');
  const repeated = provider.getGroupId('orders.results');
  const second = provider.getGroupId('payments.results');
  const collisions = calls.filter((call) => call.event === 'consumer-group-name-collision');

  expect(repeated).toBe(first);
  expect(second).toBe(first);
  expect(collisions).toHaveLength(1);
  expect(collisions[0]?.fields).toEqual({
    topicHash: '42',
    firstTopic: 'orders.results',
    secondTopic: 'payments.results',
  });
});
