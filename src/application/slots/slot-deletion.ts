import type { SlotId } from '../../domain/slot.js';
import type { SlotRegistry } from '../../domain/slots/slot-registry.js';
import type { WaitRegistry } from '../waiting/wait-registry.js';
import type { SlotDeletionResult } from '../results/slot.js';

export interface SlotDeletionService {
  delete(slotId: SlotId): Promise<SlotDeletionResult>;
}

/**
 * Создаёт сервис ручного удаления слотов.
 *
 * Удаление не закрывает консюмер: жизненный цикл консюмера управляется отдельно.
 * Изменение реестра, очистка накопителей и завершение ожиданий выполняются одним
 * синхронным атомарным участком до разрешения возвращаемого обещания.
 */
export function createSlotDeletionService(deps: {
  readonly registry: SlotRegistry;
  readonly waits: WaitRegistry;
}): SlotDeletionService {
  const deleteSlot = async (slotId: SlotId): Promise<SlotDeletionResult> => {
    const registered = deps.registry.remove(slotId);
    if (registered === undefined) {
      return { kind: 'not-found' };
    }

    for (const accumulator of registered.accumulators) {
      accumulator.clear();
    }
    deps.waits.settleSlot(slotId, 'slot-deleted');

    return { kind: 'deleted' };
  };

  return { delete: deleteSlot };
}
