import type { SlotId } from '../../domain/slot.js';
import type { SlotRegistry } from '../../domain/slots/slot-registry.js';
import type { WaitOutcome, WaitRequest } from '../../domain/wait.js';
import { representRecord } from '../reading/represent-record.js';
import type { WaitRegistry } from '../waiting/wait-registry.js';
import type { CountResult } from '../results/slot.js';
import type { ReadResult } from '../results/reading.js';
import type { WaitResult } from '../results/waiting.js';

export interface SlotQueryService {
  count(slotId: SlotId, checkIndex: number): Promise<CountResult>;
  read(slotId: SlotId, checkIndex: number, offset: number, limit: number): Promise<ReadResult>;
  wait(
    slotId: SlotId,
    checkIndex: number,
    request: { readonly n: number; readonly timeoutMs: number },
  ): Promise<WaitResult>;
}

/**
 * Создаёт фасад операций чтения состояния слота.
 *
 * Срок слота здесь намеренно не проверяется: слот, который уже истёк, но ещё
 * не удалён планировщиком, остаётся доступным до фактического удаления.
 */
export function createSlotQueryService(deps: {
  readonly registry: SlotRegistry;
  readonly waits: WaitRegistry;
}): SlotQueryService {
  const count = async (slotId: SlotId, checkIndex: number): Promise<CountResult> => {
    if (!isValidCheckIndex(checkIndex)) return { kind: 'check-not-found' };

    const registered = deps.registry.get(slotId);
    if (registered === undefined) return { kind: 'slot-not-found' };
    if (checkIndex >= registered.accumulators.length) return { kind: 'check-not-found' };

    const accumulator = registered.accumulators[checkIndex];
    if (accumulator === undefined) return { kind: 'check-not-found' };
    return { kind: 'counted', count: accumulator.count() };
  };

  const read = async (
    slotId: SlotId,
    checkIndex: number,
    offset: number,
    limit: number,
  ): Promise<ReadResult> => {
    if (!isValidCheckIndex(checkIndex)) return { kind: 'check-not-found' };
    if (offset < 0 || limit <= 0) return { kind: 'invalid-pagination' };

    const registered = deps.registry.get(slotId);
    if (registered === undefined) return { kind: 'slot-not-found' };
    if (checkIndex >= registered.accumulators.length) return { kind: 'check-not-found' };

    const accumulator = registered.accumulators[checkIndex];
    if (accumulator === undefined) return { kind: 'check-not-found' };
    const records = accumulator.snapshot(offset, limit);
    for (const record of records) {
      if (representRecord(record).kind !== 'ok') return { kind: 'not-representable' };
    }

    return { kind: 'records', records };
  };

  const wait = async (
    slotId: SlotId,
    checkIndex: number,
    request: { readonly n: number; readonly timeoutMs: number },
  ): Promise<WaitResult> => {
    if (!isValidCheckIndex(checkIndex)) return { kind: 'invalid-request' };
    if (request.n < 1 || request.timeoutMs <= 0) return { kind: 'invalid-request' };

    const registered = deps.registry.get(slotId);
    if (registered === undefined) return { kind: 'slot-not-found' };
    if (checkIndex >= registered.accumulators.length) return { kind: 'check-not-found' };

    const accumulator = registered.accumulators[checkIndex];
    if (accumulator === undefined) return { kind: 'check-not-found' };
    const waitRequest: WaitRequest = {
      slotId,
      checkIndex,
      requiredCount: request.n,
      timeoutMs: request.timeoutMs,
    };
    const outcome = await deps.waits.register(waitRequest, () => accumulator.count());
    return mapWaitOutcome(outcome);
  };

  return { count, read, wait };
}

function isValidCheckIndex(checkIndex: number): boolean {
  return Number.isSafeInteger(checkIndex) && checkIndex >= 0;
}

function mapWaitOutcome(outcome: WaitOutcome): WaitResult {
  switch (outcome) {
    case 'condition':
      return { kind: 'condition-met' };
    case 'timeout':
      return { kind: 'timeout' };
    case 'slot-deleted':
      return { kind: 'slot-deleted' };
    case 'service-stopping':
      return { kind: 'service-stopping' };
  }
}
