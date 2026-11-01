import { expect, test } from 'vitest';
import { createRecordRouter } from '../../src/application/routing/record-router.js';
import { createWaitRegistry } from '../../src/application/waiting/wait-registry.js';
import { parseJsonPath } from '../../src/domain/checking/json-path.js';
import {
  createSlotRegistry,
  type PreparedSlot,
  type SlotRegistry,
} from '../../src/domain/slots/slot-registry.js';
import type { CompiledCheck } from '../../src/domain/check.js';
import type { SourceRecord } from '../../src/domain/record.js';
import type { WaitRegistry } from '../../src/application/waiting/wait-registry.js';
import { ManualClock } from '../support/manual-clock.js';

type RouterDependencies = Parameters<typeof createRecordRouter>[0];
type Assert<T extends true> = T;
type HasOnlyRegistryAndWaits =
  Exclude<keyof RouterDependencies, 'registry' | 'waits'> extends never
    ? Exclude<'registry' | 'waits', keyof RouterDependencies> extends never
      ? true
      : false
    : false;
const routerDependenciesAreDecoupled: Assert<HasOnlyRegistryAndWaits> = true;
void routerDependenciesAreDecoupled;

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const record = (json: string): SourceRecord => ({
  headers: [],
  key: undefined,
  value: bytes(json),
});

function check(): CompiledCheck {
  return { headers: [], values: [] };
}

function slot(registry: SlotRegistry, id: string, topic: string, checks: readonly CompiledCheck[]) {
  const prepared: PreparedSlot = { id, topic, checks, expiresAt: 1_000 };
  const result = registry.register(prepared);
  if (result.kind !== 'ok') throw new Error(`Duplicate slot: ${id}`);
  return result.slot;
}

function createWaits(clock = new ManualClock()): WaitRegistry {
  let nextId = 0;
  return createWaitRegistry({
    ids: {
      newSlotId: () => `slot-${nextId}`,
      newWaitId: () => `wait-${nextId++}`,
      newRunId: () => 'run',
    },
    clock,
  });
}

test('routes each record to all matching checks across slots, with independent accumulation', () => {
  const registry = createSlotRegistry();
  const first = slot(registry, 'first', 't1', [check(), check()]);
  const second = slot(registry, 'second', 't1', [check()]);
  const router = createRecordRouter({ registry, waits: createWaits() });
  const message = record('{"value":1}');

  router.route('t1', message);
  expect(first.accumulators.map((item) => item.count())).toEqual([1, 1]);
  expect(second.accumulators.map((item) => item.count())).toEqual([1]);
  router.route('t1', message);
  expect(first.accumulators.map((item) => item.count())).toEqual([2, 2]);
  expect(second.accumulators.map((item) => item.count())).toEqual([2]);
});

test('does not route records across topics or create slots for an unknown topic', () => {
  const registry = createSlotRegistry();
  const registered = slot(registry, 'other', 't2', [check()]);
  const router = createRecordRouter({ registry, waits: createWaits() });

  expect(() => router.route('t1', record('{}'))).not.toThrow();
  expect(() => router.route('unknown', record('{}'))).not.toThrow();
  expect(registered.accumulators[0]?.count()).toBe(0);
  expect(registry.size()).toBe(1);
});

test('rechecks the registry after taking a topic snapshot before appending', () => {
  const registry = createSlotRegistry();
  const registered = slot(registry, 'removed-during-route', 't1', [check()]);
  let removed = false;
  const observed: SlotRegistry = {
    ...registry,
    listByTopic(topic) {
      const snapshot = registry.listByTopic(topic);
      if (!removed) {
        removed = true;
        registry.remove('removed-during-route');
      }
      return snapshot;
    },
  };
  const router = createRecordRouter({ registry: observed, waits: createWaits() });

  expect(() => router.route('t1', record('{}'))).not.toThrow();
  expect(registered.accumulators[0]?.count()).toBe(0);
  expect(registry.get('removed-during-route')).toBeUndefined();
  expect(registry.size()).toBe(0);
});

test('preserves route order in accumulator snapshots', () => {
  const registry = createSlotRegistry();
  const registered = slot(registry, 'ordered', 't1', [check()]);
  const router = createRecordRouter({ registry, waits: createWaits() });

  router.route('t1', record('{"n":1}'));
  router.route('t1', record('{"n":2}'));
  router.route('t1', record('{"n":3}'));
  const snapshot = registered.accumulators[0]?.snapshot(0, 10) ?? [];
  expect(snapshot.map((item) => new TextDecoder().decode(item.value))).toEqual([
    '{"n":1}',
    '{"n":2}',
    '{"n":3}',
  ]);
});

test('continues other checks when one prepared condition cannot match malformed record data', () => {
  const path = parseJsonPath('$.value');
  if (path === undefined) throw new Error('Expected a valid prepared path');
  const registry = createSlotRegistry();
  const registered = slot(registry, 'invalid-condition', 't1', [
    { headers: [], values: [{ jsonPath: path, value: 'match' }] },
    check(),
  ]);
  const router = createRecordRouter({ registry, waits: createWaits() });
  const malformed: SourceRecord = { headers: [], key: undefined, value: new Uint8Array([0xff]) };

  expect(() => router.route('t1', malformed)).not.toThrow();
  expect(registered.accumulators.map((item) => item.count())).toEqual([0, 1]);
});

test('continues accumulating after a wait times out and does not settle it again', async () => {
  const clock = new ManualClock();
  const waits = createWaits(clock);
  const registry = createSlotRegistry();
  const registered = slot(registry, 'timed-out', 't1', [check()]);
  const accumulator = registered.accumulators[0];
  if (accumulator === undefined) throw new Error('Expected an accumulator');
  const waiting = waits.register(
    { slotId: 'timed-out', checkIndex: 0, requiredCount: 2, timeoutMs: 10 },
    () => accumulator.count(),
  );
  const router = createRecordRouter({ registry, waits });

  clock.advance(10);
  expect(await waiting).toBe('timeout');
  router.route('t1', record('{"late":true}'));
  expect(accumulator.count()).toBe(1);
  expect(accumulator.snapshot(0, 10)).toHaveLength(1);
  expect(waits.pendingCount()).toBe(0);
  expect(await waiting).toBe('timeout');
});

test('notifies and resolves a matching wait when a record is accumulated', async () => {
  const waits = createWaits();
  const registry = createSlotRegistry();
  const registered = slot(registry, 'waiting', 't1', [check()]);
  const accumulator = registered.accumulators[0];
  if (accumulator === undefined) throw new Error('Expected an accumulator');
  const waiting = waits.register(
    { slotId: 'waiting', checkIndex: 0, requiredCount: 1, timeoutMs: 50 },
    () => accumulator.count(),
  );
  const router = createRecordRouter({ registry, waits });

  router.route('t1', record('{}'));
  expect(await waiting).toBe('condition');
  expect(waits.pendingCount()).toBe(0);
});

test('uses only registry and wait operations and exposes no publishing dependency', () => {
  const baseRegistry = createSlotRegistry();
  slot(baseRegistry, 'observed', 't1', [check()]);
  const registryCalls: string[] = [];
  const waitCalls: string[] = [];
  const registry: SlotRegistry = {
    ...baseRegistry,
    listByTopic(topic) {
      registryCalls.push('listByTopic');
      return baseRegistry.listByTopic(topic);
    },
    get(id) {
      registryCalls.push('get');
      return baseRegistry.get(id);
    },
    isDeleted(id) {
      registryCalls.push('isDeleted');
      return baseRegistry.isDeleted(id);
    },
    appendToCheck(id, index, value) {
      registryCalls.push('appendToCheck');
      return baseRegistry.appendToCheck(id, index, value);
    },
  };
  const baseWaits = createWaits();
  const waits: WaitRegistry = {
    ...baseWaits,
    notifyAccumulated(id, index) {
      waitCalls.push('notifyAccumulated');
      baseWaits.notifyAccumulated(id, index);
    },
  };
  const router = createRecordRouter({ registry, waits });

  router.route('t1', record('{}'));
  expect(registryCalls).toEqual([
    'listByTopic',
    'get',
    'isDeleted',
    'get',
    'isDeleted',
    'appendToCheck',
  ]);
  expect(waitCalls).toEqual(['notifyAccumulated']);
});

test('routing does not restore a previously removed slot', () => {
  const registry = createSlotRegistry();
  slot(registry, 'gone', 't1', [check()]);
  registry.remove('gone');
  const sizeAfterRemoval = registry.size();
  const router = createRecordRouter({ registry, waits: createWaits() });

  router.route('t1', record('{}'));
  expect(registry.size()).toBe(sizeAfterRemoval);
  expect(registry.get('gone')).toBeUndefined();
});
