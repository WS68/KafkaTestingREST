import type { CompiledCheck } from '../check.js';
import { createCheckAccumulator } from '../accumulation/index.js';
import type { CheckAccumulatorStore } from '../accumulation/index.js';
import type { SourceRecord } from '../record.js';
import type { Slot, SlotId } from '../slot.js';

/** Слот, полностью подготовленный до передачи в реестр. */
export interface PreparedSlot {
  readonly id: SlotId;
  readonly topic: string;
  readonly checks: readonly CompiledCheck[];
  readonly expiresAt: number;
}

/** Зарегистрированный слот и независимые накопители его проверок. */
export interface RegisteredSlot {
  readonly slot: Slot;
  readonly accumulators: readonly CheckAccumulatorStore[];
}

/** Результат регистрации подготовленного слота. */
export type SlotRegistrationResult =
  { readonly kind: 'ok'; readonly slot: RegisteredSlot } | { readonly kind: 'duplicate-id' };

/** Результат добавления записи в проверку актуального слота. */
export type AppendToCheckResult =
  | { readonly kind: 'ok'; readonly count: number }
  | { readonly kind: 'slot-not-found' }
  | { readonly kind: 'check-not-found' };

export interface SlotRegistry {
  register(prepared: PreparedSlot): SlotRegistrationResult;
  get(slotId: SlotId): RegisteredSlot | undefined;
  listByTopic(topic: string): readonly RegisteredSlot[];
  listAll(): readonly RegisteredSlot[];
  remove(slotId: SlotId): RegisteredSlot | undefined;
  isDeleted(slotId: SlotId): boolean;
  appendToCheck(slotId: SlotId, checkIndex: number, record: SourceRecord): AppendToCheckResult;
  size(): number;
}

export function createSlotRegistry(): SlotRegistry {
  const byId = new Map<SlotId, RegisteredSlot>();
  const byTopic = new Map<string, Set<RegisteredSlot>>();
  const deletedSlotIds = new Set<SlotId>();

  return {
    register(prepared): SlotRegistrationResult {
      const registered = createRegisteredSlot(prepared);

      if (byId.has(prepared.id)) {
        return { kind: 'duplicate-id' };
      }

      const slotsForTopic = byTopic.get(prepared.topic) ?? new Set<RegisteredSlot>();

      // Все объекты подготовлены до изменения индексов; вызовы синхронны.
      byId.set(prepared.id, registered);
      slotsForTopic.add(registered);
      byTopic.set(prepared.topic, slotsForTopic);
      deletedSlotIds.delete(prepared.id);

      return { kind: 'ok', slot: registered };
    },

    get(slotId): RegisteredSlot | undefined {
      return byId.get(slotId);
    },

    listByTopic(topic): readonly RegisteredSlot[] {
      const slots = byTopic.get(topic);
      return slots === undefined ? [] : [...slots];
    },

    listAll(): readonly RegisteredSlot[] {
      return [...byId.values()];
    },

    remove(slotId): RegisteredSlot | undefined {
      const registered = byId.get(slotId);
      if (registered === undefined) {
        return undefined;
      }

      byId.delete(slotId);
      deletedSlotIds.add(slotId);

      const slotsForTopic = byTopic.get(registered.slot.topic);
      if (slotsForTopic !== undefined) {
        slotsForTopic.delete(registered);
        if (slotsForTopic.size === 0) {
          byTopic.delete(registered.slot.topic);
        }
      }

      return registered;
    },

    isDeleted(slotId): boolean {
      return deletedSlotIds.has(slotId);
    },

    appendToCheck(slotId, checkIndex, record): AppendToCheckResult {
      const registered = byId.get(slotId);
      if (registered === undefined || deletedSlotIds.has(slotId)) {
        return { kind: 'slot-not-found' };
      }

      const accumulator = registered.accumulators[checkIndex];
      if (accumulator === undefined) {
        return { kind: 'check-not-found' };
      }

      return { kind: 'ok', count: accumulator.append(record) };
    },

    size(): number {
      return byId.size;
    },
  };
}

function createRegisteredSlot(prepared: PreparedSlot): RegisteredSlot {
  const slot: Slot = {
    id: prepared.id,
    topic: prepared.topic,
    checks: prepared.checks,
    expiresAt: prepared.expiresAt,
    deleted: false,
  };

  return {
    slot,
    accumulators: prepared.checks.map(createCheckAccumulator),
  };
}
