import { expect, test } from 'vitest';
import { createPeriodicRunner } from '../../src/application/scheduling/periodic-runner.js';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

test('starts after the interval, is idempotent and schedules subsequent passes', async () => {
  const clock = new ManualClock();
  let calls = 0;
  const runner = createPeriodicRunner({
    clock,
    logger: loggerSpy().logger,
    intervalMs: 10,
    name: 'first',
    pass: async () => {
      calls += 1;
    },
  });
  runner.start();
  runner.start();
  clock.advance(9);
  await flush();
  expect(calls).toBe(0);
  clock.advance(1);
  await flush();
  expect(calls).toBe(1);
  expect(clock.pendingCount()).toBe(1);
  await runner.stop();
  await runner.stop();
});

test('does not overlap passes and schedules the next pass after completion', async () => {
  const clock = new ManualClock();
  const gate = deferred();
  let calls = 0;
  const runner = createPeriodicRunner({
    clock,
    logger: loggerSpy().logger,
    intervalMs: 5,
    name: 'delayed',
    pass: async () => {
      calls += 1;
      if (calls === 1) await gate.promise;
    },
  });
  runner.start();
  clock.advance(5);
  await flush();
  expect(runner.passInProgress).toBe(true);
  clock.advance(15);
  await flush();
  expect(calls).toBe(1);
  expect(runner.passInProgress).toBe(true);
  gate.resolve();
  await flush();
  expect(clock.pendingCount()).toBe(1);
  clock.advance(5);
  await flush();
  expect(calls).toBe(2);
  await runner.stop();
});

test('logs failures with the runner name and runNow reports failed', async () => {
  const clock = new ManualClock();
  const { logger, errors } = loggerSpy();
  let calls = 0;
  const runner = createPeriodicRunner({
    clock,
    logger,
    intervalMs: 7,
    name: 'named-runner',
    pass: async () => {
      calls += 1;
      throw new Error('broken');
    },
  });
  expect(await runner.runNow()).toBe('failed');
  expect(errors[0]).toMatchObject({
    event: 'periodic-runner.pass-failed',
    fields: { name: 'named-runner' },
  });
  runner.start();
  clock.advance(7);
  await flush();
  expect(calls).toBe(2);
  expect(clock.pendingCount()).toBe(1);
  await runner.stop();
});

test('stop waits for an in-flight pass and prevents new passes', async () => {
  const clock = new ManualClock();
  const gate = deferred();
  let calls = 0;
  const runner = createPeriodicRunner({
    clock,
    logger: loggerSpy().logger,
    intervalMs: 4,
    name: 'stoppable',
    pass: async () => {
      calls += 1;
      await gate.promise;
    },
  });
  runner.start();
  clock.advance(4);
  await flush();
  let stopped = false;
  const stopping = runner.stop().then(() => {
    stopped = true;
  });
  await flush();
  expect(stopped).toBe(false);
  gate.resolve();
  await stopping;
  expect(runner.running).toBe(false);
  clock.advance(40);
  await flush();
  expect(calls).toBe(1);
});

test('runner instances schedule independently', async () => {
  const clock = new ManualClock();
  let fast = 0;
  let slow = 0;
  const make = (intervalMs: number, pass: () => void) =>
    createPeriodicRunner({
      clock,
      logger: loggerSpy().logger,
      intervalMs,
      name: `${intervalMs}`,
      pass: async () => pass(),
    });
  const a = make(3, () => {
    fast += 1;
  });
  const b = make(8, () => {
    slow += 1;
  });
  a.start();
  b.start();
  clock.advance(3);
  await flush();
  expect([fast, slow]).toEqual([1, 0]);
  clock.advance(5);
  await flush();
  expect([fast, slow]).toEqual([2, 1]);
  await Promise.all([a.stop(), b.stop()]);
});
