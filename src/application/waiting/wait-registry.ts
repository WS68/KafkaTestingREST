import type { Clock } from '../ports/clock.js';
import type { IdSource } from '../ports/ids.js';
import type { SlotId } from '../../domain/slot.js';
import type { WaitHandle, WaitOutcome, WaitRequest } from '../../domain/wait.js';

/** Причина вызова обработчика завершения ожидания. */
export type WaitSettledReason = 'settled' | 'cancelled';

/**
 * Ошибка локальной отмены ожидания.
 *
 * Реестр не подписывается на отклонённое при отмене обещание. Вызывающая сторона
 * должна обработать его, если отмена произошла после регистрации ожидания.
 */
export class WaitCancelledError extends Error {
  readonly waitId: string;

  constructor(waitId: string) {
    super(`Wait ${waitId} was cancelled`);
    this.name = 'WaitCancelledError';
    this.waitId = waitId;
  }
}

/**
 * Вызывается после удаления ожидания из реестра и освобождения его таймера.
 * При локальной отмене `outcome` равен `undefined`, а `reason` равен `cancelled`.
 */
export type WaitSettledCallback = (
  handle: WaitHandle,
  outcome: WaitOutcome | undefined,
  reason: WaitSettledReason,
) => void;

export interface WaitRegistry {
  /** Регистрирует ожидание и возвращает его идентификатор вместе с результатом. */
  registerWithHandle(
    request: WaitRequest,
    checkCount: () => number,
  ): { readonly waitId: string; readonly result: Promise<WaitOutcome> };
  /**
   * Регистрирует ожидание; при уже выполненном условии — разрешается немедленно.
   * При локальной отмене обещание отклоняется с `WaitCancelledError`; вызывающая
   * сторона отвечает за обработку этого отклонения.
   */
  register(request: WaitRequest, checkCount: () => number): Promise<WaitOutcome>;
  /** Уведомить, что под проверку добавлена запись. */
  notifyAccumulated(slotId: SlotId, checkIndex: number): void;
  /** Завершить все ожидания слота заданным исходом (используется задачей 34). */
  settleSlot(slotId: SlotId, outcome: WaitOutcome): void;
  /** Завершить все ожидания сервиса исходом остановки (задача 34). */
  settleAll(outcome: WaitOutcome): void;
  /** Локально отменить ожидание без изменения слота и накопления. */
  cancel(waitId: string): boolean;
  /** Число незавершённых ожиданий (для проверок и остановки). */
  pendingCount(): number;
  /** Снимок идентификаторов и запросов незавершённых ожиданий. */
  pending(): readonly { readonly id: string; readonly request: WaitRequest }[];
}

interface PendingWait {
  readonly handle: MutableWaitHandle;
  readonly checkCount: () => number;
  readonly resolve: (outcome: WaitOutcome) => void;
  readonly reject: (error: WaitCancelledError) => void;
  settled: boolean;
}

type MutableWaitHandle = {
  readonly id: string;
  readonly request: WaitRequest;
  outcome: WaitOutcome | undefined;
  cancelTimeout: (() => void) | undefined;
};

export function createWaitRegistry(options: {
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly onSettled?: WaitSettledCallback;
}): WaitRegistry {
  const pendingWaits = new Map<string, PendingWait>();

  const settle = (waits: readonly PendingWait[], outcome: WaitOutcome): void => {
    const settling: PendingWait[] = [];

    for (const wait of waits) {
      if (wait.settled) {
        continue;
      }

      wait.settled = true;
      wait.handle.cancelTimeout?.();
      wait.handle.cancelTimeout = undefined;
      wait.handle.outcome = outcome;
      pendingWaits.delete(wait.handle.id);
      settling.push(wait);
    }

    // Сначала удаляем все записи, затем разрешаем результаты после изменения состояния.
    for (const wait of settling) {
      wait.resolve(outcome);
    }

    for (const wait of settling) {
      options.onSettled?.(wait.handle, outcome, 'settled');
    }
  };

  const registerWithHandle = (
    request: WaitRequest,
    checkCount: () => number,
  ): { readonly waitId: string; readonly result: Promise<WaitOutcome> } => {
    let resolve!: (outcome: WaitOutcome) => void;
    let reject!: (error: WaitCancelledError) => void;
    const promise = new Promise<WaitOutcome>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const handle: MutableWaitHandle = {
      id: options.ids.newWaitId(),
      request,
      outcome: undefined,
      cancelTimeout: undefined,
    };
    const wait: PendingWait = { handle, checkCount, resolve, reject, settled: false };

    // Проверка и добавление выполняются синхронно: между ними нет await.
    if (checkCount() >= request.requiredCount) {
      settle([wait], 'condition');
      return { waitId: handle.id, result: promise };
    }

    pendingWaits.set(handle.id, wait);
    const timeoutTask = options.clock.schedule(request.timeoutMs, () => settle([wait], 'timeout'));
    if (wait.settled) {
      timeoutTask.cancel();
    } else {
      handle.cancelTimeout = () => timeoutTask.cancel();
    }
    return { waitId: handle.id, result: promise };
  };

  const register = (request: WaitRequest, checkCount: () => number): Promise<WaitOutcome> =>
    registerWithHandle(request, checkCount).result;

  const notifyAccumulated = (slotId: SlotId, checkIndex: number): void => {
    const completed: PendingWait[] = [];

    for (const wait of pendingWaits.values()) {
      const { request } = wait.handle;
      if (
        request.slotId === slotId &&
        request.checkIndex === checkIndex &&
        wait.checkCount() >= request.requiredCount
      ) {
        completed.push(wait);
      }
    }

    settle(completed, 'condition');
  };

  const settleSlot = (slotId: SlotId, outcome: WaitOutcome): void => {
    const waits = [...pendingWaits.values()].filter(
      (wait) => wait.handle.request.slotId === slotId,
    );
    settle(waits, outcome);
  };

  const settleAll = (outcome: WaitOutcome): void => {
    settle([...pendingWaits.values()], outcome);
  };

  const cancel = (waitId: string): boolean => {
    const wait = pendingWaits.get(waitId);
    if (wait === undefined || wait.settled) {
      return false;
    }

    wait.settled = true;
    wait.handle.cancelTimeout?.();
    wait.handle.cancelTimeout = undefined;
    wait.handle.outcome = undefined;
    pendingWaits.delete(wait.handle.id);
    wait.reject(new WaitCancelledError(wait.handle.id));
    options.onSettled?.(wait.handle, undefined, 'cancelled');
    return true;
  };

  return {
    register,
    registerWithHandle,
    notifyAccumulated,
    settleSlot,
    settleAll,
    cancel,
    pendingCount: () => pendingWaits.size,
    pending: () =>
      [...pendingWaits.values()].map(({ handle }) => ({
        id: handle.id,
        request: handle.request,
      })),
  };
}
