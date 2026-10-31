import { randomUUID } from 'node:crypto';
import type { IdSource } from '../../application/ports/ids.js';
import type { SlotId } from '../../domain/slot.js';

/** Создаёт идентификаторы приложения на основе криптографического UUID. */
export function createSystemIds(): IdSource {
  return {
    newSlotId(): SlotId {
      return randomUUID();
    },
    newWaitId(): string {
      return randomUUID();
    },
    newRunId(): string {
      return randomUUID();
    },
  };
}
