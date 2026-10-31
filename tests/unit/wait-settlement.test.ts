import { expect, test } from 'vitest';
import {
  createWaitRegistry,
  WaitCancelledError,
  type WaitRegistry,
  type WaitSettledReason,
} from '../../src/application/waiting/index.js';
import { createCheckAccumulator } from '../../src/domain/accumulation/accumulator.js';
import type { CompiledCheck } from '../../src/domain/check.js';
import type { WaitOutcome, WaitRequest } from '../../src/domain/wait.js';
import { ManualClock } from '../support/manual-clock.js';

type SettledEvent = {
  readonly id: string;
  readonly outcome: WaitOutcome | undefined;
  readonly reason: WaitSettledReason;
};

type FinishWait = (
  registry: WaitRegistry,
  clock: ManualClock,
  setCount: (count: number) => void,
) => void;

const timeoutMs = 10;

function createIds() {
  let nextWaitId = 1;
  return {
    newSlotId: () => 'slot-generated',
    newWaitId: () => `wait-${nextWaitId++}`,
    newRunId: () => 'run-generated',
  };
}

function createRegistry() {
  const clock = new ManualClock();
  const events: SettledEvent[] = [];
  const registry = createWaitRegistry({
    ids: createIds(),
    clock,
    onSettled: (handle, outcome, reason) => {
      events.push({ id: handle.id, outcome, reason });
    },
  });
  return { clock, events, registry };
}

function request(slotId: string, checkIndex = 0, requiredCount = 1): WaitRequest {
  return { slotId, checkIndex, requiredCount, timeoutMs };
}

async function expectLateNotification(outcome: WaitOutcome, finish: FinishWait): Promise<void> {
  const { clock, events, registry } = createRegistry();
  let count = 0;
  const promise = registry.register(request('slot-a'), () => count);

  finish(registry, clock, (nextCount) => {
    count = nextCount;
  });
  const firstResult = await promise;
  expect(firstResult).toBe(outcome);

  expect(() => registry.notifyAccumulated('slot-a', 0)).not.toThrow();
  clock.advance(timeoutMs);
  expect(await promise).toBe(firstResult);
  expect(events).toEqual([{ id: 'wait-1', outcome, reason: 'settled' }]);
  expect(registry.pending()).toEqual([]);
  expect(clock.pendingCount()).toBe(0);
}

test('settleSlot completes only the deleted slot and keeps other timers alive', async () => {
  const { clock, events, registry } = createRegistry();
  const deleted = registry.register(request('slot-a'), () => 0);
  const otherSlot = registry.register(request('slot-b'), () => 0);
  const thirdSlot = registry.register(request('slot-c', 1), () => 0);

  expect(registry.pendingCount()).toBe(3);
  expect(clock.pendingCount()).toBe(3);
  registry.settleSlot('slot-a', 'slot-deleted');

  expect(await deleted).toBe('slot-deleted');
  expect(registry.pendingCount()).toBe(2);
  expect(clock.pendingCount()).toBe(2);
  expect(events).toEqual([{ id: 'wait-1', outcome: 'slot-deleted', reason: 'settled' }]);

  clock.advance(timeoutMs);
  expect(await Promise.all([otherSlot, thirdSlot])).toEqual(['timeout', 'timeout']);
  expect(registry.pendingCount()).toBe(0);
  expect(clock.pendingCount()).toBe(0);
});

test('settleAll releases every wait and is idempotent', async () => {
  const { clock, events, registry } = createRegistry();
  const waits = [
    registry.register(request('slot-a', 0), () => 0),
    registry.register(request('slot-b', 1), () => 0),
    registry.register(request('slot-c', 2), () => 0),
  ];

  expect(clock.pendingCount()).toBe(3);
  registry.settleAll('service-stopping');
  registry.settleAll('service-stopping');

  expect(await Promise.all(waits)).toEqual([
    'service-stopping',
    'service-stopping',
    'service-stopping',
  ]);
  expect(registry.pendingCount()).toBe(0);
  expect(registry.pending()).toEqual([]);
  expect(clock.pendingCount()).toBe(0);
  expect(events).toEqual([
    { id: 'wait-1', outcome: 'service-stopping', reason: 'settled' },
    { id: 'wait-2', outcome: 'service-stopping', reason: 'settled' },
    { id: 'wait-3', outcome: 'service-stopping', reason: 'settled' },
  ]);
});

test('cancellation rejects without changing the slot accumulation or timer state', async () => {
  const { clock, events, registry } = createRegistry();
  const check: CompiledCheck = { headers: [], values: [] };
  const store = createCheckAccumulator(check);
  store.append({ headers: [], key: undefined, value: new TextEncoder().encode('kept') });
  const before = store.snapshot(0, 10);
  const promise = registry.register(request('slot-a', 0, 2), () => store.count());

  expect(registry.cancel('wait-unknown')).toBe(false);
  expect(registry.cancel('wait-1')).toBe(true);
  await expect(promise).rejects.toBeInstanceOf(WaitCancelledError);
  expect(registry.cancel('wait-1')).toBe(false);
  expect(() => registry.notifyAccumulated('slot-a', 0)).not.toThrow();
  clock.advance(timeoutMs);

  expect(store.count()).toBe(1);
  expect(store.snapshot(0, 10)).toEqual(before);
  expect(registry.pendingCount()).toBe(0);
  expect(clock.pendingCount()).toBe(0);
  expect(events).toEqual([{ id: 'wait-1', outcome: undefined, reason: 'cancelled' }]);
});

test('late notification after condition does not settle twice', async () => {
  await expectLateNotification('condition', (registry, _clock, setCount) => {
    setCount(1);
    registry.notifyAccumulated('slot-a', 0);
  });
});

test('late notification after timeout does not settle twice', async () => {
  await expectLateNotification('timeout', (_registry, clock) => clock.advance(timeoutMs));
});

test('late notification after slot deletion does not settle twice', async () => {
  await expectLateNotification('slot-deleted', (registry) => {
    registry.settleSlot('slot-a', 'slot-deleted');
  });
});

test('late notification after service stopping does not settle twice', async () => {
  await expectLateNotification('service-stopping', (registry) => {
    registry.settleAll('service-stopping');
  });
});

test('a late timeout after condition leaves the result and callback unchanged', async () => {
  const { clock, events, registry } = createRegistry();
  let count = 0;
  const promise = registry.register(request('slot-a'), () => count);

  count = 1;
  registry.notifyAccumulated('slot-a', 0);
  expect(await promise).toBe('condition');
  clock.advance(timeoutMs);

  expect(await promise).toBe('condition');
  expect(events).toEqual([{ id: 'wait-1', outcome: 'condition', reason: 'settled' }]);
  expect(clock.pendingCount()).toBe(0);
});

test('mixed completion paths release all five waits exactly once', async () => {
  const { clock, events, registry } = createRegistry();
  let conditionCount = 0;
  const condition = registry.register(request('slot-condition'), () => conditionCount);
  const cancelled = registry.register(request('slot-cancelled'), () => 0);
  const deletedA = registry.register(request('slot-a'), () => 0);
  const deletedB = registry.register(request('slot-b'), () => 0);
  const stopping = registry.register(request('slot-stopping'), () => 0);

  conditionCount = 1;
  registry.notifyAccumulated('slot-condition', 0);
  expect(registry.cancel('wait-2')).toBe(true);
  registry.settleSlot('slot-a', 'slot-deleted');
  registry.settleSlot('slot-b', 'slot-deleted');
  registry.settleAll('service-stopping');

  await expect(cancelled).rejects.toBeInstanceOf(WaitCancelledError);
  expect(await Promise.all([condition, deletedA, deletedB, stopping])).toEqual([
    'condition',
    'slot-deleted',
    'slot-deleted',
    'service-stopping',
  ]);
  expect(registry.pendingCount()).toBe(0);
  expect(registry.pending()).toEqual([]);
  expect(clock.pendingCount()).toBe(0);
  expect(events).toEqual([
    { id: 'wait-1', outcome: 'condition', reason: 'settled' },
    { id: 'wait-2', outcome: undefined, reason: 'cancelled' },
    { id: 'wait-3', outcome: 'slot-deleted', reason: 'settled' },
    { id: 'wait-4', outcome: 'slot-deleted', reason: 'settled' },
    { id: 'wait-5', outcome: 'service-stopping', reason: 'settled' },
  ]);
});
