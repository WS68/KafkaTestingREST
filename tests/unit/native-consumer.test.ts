import { expect, test } from 'vitest';
import type { LogFields, Logger } from '../../src/application/ports/index.js';
import type { SourceRecord } from '../../src/domain/record.js';
import { createNativeConsumerFactory } from '../../src/infrastructure/kafka/native-consumer.js';
import {
  createFakeAdmin,
  createFakeAdminClient,
  createFakeConsumer,
} from '../support/fake-consumer.js';

function loggerSpy(): {
  readonly logger: Logger;
  readonly events: { event: string; fields: LogFields | undefined }[];
} {
  const events: { event: string; fields: LogFields | undefined }[] = [];
  const record = (_level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: LogFields) =>
    events.push({ event, fields });
  return {
    events,
    logger: {
      log: record,
      debug: (event, fields) => record('debug', event, fields),
      info: (event, fields) => record('info', event, fields),
      warn: (event, fields) => record('warn', event, fields),
      error: (event, fields) => record('error', event, fields),
    },
  };
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

function setup() {
  const consumer = createFakeConsumer();
  const admin = createFakeAdmin();
  const logger = loggerSpy();
  const factory = createNativeConsumerFactory({
    createConsumer: () => consumer,
    createAdmin: () => admin,
    logger: logger.logger,
  });
  return { consumer, admin, logger, factory };
}

async function readyConsumer(onRecord: (record: SourceRecord) => Promise<void>) {
  const state = setup();
  state.admin.setOffsets([
    { partition: 0, offset: '10' },
    { partition: 1, offset: '20' },
  ]);
  const creating = state.factory.create('topic', 'group', onRecord);
  await settle();
  state.consumer.emitGroupJoin({ topic: [0, 1] });
  const ready = await creating;
  return { ...state, ready };
}

test('initializes in order and resolves only after GROUP_JOIN seeks every assigned partition', async () => {
  const { consumer, admin, factory } = setup();
  admin.setOffsets([
    { partition: 0, offset: '10' },
    { partition: 1, offset: '20' },
  ]);
  const creating = factory.create('topic', 'group', async () => undefined);
  await settle();
  expect(consumer.calls.map((call) => call.kind)).toEqual(['connect', 'subscribe', 'run']);
  expect(consumer.subscribeArguments).toEqual([{ topic: 'topic', fromBeginning: false }]);
  let resolved = false;
  void creating.then(() => {
    resolved = true;
  });
  await settle();
  expect(resolved).toBe(false);
  consumer.emitGroupJoin({ topic: [0, 1] });
  await creating;
  expect(consumer.calls.map((call) => call.kind)).toEqual([
    'connect',
    'subscribe',
    'run',
    'seek',
    'seek',
  ]);
  expect(admin.calls[0]).toEqual({ kind: 'fetchTopicOffsets', topic: 'topic' });
  expect(consumer.seekCalls).toEqual([
    { topic: 'topic', partition: 0, offset: '10' },
    { topic: 'topic', partition: 1, offset: '20' },
  ]);
});

test('repeats offset lookup and seek after rebalance without resolving readiness twice', async () => {
  const state = await readyConsumer(async () => undefined);
  const firstReady = state.ready;
  state.consumer.emitGroupJoin({ topic: [1] });
  await settle();
  expect(state.admin.fetchCalls).toBe(2);
  expect(state.consumer.seekCalls).toEqual([
    { topic: 'topic', partition: 0, offset: '10' },
    { topic: 'topic', partition: 1, offset: '20' },
    { topic: 'topic', partition: 1, offset: '20' },
  ]);
  expect(state.ready).toBe(firstReady);
  await state.ready.close();
});

test('uses explicit latest offsets on reopening even when fromBeginning is false', async () => {
  const state = setup();
  state.admin.setOffsets([{ partition: 0, offset: '42' }]);
  const creating = state.factory.create('topic', 'group', async () => undefined);
  await settle();
  state.consumer.emitGroupJoin({ topic: [0] });
  await creating;
  expect(state.consumer.subscribeArguments[0]?.fromBeginning).toBe(false);
  // Без seek одного параметра fromBeginning недостаточно: сохранённое смещение прочиталось бы снова.
  expect(state.consumer.seekCalls).toEqual([{ topic: 'topic', partition: 0, offset: '42' }]);
  await creating.then((ready) => ready.close());
});

test('normalizes duplicate and absent headers and preserves source bytes', async () => {
  let received: SourceRecord | undefined;
  const state = await readyConsumer(async (record) => {
    received = record;
  });
  await state.consumer.emitMessage({
    key: null,
    value: Buffer.from('{}'),
    headers: { a: Buffer.from('1'), b: [Buffer.from('2'), Buffer.from('3')], c: undefined },
  });
  expect(received?.key).toBeUndefined();
  expect(received?.value).toEqual(Buffer.from('{}'));
  expect(received?.headers).toEqual([
    { name: Uint8Array.from([97]), value: Buffer.from('1') },
    { name: Uint8Array.from([98]), value: Buffer.from('2') },
    { name: Uint8Array.from([98]), value: Buffer.from('3') },
    { name: Uint8Array.from([99]), value: undefined },
  ]);
  await state.ready.close();
});

test('distinguishes absent data from existing empty key and value', async () => {
  const received: SourceRecord[] = [];
  const state = await readyConsumer(async (record) => {
    received.push(record);
  });
  await state.consumer.emitMessage({ key: null, value: null });
  await state.consumer.emitMessage({ key: Buffer.alloc(0), value: Buffer.alloc(0) });
  expect(received[0]).toMatchObject({ key: undefined, value: undefined });
  expect(received[1]).toMatchObject({ key: Buffer.alloc(0), value: Buffer.alloc(0) });
  await state.ready.close();
});

test('logs handler failures and continues with the next record', async () => {
  let calls = 0;
  const state = await readyConsumer(async () => {
    calls += 1;
    if (calls === 1) throw new Error('handler');
  });
  await state.consumer.emitMessage({ value: Buffer.from('one') });
  await state.consumer.emitMessage({ value: Buffer.from('two') });
  expect(calls).toBe(2);
  expect(state.logger.events).toContainEqual({
    event: 'kafka-record-handler-failed',
    fields: { topic: 'topic', reason: 'handler-failed' },
  });
  await state.ready.close();
});

test('close waits for the active handler, disconnects once, and ignores later messages', async () => {
  let calls = 0;
  let resolveHandler!: () => void;
  const handlerDone = new Promise<void>((resolve) => {
    resolveHandler = resolve;
  });
  const state = await readyConsumer(async () => {
    calls += 1;
    await handlerDone;
  });
  const message = state.consumer.emitMessage({ value: Buffer.from('pending') });
  await settle();
  const closing = state.ready.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await settle();
  expect(closed).toBe(false);
  resolveHandler();
  await message;
  await closing;
  expect(state.consumer.disconnectCalls).toBe(1);
  expect(state.admin.disconnectCalls).toBe(1);
  expect(state.ready.close()).toBe(closing);
  await state.consumer.emitMessage({ value: Buffer.from('ignored') });
  expect(calls).toBe(1);
});

type FailureStage = 'connect' | 'subscribe' | 'fetch' | 'seek';
async function assertInitializationFailure(
  stage: FailureStage,
  error: unknown,
  reason: 'client' | 'broker',
): Promise<void> {
  const state = setup();
  if (stage === 'connect') state.consumer.setConnectFailure(error);
  if (stage === 'subscribe') state.consumer.setSubscribeFailure(error);
  if (stage === 'fetch') state.admin.setFetchFailure(error);
  if (stage === 'seek') {
    state.consumer.setSeekFailure(error);
    state.admin.setOffsets([{ partition: 0, offset: '0' }]);
  }
  const unusedGroupAdmin = createFakeAdminClient();
  const creating = state.factory.create('topic', 'group', async () => undefined);
  if (stage === 'seek') {
    await settle();
    state.consumer.emitGroupJoin({ topic: [0] });
  }
  await expect(creating).rejects.toEqual({ reason });
  expect(state.consumer.disconnectCalls).toBe(1);
  expect(state.admin.disconnectCalls).toBe(1);
  expect(unusedGroupAdmin.deleteGroupsCalls).toBe(0);
}

test('releases both clients on connect failure without deleting the group', async () => {
  await assertInitializationFailure('connect', { code: 'ECONNREFUSED' }, 'broker');
});

test('releases both clients on subscribe failure without deleting the group', async () => {
  await assertInitializationFailure('subscribe', { code: 'ERR_INVALID_ARG_TYPE' }, 'client');
});

test('releases both clients on offset lookup failure without deleting the group', async () => {
  await assertInitializationFailure('fetch', { code: 'ECONNRESET' }, 'broker');
});

test('releases both clients on seek failure without deleting the group', async () => {
  await assertInitializationFailure('seek', { code: 'ERR_INVALID_ARG_TYPE' }, 'client');
});
