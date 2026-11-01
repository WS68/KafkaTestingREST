import type { SlotId } from './slot.js';

export type WaitOutcome = 'condition' | 'timeout' | 'slot-deleted' | 'service-stopping';

export interface WaitRequest {
  readonly slotId: SlotId;
  readonly checkIndex: number;
  readonly requiredCount: number;
  readonly timeoutMs: number;
}

/** Однократное ожидание с результатом, который появляется при завершении. */
export interface WaitHandle {
  readonly id: string;
  readonly request: WaitRequest;
  readonly outcome: WaitOutcome | undefined;
  /** Ссылка на отмену таймера освобождается при любом исходе ожидания. */
  readonly cancelTimeout: (() => void) | undefined;
}
