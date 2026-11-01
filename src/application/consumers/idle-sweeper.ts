import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { ConsumerManager, IdleCloseOutcome } from './consumer-manager.js';

export interface IdleSweepResult {
  readonly topic: string;
  readonly outcome: IdleCloseOutcome | 'failed';
}

export interface IdleSweeper {
  sweep(): Promise<readonly IdleSweepResult[]>;
}

export function createIdleSweeper(deps: {
  readonly manager: ConsumerManager;
  readonly clock: Clock;
  readonly hasActiveSlots: (topic: string) => boolean;
  readonly getExpiry: (topic: string) => number | undefined;
  readonly topics: () => readonly string[];
  readonly logger: Logger;
}): IdleSweeper {
  return {
    async sweep(): Promise<readonly IdleSweepResult[]> {
      // Снимок используется только для обхода; условия закрытия менеджер проверит заново.
      const topics = deps.topics();
      const sweepStartedAt = deps.clock.now();
      const results: IdleSweepResult[] = [];
      for (const topic of topics) {
        try {
          const expiry = deps.getExpiry(topic);
          if (expiry === undefined || deps.clock.now() <= expiry) continue;
          const outcome = await deps.manager.tryCloseIdle(topic, () => deps.hasActiveSlots(topic));
          results.push({ topic, outcome });
        } catch (error: unknown) {
          results.push({ topic, outcome: 'failed' });
          try {
            deps.logger.error('consumer-idle-close-failed', {
              topic,
              sweepStartedAt,
              reason: error instanceof Error ? error.message : 'unknown-error',
            });
          } catch {
            // Отказ журнала не должен прерывать обработку остальных топиков.
          }
        }
      }
      return results;
    },
  };
}
