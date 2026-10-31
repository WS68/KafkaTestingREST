import type { CompiledCheck } from '../../domain/check.js';
import type { SlotId } from '../../domain/slot.js';
import { prepareCheck } from '../../domain/checking/check.js';
import type { CheckInput } from '../../domain/checking/check.js';
import type { SlotRegistry } from '../../domain/slots/slot-registry.js';
import type { Clock } from '../ports/clock.js';
import type { IdSource } from '../ports/ids.js';
import type { ConsumerManager } from '../consumers/consumer-manager.js';
import type { SlotRegistrationResult } from '../results/slot.js';

export type SlotCheckInput = CheckInput;

export interface SlotRegistrationService {
  /**
   * Регистрирует слот после готовности наблюдения. Успех не гарантирует получение
   * записей, обработанных до регистрации: чтение начинается с конца разделов при
   * создании консюмера.
   */
  register(input: {
    readonly topic: string;
    readonly checks: readonly SlotCheckInput[];
    readonly autoDeleteSeconds?: number;
  }): Promise<SlotRegistrationResult>;
}

export function createSlotRegistrationService(deps: {
  readonly registry: SlotRegistry;
  readonly consumers: ConsumerManager;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly getDefaultAutoDeleteSeconds: () => number;
}): SlotRegistrationService {
  const register = async (input: {
    readonly topic: string;
    readonly checks: readonly SlotCheckInput[];
    readonly autoDeleteSeconds?: number;
  }): Promise<SlotRegistrationResult> => {
    const checks: CompiledCheck[] = [];
    for (const checkInput of input.checks) {
      const prepared = prepareCheck(checkInput);
      if (prepared.kind === 'invalid-json-path') return { kind: 'invalid-request' };
      checks.push(prepared.check);
    }

    const autoDeleteSeconds = input.autoDeleteSeconds ?? deps.getDefaultAutoDeleteSeconds();
    if (!Number.isSafeInteger(autoDeleteSeconds) || autoDeleteSeconds <= 0) {
      return { kind: 'invalid-request' };
    }

    let reservation: ReturnType<ConsumerManager['reserve']> | undefined;
    let released = false;
    const release = (): void => {
      if (reservation !== undefined && !released) {
        released = true;
        deps.consumers.release(reservation);
      }
    };
    try {
      reservation = deps.consumers.reserve(input.topic, autoDeleteSeconds);
      await deps.consumers.ensureReady(reservation);
    } catch {
      release();
      return { kind: 'kafka-unavailable' };
    }

    let now: number;
    let expiresAt: number;
    try {
      now = deps.clock.now();
      expiresAt = now + autoDeleteSeconds * 1000;
    } catch {
      release();
      return { kind: 'kafka-unavailable' };
    }
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(autoDeleteSeconds * 1000) ||
      !Number.isSafeInteger(expiresAt)
    ) {
      release();
      return { kind: 'invalid-request' };
    }

    let slotId: SlotId;
    try {
      slotId = deps.ids.newSlotId();
      const result = deps.registry.register({ id: slotId, topic: input.topic, checks, expiresAt });
      if (result.kind === 'duplicate-id') {
        release();
        return { kind: 'invalid-request' };
      }

      try {
        deps.consumers.extend(input.topic, autoDeleteSeconds);
      } catch {
        deps.registry.remove(slotId);
        release();
        return { kind: 'kafka-unavailable' };
      }
      release();
      return { kind: 'registered', slotId, checkCount: checks.length };
    } catch {
      release();
      return { kind: 'kafka-unavailable' };
    }
  };

  return { register };
}
