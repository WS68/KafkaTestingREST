import { expect, test } from 'vitest';
import { createConsumerManager } from '../../src/application/consumers/consumer-manager.js';
import type { ReadyConsumer } from '../../src/application/ports/kafka-consumer.js';
import type { LogFields, Logger } from '../../src/application/ports/logger.js';
import type { SourceRecord } from '../../src/domain/record.js';
import { ManualClock } from '../support/manual-clock.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface Creation {
  readonly topic: string;
  readonly groupId: string;
  readonly result: Deferred<ReadyConsumer>;
}

function createControlledFactory(): {
  readonly factory: {
    create(
      topic: string,
      groupId: string,
      onRecord: (record: SourceRecord) => Promise<void>,
    ): Promise<ReadyConsumer>;
  };
  readonly calls: Creation[];
  resolve(topic: string): ReadyConsumer;
  reject(topic: string, error: unknown): void;
} {
  const calls: Creation[] = [];
  return {
    calls,
    factory: {
      create(topic, groupId, _onRecord): Promise<ReadyConsumer> {
        const result = deferred<ReadyConsumer>();
        calls.push({ topic, groupId, result });
        return result.promise;
      },
    },
    resolve(topic): ReadyConsumer {
      const call = calls.find((item) => item.topic === topic);
      if (call === undefined) throw new Error(`No creation for ${topic}`);
      const readyConsumer: ReadyConsumer = { close: async () => undefined };
      call.result.resolve(readyConsumer);
      return readyConsumer;
    },
    reject(topic, error): void {
      const call = calls.find((item) => item.topic === topic);
      if (call === undefined) throw new Error(`No creation for ${topic}`);
      call.result.reject(error);
    },
  };
}

function loggerSpy(): { readonly logger: Logger; readonly events: string[] } {
  const events: string[] = [];
  const record = (
    _level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    _fields?: LogFields,
  ) => {
    events.push(event);
  };
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

function setup(initialTime = 0) {
  const factory = createControlledFactory();
  const clock = new ManualClock(initialTime);
  const logger = loggerSpy();
  const groupIds: string[] = [];
  const deletedGroups: string[] = [];
  const manager = createConsumerManager({
    factory: factory.factory,
    clock,
    getIdleSeconds: () => 100,
    getGroupId: (topic) => {
      const groupId = `group-${topic}`;
      groupIds.push(groupId);
      return groupId;
    },
    onRecord: async () => undefined,
    logger: logger.logger,
    groupAdmin: {
      async deleteGroup(groupId) {
        deletedGroups.push(groupId);
        return { kind: 'deleted' };
      },
    },
  });
  return { manager, ...factory, clock, logger, groupIds, deletedGroups };
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

test('joins two concurrent openings of one topic to one creation and one handle', async () => {
  const state = setup();
  const first = state.manager.reserve('t', 10);
  const second = state.manager.reserve('t', 10);
  const firstReady = state.manager.ensureReady(first);
  const secondReady = state.manager.ensureReady(second);

  expect(state.calls).toHaveLength(1);
  const readyConsumer = state.resolve('t');
  const [firstHandle, secondHandle] = await Promise.all([firstReady, secondReady]);

  expect(firstHandle.generation).toBe(secondHandle.generation);
  expect(firstHandle.readyConsumer).toBe(readyConsumer);
  expect(secondHandle.readyConsumer).toBe(readyConsumer);
  expect(firstHandle).toBe(secondHandle);
});

test('extends expiration by the greatest candidate and uses effective slot duration', async () => {
  const state = setup(1_000);
  const reservation = state.manager.reserve('t', 10);
  const ready = state.manager.ensureReady(reservation);
  expect(state.manager.getExpiresAt('t')).toBe(1_000 + 100_000 + 10_000);
  state.resolve('t');
  await ready;

  state.manager.extend('t', 5);
  const afterFive = state.manager.getExpiresAt('t');
  state.manager.extend('t', 50);
  const afterFifty = state.manager.getExpiresAt('t');
  state.manager.extend('t', 1);

  expect(afterFive).toBe(1_000 + 100_000 + 10_000);
  expect(afterFifty).toBeGreaterThan(afterFive!);
  expect(state.manager.getExpiresAt('t')).toBe(afterFifty);
});

test('a shorter subsequent opening does not reduce expiration when time is unchanged', async () => {
  const state = setup(2_000);
  const first = state.manager.reserve('t', 60);
  const firstReady = state.manager.ensureReady(first);
  const expiration = state.manager.getExpiresAt('t');
  const second = state.manager.reserve('t', 1);
  const secondReady = state.manager.ensureReady(second);

  expect(state.manager.getExpiresAt('t')).toBe(expiration);
  expect(state.clock.now()).toBe(2_000);
  state.resolve('t');
  await Promise.all([firstReady, secondReady]);
});

test('rolls back failed creation after cleanup without deleting the group', async () => {
  const state = setup();
  const first = state.manager.reserve('t', 10);
  const second = state.manager.reserve('t', 20);
  const firstReady = state.manager.ensureReady(first);
  const secondReady = state.manager.ensureReady(second);
  const failure = new Error('create failed');

  expect(state.calls).toHaveLength(1);
  state.reject('t', failure);
  const [firstResult, secondResult] = await Promise.allSettled([firstReady, secondReady]);
  await settle();

  expect(firstResult.status).toBe('rejected');
  expect(secondResult.status).toBe('rejected');
  if (firstResult.status === 'rejected' && secondResult.status === 'rejected') {
    expect(firstResult.reason).toBe(failure);
    expect(secondResult.reason).toBe(failure);
  }
  expect(state.manager.getState('t')).toBe('absent');
  expect(state.manager.hasActiveReservations('t')).toBe(false);
  expect(state.deletedGroups).toEqual([]);
});

test('releasing a reservation twice is idempotent and invalidates its readiness request', async () => {
  const state = setup();
  const first = state.manager.reserve('t', 10);
  const second = state.manager.reserve('t', 10);
  state.manager.release(first);
  state.manager.release(first);
  expect(state.manager.hasActiveReservations('t')).toBe(true);

  state.manager.release(second);
  state.manager.release(second);
  expect(state.manager.hasActiveReservations('t')).toBe(false);
  await expect(state.manager.ensureReady(first)).rejects.toThrow('уже освобождено');
});

test('topics initialize independently and a failure on one does not affect the other', async () => {
  const state = setup();
  const first = state.manager.reserve('t1', 10);
  const second = state.manager.reserve('t2', 10);
  const firstReady = state.manager.ensureReady(first);
  const secondReady = state.manager.ensureReady(second);

  expect(state.calls).toHaveLength(2);
  expect(state.calls.map(({ topic, groupId }) => ({ topic, groupId }))).toEqual([
    { topic: 't1', groupId: 'group-t1' },
    { topic: 't2', groupId: 'group-t2' },
  ]);
  const secondConsumer = state.resolve('t2');
  await expect(secondReady).resolves.toMatchObject({ readyConsumer: secondConsumer });
  expect(state.manager.getState('t1')).toBe('creating');

  state.reject('t1', new Error('t1 failed'));
  await expect(firstReady).rejects.toThrow('t1 failed');
  await settle();
  expect(state.manager.getState('t1')).toBe('absent');
  expect(state.manager.getState('t2')).toBe('ready');
  expect(state.manager.hasActiveReservations('t2')).toBe(true);
});

test('computes the group id at each creation and reuses the same id after close', async () => {
  const state = setup();
  const first = state.manager.reserve('t', 10);
  const firstReady = state.manager.ensureReady(first);
  state.resolve('t');
  await firstReady;
  await state.manager.close('t', 'test');

  const second = state.manager.reserve('t', 10);
  const secondReady = state.manager.ensureReady(second);
  expect(state.calls).toHaveLength(2);
  expect(state.groupIds).toEqual(['group-t', 'group-t', 'group-t']);
  expect(state.calls.map((call) => call.groupId)).toEqual(['group-t', 'group-t']);
  const secondConsumer: ReadyConsumer = { close: async () => undefined };
  state.calls[1]!.result.resolve(secondConsumer);
  await secondReady;
});
