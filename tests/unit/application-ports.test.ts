import { expect, test } from 'vitest';
import type {
  Clock,
  IdSource,
  LogFields,
  LogLevel,
  Logger,
  ScheduledTask,
} from '../../src/application/ports/index.js';

interface ManualTask {
  readonly dueAt: number;
  readonly task: () => void;
  cancelled: boolean;
  completed: boolean;
}

class ManualClock implements Clock {
  private time = 0;
  private readonly tasks: ManualTask[] = [];

  now(): number {
    return this.time;
  }

  schedule(delayMs: number, task: () => void): ScheduledTask {
    const entry: ManualTask = {
      dueAt: this.time + delayMs,
      task,
      cancelled: false,
      completed: false,
    };
    this.tasks.push(entry);

    return {
      get active(): boolean {
        return !entry.cancelled && !entry.completed;
      },
      cancel(): void {
        entry.cancelled = true;
      },
    };
  }

  advance(ms: number): void {
    this.time += ms;
    for (const entry of this.tasks) {
      if (!entry.cancelled && !entry.completed && entry.dueAt <= this.time) {
        entry.completed = true;
        entry.task();
      }
    }
  }
}

interface LogCall {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: LogFields | undefined;
}

class SpyLogger implements Logger {
  readonly calls: LogCall[] = [];

  log(level: LogLevel, event: string, fields?: LogFields): void {
    this.calls.push({ level, event, fields });
  }

  debug(event: string, fields?: LogFields): void {
    this.log('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.log('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.log('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.log('error', event, fields);
  }
}

const fixedIds: IdSource = {
  newSlotId: () => 'slot-fixed',
  newWaitId: () => 'wait-fixed',
  newRunId: () => 'run-fixed',
};

function scheduleAndLog(clock: Clock, logger: Logger): ScheduledTask {
  const scheduled = clock.schedule(100, () => {
    logger.info('task.completed', { at: clock.now() });
  });
  logger.debug('task.scheduled', { delayMs: 100 });
  return scheduled;
}

// @ts-expect-error A runtime timer API is not a Clock port.
const invalidClock: Clock = { setTimeout: (): void => undefined };
void invalidClock;

test('ports support deterministic scheduling, identifiers, and structured logging', () => {
  const clock = new ManualClock();
  const logger = new SpyLogger();
  const scheduled = scheduleAndLog(clock, logger);

  expect(scheduled.active).toBe(true);
  expect(logger.calls).toEqual([
    { level: 'debug', event: 'task.scheduled', fields: { delayMs: 100 } },
  ]);

  clock.advance(99);
  expect(logger.calls).toHaveLength(1);

  clock.advance(1);
  expect(scheduled.active).toBe(false);
  expect(logger.calls[1]).toEqual({
    level: 'info',
    event: 'task.completed',
    fields: { at: 100 },
  });

  const cancelled = scheduleAndLog(clock, logger);
  cancelled.cancel();
  cancelled.cancel();
  clock.advance(100);
  expect(cancelled.active).toBe(false);
  expect(logger.calls).toHaveLength(3);

  expect(fixedIds.newSlotId()).toBe('slot-fixed');
  expect(fixedIds.newWaitId()).toBe('wait-fixed');
  expect(fixedIds.newRunId()).toBe('run-fixed');
});
