import { expect, test } from 'vitest';
import {
  createSlotDeletionService,
  createSlotQueryService,
} from '../../src/application/slots/index.js';
import { createWaitRegistry } from '../../src/application/waiting/index.js';
import { createCheckAccumulator } from '../../src/domain/accumulation/index.js';
import type { CompiledCheck } from '../../src/domain/check.js';
import type { SourceRecord } from '../../src/domain/record.js';
import { createSlotRegistry, type PreparedSlot } from '../../src/domain/slots/index.js';
import type { WaitResult } from '../../src/application/results/waiting.js';
import { ManualClock } from '../support/manual-clock.js';

const record: SourceRecord = {
  headers: [],
  key: undefined,
  value: new TextEncoder().encode('{"value":"record"}'),
};

function check(): CompiledCheck {
  return createCheckAccumulator({ headers: [], values: [] }).check;
}

function prepared(id: string, expiresAt: number, checkCount = 1): PreparedSlot {
  return {
    id,
    topic: 'topic',
    checks: Array.from({ length: checkCount }, check),
    expiresAt,
  };
}

function createSetup(initialTime = 0) {
  const clock = new ManualClock(initialTime);
  let nextWaitId = 0;
  const registry = createSlotRegistry();
  const waits = createWaitRegistry({
    ids: {
      newSlotId: () => `slot-${nextWaitId++}`,
      newWaitId: () => `wait-${nextWaitId++}`,
      newRunId: () => `run-${nextWaitId++}`,
    },
    clock,
  });

  return {
    clock,
    registry,
    waits,
    queries: createSlotQueryService({ registry, waits }),
    deletion: createSlotDeletionService({ registry, waits }),
  };
}

function register(
  registry: ReturnType<typeof createSlotRegistry>,
  id: string,
  expiresAt: number,
  checkCount = 1,
) {
  const result = registry.register(prepared(id, expiresAt, checkCount));
  if (result.kind !== 'ok') throw new Error(`Failed to register ${id}`);
  return result.slot;
}

function expectDeleted(result: WaitResult): void {
  expect(result.kind).toBe('slot-deleted');
}

test('reports missing slots and checks', async () => {
  const setup = createSetup();
  register(setup.registry, 'registered', 1_000);

  await expect(setup.queries.count('unknown', 0)).resolves.toEqual({ kind: 'slot-not-found' });
  await expect(setup.queries.read('unknown', 0, 0, 10)).resolves.toEqual({
    kind: 'slot-not-found',
  });
  await expect(setup.queries.wait('unknown', 0, { n: 1, timeoutMs: 10 })).resolves.toEqual({
    kind: 'slot-not-found',
  });

  await expect(setup.queries.count('registered', 1)).resolves.toEqual({
    kind: 'check-not-found',
  });
  await expect(setup.queries.read('registered', 1, 0, 10)).resolves.toEqual({
    kind: 'check-not-found',
  });
  await expect(setup.queries.wait('registered', 1, { n: 1, timeoutMs: 10 })).resolves.toEqual({
    kind: 'check-not-found',
  });
});

test('reading and waiting do not recalculate the slot expiration', async () => {
  const setup = createSetup();
  const registered = register(setup.registry, 'slot', 1_000);
  expect(setup.registry.appendToCheck('slot', 0, record)).toEqual({ kind: 'ok', count: 1 });

  await expect(setup.queries.count('slot', 0)).resolves.toEqual({ kind: 'counted', count: 1 });
  await expect(setup.queries.read('slot', 0, 0, 10)).resolves.toMatchObject({ kind: 'records' });
  await expect(setup.queries.wait('slot', 0, { n: 1, timeoutMs: 10 })).resolves.toEqual({
    kind: 'condition-met',
  });

  expect(setup.registry.get('slot')?.slot.expiresAt).toBe(1_000);
  expect(setup.registry.get('slot')).toBe(registered);
});

test('an expired but not deleted slot remains available', async () => {
  const setup = createSetup(10_000);
  register(setup.registry, 'expired', 0);
  expect(setup.registry.appendToCheck('expired', 0, record)).toEqual({ kind: 'ok', count: 1 });

  await expect(setup.queries.count('expired', 0)).resolves.toEqual({ kind: 'counted', count: 1 });
  await expect(setup.queries.read('expired', 0, 0, 10)).resolves.toMatchObject({ kind: 'records' });
  await expect(setup.queries.wait('expired', 0, { n: 1, timeoutMs: 10 })).resolves.toEqual({
    kind: 'condition-met',
  });
});

test('repeated deletion is not destructive after the first deletion', async () => {
  const setup = createSetup();
  const registered = register(setup.registry, 'slot', 1_000, 2);
  expect(setup.registry.appendToCheck('slot', 0, record)).toEqual({ kind: 'ok', count: 1 });
  expect(setup.registry.appendToCheck('slot', 1, record)).toEqual({ kind: 'ok', count: 1 });
  const accumulators = registered.accumulators;

  await expect(setup.deletion.delete('slot')).resolves.toEqual({ kind: 'deleted' });
  expect(accumulators.map((accumulator) => accumulator.count())).toEqual([0, 0]);
  expect(setup.registry.size()).toBe(0);
  await expect(setup.deletion.delete('slot')).resolves.toEqual({ kind: 'not-found' });
  expect(accumulators.map((accumulator) => accumulator.count())).toEqual([0, 0]);
  expect(setup.registry.size()).toBe(0);
});

test('deletion settles every wait for the deleted slot and clears timers', async () => {
  const setup = createSetup();
  register(setup.registry, 'slot', 1_000, 3);
  const first = setup.queries.wait('slot', 0, { n: 1, timeoutMs: 100 });
  const second = setup.queries.wait('slot', 1, { n: 2, timeoutMs: 200 });
  const third = setup.queries.wait('slot', 2, { n: 3, timeoutMs: 300 });

  expect(setup.waits.pendingCount()).toBe(3);
  expect(setup.clock.pendingCount()).toBe(3);
  await expect(setup.deletion.delete('slot')).resolves.toEqual({ kind: 'deleted' });
  const results = await Promise.all([first, second, third]);

  results.forEach(expectDeleted);
  expect(setup.waits.pendingCount()).toBe(0);
  expect(setup.clock.pendingCount()).toBe(0);
});

test('deleting one slot does not settle another slot wait', async () => {
  const setup = createSetup();
  register(setup.registry, 'slot-a', 1_000);
  register(setup.registry, 'slot-b', 1_000);
  const waiting = setup.queries.wait('slot-b', 0, { n: 1, timeoutMs: 10 });

  await expect(setup.deletion.delete('slot-a')).resolves.toEqual({ kind: 'deleted' });
  expect(setup.waits.pendingCount()).toBe(1);
  expect(setup.clock.pendingCount()).toBe(1);
  setup.clock.advance(10);
  await expect(waiting).resolves.toEqual({ kind: 'timeout' });
  expect(setup.waits.pendingCount()).toBe(0);
  expect(setup.clock.pendingCount()).toBe(0);
});

test('does not append after deletion, and clears an existing accumulator on deletion', async () => {
  const first = createSetup();
  register(first.registry, 'slot', 1_000);
  await first.deletion.delete('slot');
  expect(first.registry.appendToCheck('slot', 0, record)).toEqual({ kind: 'slot-not-found' });
  expect(first.registry.get('slot')).toBeUndefined();

  const second = createSetup();
  const registered = register(second.registry, 'slot', 1_000);
  expect(second.registry.appendToCheck('slot', 0, record)).toEqual({ kind: 'ok', count: 1 });
  const accumulator = registered.accumulators[0];
  if (accumulator === undefined) throw new Error('Expected one accumulator');
  await second.deletion.delete('slot');
  expect(accumulator.count()).toBe(0);
  expect(second.registry.get('slot')).toBeUndefined();
});

test('deleted slots remain absent from all application operations', async () => {
  const setup = createSetup();
  register(setup.registry, 'slot', 1_000);
  await setup.deletion.delete('slot');

  expect(setup.registry.appendToCheck('slot', 0, record)).toEqual({ kind: 'slot-not-found' });
  await expect(setup.deletion.delete('slot')).resolves.toEqual({ kind: 'not-found' });
  await expect(setup.queries.count('slot', 0)).resolves.toEqual({ kind: 'slot-not-found' });
  await expect(setup.queries.read('slot', 0, 0, 10)).resolves.toEqual({
    kind: 'slot-not-found',
  });
  await expect(setup.queries.wait('slot', 0, { n: 1, timeoutMs: 10 })).resolves.toEqual({
    kind: 'slot-not-found',
  });
  expect(setup.registry.get('slot')).toBeUndefined();
  expect(setup.registry.isDeleted('slot')).toBe(true);
});

test('a stale low-level accumulator reference cannot revive a deleted slot', async () => {
  const setup = createSetup();
  const stale = register(setup.registry, 'slot', 1_000);
  const accumulator = stale.accumulators[0];
  if (accumulator === undefined) throw new Error('Expected one accumulator');

  await setup.deletion.delete('slot');
  expect(setup.registry.appendToCheck('slot', 0, record)).toEqual({ kind: 'slot-not-found' });
  accumulator.append(record);

  expect(setup.registry.get('slot')).toBeUndefined();
  await expect(setup.queries.count('slot', 0)).resolves.toEqual({ kind: 'slot-not-found' });
});
