import { expect, test } from 'vitest';
import { createSlotCleanupScheduler } from '../../src/application/scheduling/slot-cleanup-scheduler.js';
import { createConsumerIdleScheduler } from '../../src/application/scheduling/consumer-idle-scheduler.js';
import type { PeriodicRunner } from '../../src/application/scheduling/periodic-runner.js';
import { createSlotDeletionService } from '../../src/application/slots/slot-deletion.js';
import { createSlotQueryService } from '../../src/application/slots/slot-queries.js';
import { createWaitRegistry } from '../../src/application/waiting/wait-registry.js';
import type { Logger } from '../../src/application/ports/logger.js';
import { createCheckAccumulator } from '../../src/domain/accumulation/index.js';
import { createSlotRegistry, type PreparedSlot } from '../../src/domain/slots/slot-registry.js';
import { ManualClock } from '../support/manual-clock.js';

function loggerSpy() {
  const errors: {
    event: string;
    fields:
      | Readonly<Record<string, import('../../src/application/ports/logger.js').LogFieldValue>>
      | undefined;
  }[] = [];
  const logger: Logger = {
    log: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (event, fields) => errors.push({ event, fields }),
  };
  return { logger, errors };
}
function prepared(id: string, expiresAt: number): PreparedSlot {
  return {
    id,
    topic: 'topic',
    expiresAt,
    checks: [createCheckAccumulator({ headers: [], values: [] }).check],
  };
}
function register(
  registry: ReturnType<typeof createSlotRegistry>,
  id: string,
  expiresAt: number,
): void {
  if (registry.register(prepared(id, expiresAt)).kind !== 'ok')
    throw new Error('registration failed');
}
function manualRunner(runNow: () => Promise<unknown> = async () => undefined): PeriodicRunner {
  let running = false;
  return {
    start: () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
    runNow: async () => {
      await runNow();
      return 'completed';
    },
    get running() {
      return running;
    },
    get passInProgress() {
      return false;
    },
  };
}

test('deletes only slots at or beyond expiry, settles waits and returns deleted IDs', async () => {
  const clock = new ManualClock(100);
  const slots = createSlotRegistry();
  register(slots, 'boundary', 100);
  register(slots, 'future', 101);
  const waits = createWaitRegistry({
    ids: { newSlotId: () => 's', newWaitId: () => 'w', newRunId: () => 'r' },
    clock,
  });
  const waiting = waits.register(
    { slotId: 'boundary', checkIndex: 0, requiredCount: 1, timeoutMs: 1_000 },
    () => 0,
  );
  expect(slots.get('boundary')).toBeDefined();
  const scheduler = createSlotCleanupScheduler({
    registry: slots,
    deletion: createSlotDeletionService({ registry: slots, waits }),
    clock,
    logger: loggerSpy().logger,
    runner: manualRunner(),
  });
  await expect(scheduler.runPass()).resolves.toEqual(['boundary']);
  await expect(waiting).resolves.toBe('slot-deleted');
  expect(waits.pendingCount()).toBe(0);
  expect(slots.get('boundary')).toBeUndefined();
  expect(slots.get('future')).toBeDefined();
});

test('logs a slot deletion failure and continues with remaining expired slots', async () => {
  const clock = new ManualClock(5);
  const registry = createSlotRegistry();
  register(registry, 'first', 0);
  register(registry, 'second', 5);
  const { logger, errors } = loggerSpy();
  const scheduler = createSlotCleanupScheduler({
    registry,
    clock,
    logger,
    runner: manualRunner(),
    deletion: {
      delete: async (id) => {
        if (id === 'first') throw new Error('failed');
        registry.remove(id);
        return { kind: 'deleted' };
      },
    },
  });
  await expect(scheduler.runPass()).resolves.toEqual(['second']);
  expect(registry.get('first')).toBeDefined();
  expect(registry.get('second')).toBeUndefined();
  expect(errors[0]).toMatchObject({
    event: 'slot-cleanup.delete-failed',
    fields: { slotId: 'first' },
  });
});

test('uses a 60-second default interval; only deletion dependencies are accepted', async () => {
  const clock = new ManualClock();
  const registry = createSlotRegistry();
  register(registry, 'expired', 0);
  let deletions = 0;
  const scheduler = createSlotCleanupScheduler({
    registry,
    clock,
    logger: loggerSpy().logger,
    deletion: {
      delete: async (id) => {
        deletions += 1;
        registry.remove(id);
        return { kind: 'deleted' };
      },
    },
  });
  scheduler.start();
  clock.advance(59_999);
  await Promise.resolve();
  expect(deletions).toBe(0);
  clock.advance(1);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(deletions).toBe(1);
  await scheduler.stop();
});

test('slot cleanup leaves idle sweep untouched and the idle pass leaves slot waits untouched', async () => {
  const clock = new ManualClock();
  const slots = createSlotRegistry();
  register(slots, 'active', 1_000);
  const waits = createWaitRegistry({
    ids: { newSlotId: () => 's', newWaitId: () => 'w', newRunId: () => 'r' },
    clock,
  });
  const waiting = createSlotQueryService({ registry: slots, waits }).wait('active', 0, {
    n: 1,
    timeoutMs: 100,
  });
  let sweeps = 0;
  const idle = createConsumerIdleScheduler({
    clock,
    logger: loggerSpy().logger,
    sweeper: {
      sweep: async () => {
        sweeps += 1;
        return [];
      },
    },
    runner: manualRunner(),
  });
  const scheduler = createSlotCleanupScheduler({
    registry: slots,
    deletion: createSlotDeletionService({ registry: slots, waits }),
    clock,
    logger: loggerSpy().logger,
    runner: manualRunner(),
  });
  await scheduler.runPass();
  expect(sweeps).toBe(0);
  expect(waits.pendingCount()).toBe(1);
  await idle.runPass();
  expect(sweeps).toBe(1);
  expect(waits.pendingCount()).toBe(1);
  expect(slots.get('active')).toBeDefined();
  waits.settleAll('service-stopping');
  await waiting;
});
