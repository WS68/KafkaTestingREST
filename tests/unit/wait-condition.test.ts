import { expect, test } from 'vitest';
import { createWaitRegistry } from '../../src/application/waiting/index.js';
import { createCheckAccumulator } from '../../src/domain/accumulation/accumulator.js';
import type { CompiledCheck } from '../../src/domain/check.js';
import type { SourceRecord } from '../../src/domain/record.js';
import { ManualClock } from '../support/manual-clock.js';

const timeoutMs = 20;

function createRegistry(clock: ManualClock, settled = new Map<string, number>()) {
  let nextId = 1;
  const registry = createWaitRegistry({
    ids: {
      newSlotId: () => 'slot-id',
      newWaitId: () => `wait-${nextId++}`,
      newRunId: () => 'run-id',
    },
    clock,
    onSettled: (handle) => settled.set(handle.id, (settled.get(handle.id) ?? 0) + 1),
  });
  return { registry, settled };
}

function request(slotId: string, checkIndex: number, requiredCount: number) {
  return { slotId, checkIndex, requiredCount, timeoutMs } as const;
}

function sourceRecord(value: string): SourceRecord {
  return { headers: [], key: undefined, value: new TextEncoder().encode(value) };
}

function accumulator() {
  const check: CompiledCheck = { headers: [], values: [] };
  return createCheckAccumulator(check);
}

test('immediate conditions do not schedule a timer; a zero count waits for notification', async () => {
  const clock = new ManualClock();
  const { registry, settled } = createRegistry(clock);
  const immediate = registry.register(request('slot-a', 0, 1), () => 1);

  expect(await immediate).toBe('condition');
  expect(clock.pendingCount()).toBe(0);
  expect(registry.pendingCount()).toBe(0);
  expect(settled.get('wait-1')).toBe(1);

  let count = 0;
  const waiting = registry.register(request('slot-a', 0, 1), () => count);
  expect(clock.pendingCount()).toBe(1);
  expect(registry.pendingCount()).toBe(1);
  count = 1;
  registry.notifyAccumulated('slot-a', 0);

  expect(await waiting).toBe('condition');
  expect(clock.pendingCount()).toBe(0);
  expect(registry.pendingCount()).toBe(0);
  expect(settled.get('wait-2')).toBe(1);
});

test('independent waits use their own thresholds and slot/check pair', async () => {
  const clock = new ManualClock();
  const { registry, settled } = createRegistry(clock);
  const counts = new Map<string, number>([
    ['slot-a:0', 0],
    ['slot-a:1', 0],
  ]);
  const countFor = (slotId: string, checkIndex: number): number =>
    counts.get(`${slotId}:${checkIndex}`) ?? 0;
  const first = registry.register(request('slot-a', 0, 1), () => countFor('slot-a', 0));
  const third = registry.register(request('slot-a', 0, 3), () => countFor('slot-a', 0));
  const otherCheck = registry.register(request('slot-a', 1, 1), () => countFor('slot-a', 1));

  expect(clock.pendingCount()).toBe(3);
  counts.set('slot-a:0', 1);
  registry.notifyAccumulated('slot-a', 0);
  expect(await first).toBe('condition');
  expect(clock.pendingCount()).toBe(2);
  expect(registry.pendingCount()).toBe(2);
  expect(settled.get('wait-1')).toBe(1);
  expect(settled.has('wait-2')).toBe(false);
  expect(settled.has('wait-3')).toBe(false);

  registry.notifyAccumulated('slot-a', 1);
  expect(clock.pendingCount()).toBe(2);
  expect(registry.pendingCount()).toBe(2);
  counts.set('slot-a:1', 1);
  registry.notifyAccumulated('slot-a', 1);
  expect(await otherCheck).toBe('condition');
  expect(clock.pendingCount()).toBe(1);
  expect(registry.pendingCount()).toBe(1);

  counts.set('slot-a:0', 3);
  registry.notifyAccumulated('slot-a', 0);
  expect(await third).toBe('condition');
  expect(clock.pendingCount()).toBe(0);
  expect(registry.pendingCount()).toBe(0);
  expect([...settled.values()]).toEqual([1, 1, 1]);
});

test('condition wins before timeout and accumulation remains available', async () => {
  const clock = new ManualClock();
  const { registry, settled } = createRegistry(clock);
  const store = accumulator();
  const waiting = registry.register(request('slot-a', 0, 1), () => store.count());

  store.append(sourceRecord('condition-record'));
  registry.notifyAccumulated('slot-a', 0);
  expect(await waiting).toBe('condition');
  expect(store.count()).toBe(1);
  expect(store.snapshot(0, 10)).toHaveLength(1);

  clock.advance(timeoutMs);
  expect(clock.pendingCount()).toBe(0);
  expect(registry.pendingCount()).toBe(0);
  expect(settled.get('wait-1')).toBe(1);
  expect(store.count()).toBe(1);
  expect(store.snapshot(0, 10)).toHaveLength(1);
});

test('timeout wins before notification without cancelling later accumulation', async () => {
  const clock = new ManualClock();
  const { registry, settled } = createRegistry(clock);
  const store = accumulator();
  const waiting = registry.register(request('slot-a', 0, 1), () => store.count());

  clock.advance(timeoutMs);
  expect(await waiting).toBe('timeout');
  expect(clock.pendingCount()).toBe(0);
  expect(registry.pendingCount()).toBe(0);
  expect(settled.get('wait-1')).toBe(1);

  store.append(sourceRecord('late-record'));
  expect(() => registry.notifyAccumulated('slot-a', 0)).not.toThrow();
  expect(store.count()).toBe(1);
  expect(store.snapshot(0, 10)).toHaveLength(1);
  expect(clock.pendingCount()).toBe(0);
  expect(registry.pendingCount()).toBe(0);
  expect(settled.get('wait-1')).toBe(1);
});
