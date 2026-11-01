import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { SlotDeletionService } from '../slots/slot-deletion.js';
import type { SlotRegistry } from '../../domain/slots/slot-registry.js';
import { createPeriodicRunner } from './periodic-runner.js';
import type { PeriodicRunner } from './periodic-runner.js';

export interface SlotCleanupScheduler {
  start(): void;
  stop(): Promise<void>;
  /** Выполняет один проход очистки (для тестов и ручного запуска). */
  runPass(): Promise<readonly string[]>;
}

export function createSlotCleanupScheduler(deps: {
  readonly registry: SlotRegistry;
  readonly deletion: SlotDeletionService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runner?: PeriodicRunner;
}): SlotCleanupScheduler {
  // Очистка выполняется раз в минуту; интервал намеренно не настраивается.
  const intervalMs = 60_000;

  const cleanExpiredSlots = async (): Promise<readonly string[]> => {
    const slots = deps.registry.listAll();
    const now = deps.clock.now();
    const deletedSlotIds: string[] = [];

    for (const { slot } of slots) {
      if (now < slot.expiresAt) continue;

      try {
        const result = await deps.deletion.delete(slot.id);
        if (result.kind === 'deleted') deletedSlotIds.push(slot.id);
      } catch (error: unknown) {
        try {
          deps.logger.error('slot-cleanup.delete-failed', {
            slotId: slot.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Отказ журнала не должен прерывать очистку остальных слотов.
        }
      }
    }

    return deletedSlotIds;
  };

  const runner =
    deps.runner ??
    createPeriodicRunner({
      clock: deps.clock,
      logger: deps.logger,
      intervalMs,
      name: 'slot-cleanup',
      pass: async () => {
        await cleanExpiredSlots();
      },
    });

  return {
    start(): void {
      runner.start();
    },
    stop(): Promise<void> {
      return runner.stop();
    },
    runPass(): Promise<readonly string[]> {
      return cleanExpiredSlots();
    },
  };
}
