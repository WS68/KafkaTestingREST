import { afterEach, expect, test, vi } from 'vitest';
import type { ScheduledTask } from '../../src/application/ports/clock.js';
import { createSystemClock } from '../../src/infrastructure/time/system-clock.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('schedule(0) выполняется асинхронно', async () => {
  const clock = createSystemClock();
  let calls = 0;

  const scheduled = clock.schedule(0, () => {
    calls += 1;
  });

  expect(calls).toBe(0);
  expect(scheduled.active).toBe(true);

  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(calls).toBe(1);
  expect(scheduled.active).toBe(false);
});

test('cancel предотвращает выполнение и безопасен при повторном вызове', async () => {
  vi.useFakeTimers({ now: 0 });
  const clock = createSystemClock();
  let calls = 0;
  const scheduled = clock.schedule(20, () => {
    calls += 1;
  });

  scheduled.cancel();
  scheduled.cancel();
  await vi.advanceTimersByTimeAsync(20);

  expect(calls).toBe(0);
  expect(scheduled.active).toBe(false);
});

test('не выполняет задачу раньше срока', async () => {
  const clock = createSystemClock();
  let completedAt: number | undefined;
  const startedAt = Date.now();
  const scheduled = clock.schedule(20, () => {
    completedAt = Date.now();
  });

  while (completedAt === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  expect(completedAt - startedAt).toBeGreaterThanOrEqual(19);
  expect(scheduled.active).toBe(false);
});

test('разбивает длительную задержку и сохраняет весь остаток', async () => {
  vi.useFakeTimers({ now: 0 });
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const clock = createSystemClock();
  const requestedDelay = MAX_TIMEOUT_MS + 123;
  let calls = 0;

  const scheduled: ScheduledTask = clock.schedule(requestedDelay, () => {
    calls += 1;
  });

  expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMEOUT_MS);

  await vi.advanceTimersByTimeAsync(requestedDelay);

  const delays = setTimeoutSpy.mock.calls.map((call) => Number(call[1]));
  expect(delays[0]).toBe(MAX_TIMEOUT_MS);
  expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(requestedDelay);
  expect(calls).toBe(1);
  expect(scheduled.active).toBe(false);
});
