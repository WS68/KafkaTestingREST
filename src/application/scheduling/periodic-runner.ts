import type { Clock, ScheduledTask } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';

export type PassOutcome = 'completed' | 'failed' | 'skipped-overlap';

export interface PeriodicRunner {
  start(): void;
  /** Останавливает запуск и дожидается уже начатого прохода. */
  stop(): Promise<void>;
  /** Выполняет проход немедленно (для тестов и ручного запуска). */
  runNow(): Promise<PassOutcome>;
  readonly running: boolean;
  readonly passInProgress: boolean;
}

export function createPeriodicRunner(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly name: string;
  readonly pass: () => Promise<void>;
}): PeriodicRunner {
  let isRunning = false;
  let isStopped = false;
  let isPassInProgress = false;
  let scheduledTask: ScheduledTask | undefined;
  let passPromise: Promise<PassOutcome> | undefined;
  let stopPromise: Promise<void> | undefined;

  const logOverlap = (): void => {
    try {
      deps.logger.warn('periodic-runner.pass-skipped-overlap', { name: deps.name });
    } catch {
      // Отказ журнала не должен нарушать работу планировщика.
    }
  };

  const scheduleNext = (): void => {
    if (!isRunning || isStopped) return;
    scheduledTask = deps.clock.schedule(deps.intervalMs, onTick);
  };

  const runPass = (): Promise<PassOutcome> => {
    if (isPassInProgress) {
      logOverlap();
      return Promise.resolve('skipped-overlap');
    }
    if (isStopped) return Promise.resolve('skipped-overlap');

    isPassInProgress = true;
    const execution = Promise.resolve()
      .then(() => deps.pass())
      .then<PassOutcome>(() => 'completed')
      .catch((reason: unknown): PassOutcome => {
        try {
          deps.logger.error('periodic-runner.pass-failed', {
            name: deps.name,
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        } catch {
          // Отказ журнала не должен изменять исход прохода.
        }
        return 'failed';
      })
      .finally(() => {
        isPassInProgress = false;
        passPromise = undefined;
      });
    passPromise = execution;
    return execution;
  };

  function onTick(): void {
    scheduledTask = undefined;
    if (!isRunning || isStopped) return;

    if (isPassInProgress) {
      logOverlap();
      scheduleNext();
      return;
    }

    const execution = runPass();
    void execution.then(() => scheduleNext());
  }

  return {
    start(): void {
      if (isRunning || isStopped) return;
      isRunning = true;
      scheduleNext();
    },
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      isRunning = false;
      isStopped = true;
      scheduledTask?.cancel();
      scheduledTask = undefined;
      stopPromise = passPromise?.then(() => undefined) ?? Promise.resolve();
      return stopPromise;
    },
    runNow(): Promise<PassOutcome> {
      return runPass();
    },
    get running(): boolean {
      return isRunning;
    },
    get passInProgress(): boolean {
      return isPassInProgress;
    },
  };
}
