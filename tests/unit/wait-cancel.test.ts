import { expect, test } from 'vitest';
import {
  createWaitRegistry,
  WaitCancelledError,
  type WaitSettledReason,
} from '../../src/application/waiting/index.js';
import { ManualClock } from '../support/manual-clock.js';

const request = {
  slotId: 'slot-1',
  checkIndex: 0,
  requiredCount: 1,
  timeoutMs: 10,
} as const;

function createIds() {
  let nextWaitId = 1;
  return {
    newSlotId: () => 'slot-1',
    newWaitId: () => `wait-${nextWaitId++}`,
    newRunId: () => 'run-1',
  };
}

test('already completed condition resolves immediately without scheduling a timer', async () => {
  const clock = new ManualClock();
  const registry = createWaitRegistry({ ids: createIds(), clock });

  const promise = registry.register(request, () => 1);

  expect(clock.pendingCount()).toBe(0);
  expect(await promise).toBe('condition');
});

test('timeout resolves on the manual clock', async () => {
  const clock = new ManualClock();
  const registry = createWaitRegistry({ ids: createIds(), clock });

  const promise = registry.register(request, () => 0);
  expect(clock.pendingCount()).toBe(1);

  clock.advance(request.timeoutMs);

  expect(await promise).toBe('timeout');
  expect(clock.pendingCount()).toBe(0);
});

test('cancellation rejects with WaitCancelledError and removes the timer', async () => {
  const clock = new ManualClock();
  const reasons: WaitSettledReason[] = [];
  const registry = createWaitRegistry({
    ids: createIds(),
    clock,
    onSettled: (_handle, outcome, reason) => {
      expect(outcome).toBeUndefined();
      reasons.push(reason);
    },
  });

  const promise = registry.register(request, () => 0);

  expect(registry.cancel('wait-1')).toBe(true);
  await expect(promise).rejects.toBeInstanceOf(WaitCancelledError);
  expect(clock.pendingCount()).toBe(0);

  clock.advance(request.timeoutMs);
  expect(registry.pendingCount()).toBe(0);
  expect(registry.cancel('wait-1')).toBe(false);
  expect(reasons).toEqual(['cancelled']);
});

test('condition wins when notification precedes the timeout', async () => {
  const clock = new ManualClock();
  let count = 0;
  let settled = 0;
  const registry = createWaitRegistry({
    ids: createIds(),
    clock,
    onSettled: () => {
      settled += 1;
    },
  });
  const promise = registry.register(request, () => count);

  count = 1;
  registry.notifyAccumulated(request.slotId, request.checkIndex);
  clock.advance(request.timeoutMs);

  expect(await promise).toBe('condition');
  expect(settled).toBe(1);
});

test('timeout wins when it precedes notification', async () => {
  const clock = new ManualClock();
  let count = 0;
  const registry = createWaitRegistry({ ids: createIds(), clock });
  const promise = registry.register(request, () => count);

  clock.advance(request.timeoutMs);
  count = 1;
  registry.notifyAccumulated(request.slotId, request.checkIndex);

  expect(await promise).toBe('timeout');
});

test('settleAll resolves every wait and removes every timer', async () => {
  const clock = new ManualClock();
  const settledIds: string[] = [];
  const registry = createWaitRegistry({
    ids: createIds(),
    clock,
    onSettled: (handle, outcome, reason) => {
      expect(outcome).toBe('service-stopping');
      expect(reason).toBe('settled');
      settledIds.push(handle.id);
    },
  });
  const first = registry.register(request, () => 0);
  const second = registry.register({ ...request, slotId: 'slot-2' }, () => 0);

  expect(clock.pendingCount()).toBe(2);
  registry.settleAll('service-stopping');

  expect(await Promise.all([first, second])).toEqual(['service-stopping', 'service-stopping']);
  expect(clock.pendingCount()).toBe(0);
  expect(registry.pendingCount()).toBe(0);
  expect(settledIds).toEqual(['wait-1', 'wait-2']);
});
