import { expect, test } from 'vitest';
import { createConsumerManager } from '../../src/application/consumers/consumer-manager.js';
import type {
  GroupDeletionResult,
  KafkaConsumerFactory,
  KafkaGroupAdmin,
  ReadyConsumer,
} from '../../src/application/ports/kafka-consumer.js';
import type { LogFields, LogLevel, Logger } from '../../src/application/ports/logger.js';
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

interface FactoryCall {
  readonly topic: string;
  readonly groupId: string;
  readonly result: Deferred<ReadyConsumer>;
}

function controlledFactory() {
  const calls: FactoryCall[] = [];
  const factory: KafkaConsumerFactory = {
    create(topic: string, groupId: string, _onRecord: (record: SourceRecord) => Promise<void>) {
      const result = deferred<ReadyConsumer>();
      calls.push({ topic, groupId, result });
      return result.promise;
    },
  };
  return {
    factory,
    calls,
    resolve(index: number, consumer: ReadyConsumer): void {
      const call = calls[index];
      if (call === undefined) throw new Error(`No creation at index ${index}`);
      call.result.resolve(consumer);
    },
    reject(index: number, error: unknown): void {
      const call = calls[index];
      if (call === undefined) throw new Error(`No creation at index ${index}`);
      call.result.reject(error);
    },
  };
}

interface LogEvent {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields?: LogFields;
}

function loggerSpy(): { readonly logger: Logger; readonly events: LogEvent[] } {
  const events: LogEvent[] = [];
  const record = (level: LogLevel, event: string, fields?: LogFields): void => {
    events.push(fields === undefined ? { level, event } : { level, event, fields });
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

function immediateConsumer(): ReadyConsumer {
  return { close: async () => undefined };
}

function setup(initialTime = 0) {
  const factory = controlledFactory();
  const clock = new ManualClock(initialTime);
  const logger = loggerSpy();
  const deletedGroups: string[] = [];
  let deletionResult: GroupDeletionResult = { kind: 'deleted' };
  let deletionGate: Deferred<GroupDeletionResult> | undefined;
  const groupAdmin: KafkaGroupAdmin = {
    async deleteGroup(groupId): Promise<GroupDeletionResult> {
      deletedGroups.push(groupId);
      return deletionGate === undefined ? deletionResult : deletionGate.promise;
    },
  };
  const manager = createConsumerManager({
    factory: factory.factory,
    groupAdmin,
    clock,
    getIdleSeconds: () => 100,
    getGroupId: (topic) => `group-${topic}`,
    onRecord: async (_record: SourceRecord) => undefined,
    logger: logger.logger,
  });
  return {
    manager,
    factory,
    clock,
    logger,
    deletedGroups,
    setDeletionResult(result: GroupDeletionResult): void {
      deletionResult = result;
    },
    setDeletionGate(gate: Deferred<GroupDeletionResult>): void {
      deletionGate = gate;
    },
  };
}

async function open(
  state: ReturnType<typeof setup>,
  topic: string,
  consumer: ReadyConsumer,
): Promise<{ readonly topic: string; readonly generation: number }> {
  const reservation = state.manager.reserve(topic, 10);
  const ready = state.manager.ensureReady(reservation);
  state.factory.resolve(state.factory.calls.length - 1, consumer);
  await ready;
  return reservation;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test('closes the client once and makes one group deletion attempt', async () => {
  const state = setup();
  let closeCalls = 0;
  const consumer: ReadyConsumer = {
    close: async () => {
      closeCalls += 1;
    },
  };
  await open(state, 't', consumer);

  await state.manager.close('t', 'idle');

  expect(closeCalls).toBe(1);
  expect(state.deletedGroups).toEqual(['group-t']);
});

test('does not attempt group deletion after failed creation', async () => {
  const state = setup();
  const reservation = state.manager.reserve('t', 10);
  const ready = state.manager.ensureReady(reservation);
  state.factory.reject(0, new Error('creation failed'));

  await expect(ready).rejects.toThrow('creation failed');
  await settle();

  expect(state.deletedGroups).toEqual([]);
});

test('logs failed group deletion, releases the barrier, and becomes absent', async () => {
  const state = setup();
  state.setDeletionResult({ kind: 'failed', reason: 'broker' });
  await open(state, 't', immediateConsumer());

  await expect(state.manager.close('t', 'idle')).resolves.toBeUndefined();

  expect(state.manager.getState('t')).toBe('absent');
  expect(state.logger.events).toContainEqual({
    level: 'warn',
    event: 'consumer-group-deletion-failed',
    fields: expect.objectContaining({ topic: 't' }),
  });
});

test('keeps closing state and does not delete the group when client close fails', async () => {
  const state = setup();
  const consumer: ReadyConsumer = {
    close: async () => {
      throw new Error('close failed');
    },
  };
  await open(state, 't', consumer);

  await expect(state.manager.close('t', 'idle')).rejects.toThrow('Не удалось закрыть');

  expect(state.deletedGroups).toEqual([]);
  expect(state.manager.getState('t')).toBe('closing');
  expect(state.logger.events).toContainEqual({
    level: 'error',
    event: 'consumer-close-failed',
    fields: expect.objectContaining({ topic: 't' }),
  });
});

test('shares one close promise for parallel close calls', async () => {
  const state = setup();
  let closeCalls = 0;
  const consumer: ReadyConsumer = {
    close: async () => {
      closeCalls += 1;
    },
  };
  await open(state, 't', consumer);

  const first = state.manager.close('t', 'first');
  const second = state.manager.close('t', 'second');
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

  expect(closeCalls).toBe(1);
  expect(state.deletedGroups).toEqual(['group-t']);
});

test('waits for close and deletion before reopening with the stable group id', async () => {
  const state = setup();
  const closeDone = deferred<void>();
  let closeCalls = 0;
  const firstConsumer: ReadyConsumer = {
    close: async () => {
      closeCalls += 1;
      await closeDone.promise;
    },
  };
  await open(state, 't', firstConsumer);
  const closing = state.manager.close('t', 'idle');
  const deletionDone = deferred<GroupDeletionResult>();
  state.setDeletionGate(deletionDone);
  const reservation = state.manager.reserve('t', 10);
  const reopening = state.manager.ensureReady(reservation);

  await settle();
  expect(state.factory.calls).toHaveLength(1);
  closeDone.resolve();
  await settle();
  expect(state.factory.calls).toHaveLength(1);
  deletionDone.resolve({ kind: 'deleted' });
  await closing;
  await settle();

  expect(state.factory.calls).toHaveLength(2);
  expect(state.factory.calls[1]?.groupId).toBe(state.factory.calls[0]?.groupId);
  state.factory.resolve(1, immediateConsumer());
  await reopening;
  expect(closeCalls).toBe(1);
});

test('reopens after failed deletion using the same group id', async () => {
  const state = setup();
  await open(state, 't', immediateConsumer());
  state.setDeletionResult({ kind: 'failed', reason: 'broker' });
  await state.manager.close('t', 'idle');

  const reservation = state.manager.reserve('t', 10);
  const reopening = state.manager.ensureReady(reservation);
  expect(state.factory.calls).toHaveLength(2);
  expect(state.factory.calls[1]?.groupId).toBe(state.factory.calls[0]?.groupId);
  state.factory.resolve(1, immediateConsumer());
  await reopening;
});

test('preserves a ready consumer when active slots exist', async () => {
  const state = setup();
  let closeCalls = 0;
  const reservation = await open(state, 't', {
    close: async () => {
      closeCalls += 1;
    },
  });
  state.clock.advance(110_001);

  await expect(state.manager.tryCloseIdle('t', () => true)).resolves.toBe('skipped-active-slots');

  expect(closeCalls).toBe(0);
  expect(state.deletedGroups).toEqual([]);
  expect(state.manager.getState('t')).toBe('ready');
  state.manager.release(reservation);
});

test('skips idle closing while a reservation is active', async () => {
  const state = setup();
  await open(state, 't', immediateConsumer());
  state.clock.advance(110_001);

  await expect(state.manager.tryCloseIdle('t', () => false)).resolves.toBe('skipped-reservations');

  expect(state.deletedGroups).toEqual([]);
  expect(state.manager.getState('t')).toBe('ready');
});

test('skips before expiration and closes once after expiration', async () => {
  const state = setup();
  let closeCalls = 0;
  const reservation = await open(state, 't', {
    close: async () => {
      closeCalls += 1;
    },
  });
  await expect(state.manager.tryCloseIdle('t', () => false)).resolves.toBe('skipped-not-expired');

  state.manager.release(reservation);
  state.clock.advance(110_001);
  await expect(state.manager.tryCloseIdle('t', () => false)).resolves.toBe('closed');

  expect(closeCalls).toBe(1);
  expect(state.deletedGroups).toEqual(['group-t']);
});

test('continues closeAll after one client close failure', async () => {
  const state = setup();
  await open(state, 't1', {
    close: async () => {
      throw new Error('t1 close failed');
    },
  });
  let secondCloseCalls = 0;
  await open(state, 't2', {
    close: async () => {
      secondCloseCalls += 1;
    },
  });

  await state.manager.closeAll('shutdown');

  expect(secondCloseCalls).toBe(1);
  expect(state.deletedGroups).toEqual(['group-t2']);
  expect(state.manager.getState('t1')).toBe('closing');
  expect(state.manager.getState('t2')).toBe('absent');
  expect(state.logger.events).toContainEqual({
    level: 'error',
    event: 'consumer-close-failed',
    fields: expect.objectContaining({ topic: 't1' }),
  });
});
