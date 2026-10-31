import { expect, test } from 'vitest';
import { createConsumerIdleScheduler } from '../../src/application/scheduling/consumer-idle-scheduler.js';
import { createSlotCleanupScheduler } from '../../src/application/scheduling/slot-cleanup-scheduler.js';
import { createSlotDeletionService } from '../../src/application/slots/slot-deletion.js';
import { createSlotQueryService } from '../../src/application/slots/slot-queries.js';
import { createWaitRegistry } from '../../src/application/waiting/wait-registry.js';
import { createCheckAccumulator } from '../../src/domain/accumulation/index.js';
import { createSlotRegistry } from '../../src/domain/slots/slot-registry.js';
import type { PeriodicRunner } from '../../src/application/scheduling/periodic-runner.js';
import type { Logger } from '../../src/application/ports/logger.js';
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
function manualRunner() {
  let starts = 0;
  let stops = 0;
  const runner: PeriodicRunner = {
    start: () => {
      starts += 1;
    },
    stop: async () => {
      stops += 1;
    },
    runNow: async () => 'completed',
    get running() {
      return starts > stops;
    },
    get passInProgress() {
      return false;
    },
  };
  return { runner, starts: () => starts, stops: () => stops };
}

test('runPass sweeps exactly once and returns the sweeper result', async () => {
  const expected = [{ topic: 'orders', outcome: 'closed' as const }];
  let calls = 0;
  const scheduler = createConsumerIdleScheduler({
    clock: new ManualClock(),
    logger: loggerSpy().logger,
    sweeper: {
      sweep: async () => {
        calls += 1;
        return expected;
      },
    },
    runner: manualRunner().runner,
  });
  await expect(scheduler.runPass()).resolves.toBe(expected);
  expect(calls).toBe(1);
});

test('sweep failure is logged and resolves to an empty result', async () => {
  const { logger, errors } = loggerSpy();
  const scheduler = createConsumerIdleScheduler({
    clock: new ManualClock(),
    logger,
    sweeper: {
      sweep: async () => {
        throw new Error('sweep broke');
      },
    },
    runner: manualRunner().runner,
  });
  await expect(scheduler.runPass()).resolves.toEqual([]);
  expect(errors[0]).toMatchObject({
    event: 'consumer-idle-scheduler.sweep-failed',
    fields: { name: 'consumer-idle' },
  });
});

test('start and stop delegate to the runner without slot deletion dependencies', async () => {
  const delegated = manualRunner();
  let calls = 0;
  const sweeper = {
    sweep: async () => {
      calls += 1;
      return [];
    },
  };
  const scheduler = createConsumerIdleScheduler({
    clock: new ManualClock(),
    logger: loggerSpy().logger,
    sweeper,
    runner: delegated.runner,
  });
  scheduler.start();
  await scheduler.stop();
  expect(delegated.starts()).toBe(1);
  expect(delegated.stops()).toBe(1);
  expect(calls).toBe(0);
  expect(sweeper).toBeDefined();
});

test('uses the ten-minute default interval and does not remove slots', async () => {
  const clock = new ManualClock();
  let sweeps = 0;
  const scheduler = createConsumerIdleScheduler({
    clock,
    logger: loggerSpy().logger,
    sweeper: {
      sweep: async () => {
        sweeps += 1;
        return [];
      },
    },
  });
  scheduler.start();
  clock.advance(599_999);
  await Promise.resolve();
  expect(sweeps).toBe(0);
  clock.advance(1);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(sweeps).toBe(1);
  await scheduler.stop();
});

test('independent scheduler passes leave the other side untouched', async () => {
  const clock = new ManualClock();
  const logger = loggerSpy().logger;
  const slots = createSlotRegistry();
  const prepared = {
    id: 'active-slot',
    topic: 'topic',
    expiresAt: 10_000,
    checks: [createCheckAccumulator({ headers: [], values: [] }).check],
  };
  expect(slots.register(prepared).kind).toBe('ok');
  const waits = createWaitRegistry({
    ids: { newSlotId: () => 'slot', newWaitId: () => 'wait', newRunId: () => 'run' },
    clock,
  });
  const waiting = createSlotQueryService({ registry: slots, waits }).wait('active-slot', 0, {
    n: 1,
    timeoutMs: 1_000,
  });
  let sweeps = 0;
  const idle = createConsumerIdleScheduler({
    clock,
    logger,
    sweeper: {
      sweep: async () => {
        sweeps += 1;
        return [];
      },
    },
    runner: manualRunner().runner,
  });
  const slotScheduler = createSlotCleanupScheduler({
    registry: slots,
    deletion: createSlotDeletionService({ registry: slots, waits }),
    clock,
    logger,
    runner: manualRunner().runner,
  });
  await slotScheduler.runPass();
  expect(sweeps).toBe(0);
  expect(waits.pendingCount()).toBe(1);
  await idle.runPass();
  expect(sweeps).toBe(1);
  expect(slots.get('active-slot')).toBeDefined();
  expect(waits.pendingCount()).toBe(1);
  waits.settleAll('service-stopping');
  await waiting;
});
