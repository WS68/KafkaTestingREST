import { matchesCheck } from '../../domain/checking/check.js';
import type { SourceRecord } from '../../domain/record.js';
import type { SlotRegistry } from '../../domain/slots/slot-registry.js';
import type { SlotId } from '../../domain/slot.js';
import type { WaitRegistry } from '../waiting/wait-registry.js';

export interface RecordRouter {
  route(topic: string, record: SourceRecord): void;
}

/**
 * Маршрутизатор синхронно пополняет накопители активных слотов и уведомляет ожидания.
 * Он не публикует запись, не завершает HTTP-запрос публикации и не изменяет её результат.
 */
export function createRecordRouter(deps: {
  readonly registry: SlotRegistry;
  readonly waits: WaitRegistry;
}): RecordRouter {
  const route = (topic: string, record: SourceRecord): void => {
    const slots = deps.registry.listByTopic(topic);
    if (slots.length === 0) return;

    for (const slot of slots) {
      const slotId = slot.slot.id;
      let slotIsCurrent = isCurrentSlot(slotId);
      if (!slotIsCurrent) continue;

      for (let checkIndex = 0; checkIndex < slot.accumulators.length; checkIndex += 1) {
        const accumulator = slot.accumulators[checkIndex];
        if (accumulator === undefined) continue;

        let matches = false;
        try {
          matches = matchesCheck(record, accumulator.check);
        } catch {
          continue;
        }
        if (!matches) continue;

        // Повторная проверка не позволяет использовать снимок после удаления слота.
        slotIsCurrent = isCurrentSlot(slotId);
        if (!slotIsCurrent) break;

        let appended = false;
        try {
          appended = deps.registry.appendToCheck(slotId, checkIndex, record).kind === 'ok';
        } catch {
          continue;
        }
        if (!appended) continue;

        try {
          deps.waits.notifyAccumulated(slotId, checkIndex);
        } catch {
          // Ошибка уведомления не должна прерывать маршрутизацию остальных проверок.
        }
      }
    }
  };

  const isCurrentSlot = (slotId: SlotId): boolean => {
    try {
      return deps.registry.get(slotId) !== undefined && !deps.registry.isDeleted(slotId);
    } catch {
      return false;
    }
  };

  return { route };
}
