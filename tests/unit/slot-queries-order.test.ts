import { expect, test } from 'vitest';
import { createSlotQueryService } from '../../src/application/slots/index.js';
import { createWaitRegistry } from '../../src/application/waiting/index.js';
import type { CompiledCheck } from '../../src/domain/check.js';
import { createSlotRegistry, type PreparedSlot } from '../../src/domain/slots/index.js';
import { ManualClock } from '../support/manual-clock.js';

const slotId = 'slot-order';
const check: CompiledCheck = { headers: [], values: [] };

function createService() {
  const registry = createSlotRegistry();
  const waits = createWaitRegistry({
    ids: {
      newSlotId: () => 'generated-slot',
      newWaitId: () => 'wait-1',
      newRunId: () => 'run-1',
    },
    clock: new ManualClock(),
  });

  return { registry, service: createSlotQueryService({ registry, waits }) };
}

function prepared(checks: readonly CompiledCheck[] = [check]): PreparedSlot {
  return { id: slotId, topic: 'topic', checks, expiresAt: 1_000 };
}

function registerOneCheck() {
  const setup = createService();
  const result = setup.registry.register(prepared());
  expect(result.kind).toBe('ok');
  return setup;
}

test('applies the contract order for an absent slot', async () => {
  const { service } = createService();

  await expect(service.read(slotId, -1, 0, 10)).resolves.toEqual({ kind: 'check-not-found' });
  await expect(service.read(slotId, 0, -1, 10)).resolves.toEqual({ kind: 'invalid-pagination' });
  await expect(service.read(slotId, 0, 0, 0)).resolves.toEqual({ kind: 'invalid-pagination' });
  await expect(service.read(slotId, 0, 0, 10)).resolves.toEqual({ kind: 'slot-not-found' });

  await expect(service.count(slotId, -1)).resolves.toEqual({ kind: 'check-not-found' });
  await expect(service.count(slotId, 0)).resolves.toEqual({ kind: 'slot-not-found' });

  await expect(service.wait(slotId, -1, { n: 1, timeoutMs: 1_000 })).resolves.toEqual({
    kind: 'invalid-request',
  });
  await expect(service.wait(slotId, 0, { n: 0, timeoutMs: 1_000 })).resolves.toEqual({
    kind: 'invalid-request',
  });
  await expect(service.wait(slotId, 0, { n: 1, timeoutMs: 0 })).resolves.toEqual({
    kind: 'invalid-request',
  });
  await expect(service.wait(slotId, 0, { n: 1, timeoutMs: 1_000 })).resolves.toEqual({
    kind: 'slot-not-found',
  });
});

test('validates indexes against a registered slot and accepts empty pages', async () => {
  const { service } = registerOneCheck();

  await expect(service.count(slotId, 1)).resolves.toEqual({ kind: 'check-not-found' });
  await expect(service.read(slotId, 1, 0, 10)).resolves.toEqual({ kind: 'check-not-found' });
  await expect(service.wait(slotId, 1, { n: 1, timeoutMs: 1_000 })).resolves.toEqual({
    kind: 'check-not-found',
  });
  await expect(service.read(slotId, 0, 0, 10)).resolves.toEqual({ kind: 'records', records: [] });
  await expect(service.read(slotId, 0, 5, 10)).resolves.toEqual({ kind: 'records', records: [] });
});

test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid index %s before slot lookup',
  async (checkIndex) => {
    const { service } = createService();

    await expect(service.count(slotId, checkIndex)).resolves.toEqual({ kind: 'check-not-found' });
    await expect(service.read(slotId, checkIndex, 0, 10)).resolves.toEqual({
      kind: 'check-not-found',
    });
    await expect(service.wait(slotId, checkIndex, { n: 1, timeoutMs: 1_000 })).resolves.toEqual({
      kind: 'invalid-request',
    });
  },
);
