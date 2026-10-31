import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { IdleSweeper, IdleSweepResult } from '../consumers/idle-sweeper.js';
import { createPeriodicRunner } from './periodic-runner.js';
import type { PeriodicRunner } from './periodic-runner.js';

export interface ConsumerIdleScheduler {
  start(): void;
  stop(): Promise<void>;
  /** Один проход (для тестов и ручного запуска). */
  runPass(): Promise<readonly IdleSweepResult[]>;
}

export function createConsumerIdleScheduler(deps: {
  readonly sweeper: IdleSweeper;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly runner?: PeriodicRunner;
}): ConsumerIdleScheduler {
  // Проверка бездействия выполняется раз в 10 минут; интервал не настраивается.
  const intervalMs = 600_000;

  const runner =
    deps.runner ??
    createPeriodicRunner({
      clock: deps.clock,
      logger: deps.logger,
      intervalMs,
      name: 'consumer-idle',
      pass: async () => {
        await runPass();
      },
    });

  async function runPass(): Promise<readonly IdleSweepResult[]> {
    try {
      return await deps.sweeper.sweep();
    } catch (error: unknown) {
      try {
        deps.logger.error('consumer-idle-scheduler.sweep-failed', {
          name: 'consumer-idle',
          reason: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Отказ журнала не должен менять результат прохода.
      }
      return [];
    }
  }

  return {
    start(): void {
      runner.start();
    },
    stop(): Promise<void> {
      return runner.stop();
    },
    runPass,
  };
}
