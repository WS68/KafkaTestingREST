import { expect, test } from 'vitest';
import { ManualClock } from '../support/manual-clock.js';

test('не выполняет задачу раньше срока', () => {
  const clock = new ManualClock();
  let calls = 0;

  const scheduled = clock.schedule(10, () => {
    calls += 1;
  });

  clock.advance(9);
  expect(calls).toBe(0);
  expect(scheduled.active).toBe(true);

  clock.advance(1);
  expect(calls).toBe(1);
  expect(scheduled.active).toBe(false);
});

test('выполняет задачи с одинаковым сроком в порядке регистрации', () => {
  const clock = new ManualClock();
  const calls: number[] = [];

  clock.schedule(10, () => calls.push(1));
  clock.schedule(10, () => calls.push(2));
  clock.schedule(10, () => calls.push(3));

  clock.advance(10);

  expect(calls).toEqual([1, 2, 3]);
});

test('учитывает задачу, запланированную из выполняемой задачи', () => {
  const clock = new ManualClock();
  const calls: string[] = [];

  clock.schedule(10, () => {
    calls.push('first');
    clock.schedule(5, () => calls.push('nested'));
  });
  clock.schedule(12, () => calls.push('middle'));

  clock.advance(20);

  expect(calls).toEqual(['first', 'middle', 'nested']);
  expect(clock.now()).toBe(20);
});

test('уменьшает pendingCount после выполнения и отмены', () => {
  const clock = new ManualClock();
  const completed = clock.schedule(5, () => undefined);
  const cancelled = clock.schedule(10, () => undefined);

  expect(clock.pendingCount()).toBe(2);
  clock.advance(5);
  expect(completed.active).toBe(false);
  expect(clock.pendingCount()).toBe(1);

  cancelled.cancel();
  expect(cancelled.active).toBe(false);
  expect(clock.pendingCount()).toBe(0);
});

test('повторная отмена безопасна и отменённая задача не выполняется', () => {
  const clock = new ManualClock();
  let calls = 0;
  const scheduled = clock.schedule(1, () => {
    calls += 1;
  });

  scheduled.cancel();
  scheduled.cancel();
  clock.advance(1);

  expect(scheduled.active).toBe(false);
  expect(clock.pendingCount()).toBe(0);
  expect(calls).toBe(0);
});

test('schedule(0) выполняется при advance(0), но не при регистрации', () => {
  const clock = new ManualClock();
  let calls = 0;

  const scheduled = clock.schedule(0, () => {
    calls += 1;
  });

  expect(calls).toBe(0);
  expect(scheduled.active).toBe(true);

  clock.advance(0);

  expect(calls).toBe(1);
  expect(scheduled.active).toBe(false);
});
