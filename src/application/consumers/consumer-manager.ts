import type { ConsumerLifecycleState } from '../../domain/consumer.js';
import type { SourceRecord } from '../../domain/record.js';
import type { Clock } from '../ports/clock.js';
import type {
  KafkaConsumerFactory,
  KafkaGroupAdmin,
  ReadyConsumer,
} from '../ports/kafka-consumer.js';
import type { Logger } from '../ports/logger.js';

export interface Reservation {
  readonly topic: string;
  readonly generation: number;
}

export interface ConsumerHandle {
  readonly topic: string;
  readonly generation: number;
  readonly readyConsumer: ReadyConsumer;
}

export type IdleCloseOutcome =
  | 'closed'
  | 'skipped-not-expired'
  | 'skipped-active-slots'
  | 'skipped-reservations'
  | 'skipped-not-ready';

export interface ConsumerManager {
  /** Возвращает снимок топиков с зарегистрированными поколениями консюмеров. */
  listTopics(): readonly string[];
  /** Возвращает срок удаления консюмера или undefined, если топик отсутствует. */
  getExpiresAt(topic: string): number | undefined;
  /** Резервирует открытие слота: создаёт (или присоединяется к созданию) и продлевает срок. */
  reserve(topic: string, autoDeleteSeconds: number): Reservation;
  /** Ожидает готовности консюмера, соответствующего резервированию. */
  ensureReady(reservation: Reservation): Promise<ConsumerHandle>;
  /** Освобождает резервирование ровно один раз (успех или отказ). */
  release(reservation: Reservation): void;
  /** Продлевает срок по эффективному сроку слота (только в сторону увеличения). */
  extend(topic: string, autoDeleteSeconds: number): void;
  /** Проверяет наличие открытий, ещё не зарегистрировавших слот. */
  hasActiveReservations(topic: string): boolean;
  /** Возвращает текущее состояние консюмера топика. */
  getState(topic: string): ConsumerLifecycleState;
  /** Проверяет условия бездействия и начинает закрытие в одном синхронном участке. */
  tryCloseIdle(topic: string, hasActiveSlots: () => boolean): Promise<IdleCloseOutcome>;
  /** Закрывает готового консюмера; при отказе закрытия новые открытия остаются заблокированы. */
  close(topic: string, reason: string): Promise<void>;
  /** Последовательно закрывает все готовые консюмеры, не прерываясь при отказах. */
  closeAll(reason: string): Promise<void>;
}

interface ConsumerEntry {
  readonly topic: string;
  readonly generation: number;
  readonly reservations: Set<Reservation>;
  state: ConsumerLifecycleState;
  expiresAt: number;
  activeReservations: number;
  creationPromise?: Promise<ConsumerHandle>;
  handle?: ConsumerHandle;
  cleanupPromise?: Promise<void>;
  closePromise?: Promise<void>;
  creationStarted?: boolean;
}

interface FailureWithPartialConsumer {
  readonly partialConsumer?: unknown;
}

interface TopicBarrier {
  readonly generation: number;
  readonly promise: Promise<void>;
  readonly release: () => void;
  closePromise?: Promise<void>;
}

export function createConsumerManager(deps: {
  readonly factory: KafkaConsumerFactory;
  readonly groupAdmin: KafkaGroupAdmin;
  readonly clock: Clock;
  readonly getIdleSeconds: () => number;
  readonly getGroupId: (topic: string) => string;
  readonly onRecord: (record: SourceRecord) => Promise<void>;
  readonly logger: Logger;
}): ConsumerManager {
  const entries = new Map<string, ConsumerEntry>();
  const barriers = new Map<string, TopicBarrier>();
  const pendingOpenings = new Map<string, ConsumerEntry>();
  let nextGeneration = 0;

  const log = (
    level: 'warn' | 'error',
    event: string,
    fields: Record<string, string | number>,
  ): void => {
    try {
      deps.logger[level](event, fields);
    } catch {
      // Отказ журнала не должен изменить состояние менеджера.
    }
  };

  const expiration = (topic: string, autoDeleteSeconds: number): number | undefined => {
    const now = deps.clock.now();
    const idleMs = deps.getIdleSeconds() * 1000;
    const slotMs = autoDeleteSeconds * 1000;
    const candidate = now + idleMs + slotMs;

    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(idleMs) ||
      !Number.isSafeInteger(slotMs) ||
      !Number.isSafeInteger(candidate)
    ) {
      log('warn', 'consumer-expiration-overflow', { topic });
      return undefined;
    }
    return candidate;
  };

  const extendEntry = (entry: ConsumerEntry, autoDeleteSeconds: number): void => {
    const candidate = expiration(entry.topic, autoDeleteSeconds);
    if (candidate !== undefined && candidate > entry.expiresAt) {
      entry.expiresAt = candidate;
    }
  };

  const partialConsumer = (error: unknown): ReadyConsumer | undefined => {
    if (typeof error !== 'object' || error === null) return undefined;
    const candidate = (error as FailureWithPartialConsumer).partialConsumer;
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    if (typeof (candidate as ReadyConsumer).close !== 'function') return undefined;
    return candidate as ReadyConsumer;
  };

  const cleanupFailedCreation = async (entry: ConsumerEntry, error: unknown): Promise<void> => {
    const client = partialConsumer(error);
    try {
      // Обычно частичный клиент уже освобождён фабрикой до её отказа. Поле
      // partialConsumer поддерживает фабрики, передающие владение менеджеру.
      if (client !== undefined) await client.close();
    } catch {
      log('error', 'consumer-failed-creation-cleanup-failed', {
        topic: entry.topic,
        generation: entry.generation,
      });
      return;
    }

    if (entries.get(entry.topic) === entry && entry.state === 'cleaning-failed-creation') {
      entries.delete(entry.topic);
    }
  };

  const initialize = async (entry: ConsumerEntry): Promise<ConsumerHandle> => {
    try {
      const readyConsumer = await deps.factory.create(
        entry.topic,
        deps.getGroupId(entry.topic),
        deps.onRecord,
      );
      if (entries.get(entry.topic) !== entry) {
        throw new Error('устаревшее поколение консюмера');
      }

      entry.state = 'ready';
      entry.handle = Object.freeze({
        topic: entry.topic,
        generation: entry.generation,
        readyConsumer,
      });
      return entry.handle;
    } catch (error: unknown) {
      if (entries.get(entry.topic) === entry) {
        entry.state = 'cleaning-failed-creation';
        entry.activeReservations = 0;
        entry.reservations.clear();
        entry.cleanupPromise = cleanupFailedCreation(entry, error);
      }
      throw error;
    }
  };

  const startCreation = (entry: ConsumerEntry): Promise<ConsumerHandle> => {
    if (entry.creationPromise !== undefined) return entry.creationPromise;
    if (entry.creationStarted) throw new Error('Создание консюмера уже запущено');
    entry.creationStarted = true;
    const creationPromise = initialize(entry);
    entry.creationPromise = creationPromise;
    void creationPromise.catch(() => undefined);
    return creationPromise;
  };

  const createEntry = (
    topic: string,
    autoDeleteSeconds: number,
    generation = ++nextGeneration,
  ): ConsumerEntry => {
    const entry: ConsumerEntry = {
      topic,
      generation,
      reservations: new Set<Reservation>(),
      state: 'creating',
      expiresAt: 0,
      activeReservations: 0,
    };
    entries.set(topic, entry);
    const reservation: Reservation = Object.freeze({ topic, generation: entry.generation });
    entry.reservations.add(reservation);
    entry.activeReservations = 1;
    extendEntry(entry, autoDeleteSeconds);
    startCreation(entry);
    return entry;
  };

  const reserve = (topic: string, autoDeleteSeconds: number): Reservation => {
    let entry = entries.get(topic);
    const barrier = barriers.get(topic);
    if (barrier !== undefined) {
      let pending = pendingOpenings.get(topic);
      if (pending === undefined) {
        pending = {
          topic,
          generation: ++nextGeneration,
          reservations: new Set<Reservation>(),
          state: 'creating',
          expiresAt: 0,
          activeReservations: 0,
          creationStarted: false,
        };
        pendingOpenings.set(topic, pending);
      }
      const reservation = Object.freeze({ topic, generation: pending.generation });
      pending.reservations.add(reservation);
      pending.activeReservations += 1;
      extendEntry(pending, autoDeleteSeconds);
      return reservation;
    }
    if (entry === undefined) {
      entry = createEntry(topic, autoDeleteSeconds);
      return [...entry.reservations][0]!;
    }
    if (entry.state !== 'creating' && entry.state !== 'ready') {
      throw new Error(`Консюмер топика ${topic} недоступен: ${entry.state}`);
    }

    const reservation = Object.freeze({ topic, generation: entry.generation });
    entry.reservations.add(reservation);
    entry.activeReservations += 1;
    extendEntry(entry, autoDeleteSeconds);
    return reservation;
  };

  return {
    listTopics(): readonly string[] {
      return [...entries.keys()];
    },
    getExpiresAt(topic): number | undefined {
      return entries.get(topic)?.expiresAt;
    },
    reserve,
    async ensureReady(reservation): Promise<ConsumerHandle> {
      let entry = entries.get(reservation.topic);
      if (entry === undefined || entry.generation !== reservation.generation) {
        const pending = pendingOpenings.get(reservation.topic);
        if (
          pending === undefined ||
          pending.generation !== reservation.generation ||
          !pending.reservations.has(reservation)
        ) {
          throw new Error('Резервирование консюмера устарело');
        }
        const barrier = barriers.get(reservation.topic);
        if (barrier !== undefined) await barrier.promise;
        entry = entries.get(reservation.topic);
        if (entry === undefined) {
          const newEntry = createEntry(reservation.topic, 0, pending.generation);
          newEntry.reservations.clear();
          for (const item of pending.reservations) newEntry.reservations.add(item);
          newEntry.activeReservations = pending.activeReservations;
          newEntry.expiresAt = pending.expiresAt;
          pendingOpenings.delete(reservation.topic);
          entry = newEntry;
        }
      }
      if (entry.generation !== reservation.generation || !entry.reservations.has(reservation)) {
        throw new Error('Резервирование консюмера уже освобождено');
      }
      return entry.handle ?? entry.creationPromise!;
    },
    release(reservation): void {
      const entry = entries.get(reservation.topic);
      if (entry === undefined || entry.generation !== reservation.generation) {
        const pending = pendingOpenings.get(reservation.topic);
        if (
          pending?.generation === reservation.generation &&
          pending.reservations.delete(reservation)
        ) {
          pending.activeReservations -= 1;
        }
        return;
      }
      if (!entry.reservations.delete(reservation)) return;
      entry.activeReservations -= 1;
    },
    extend(topic, autoDeleteSeconds): void {
      const entry = entries.get(topic) ?? pendingOpenings.get(topic);
      if (entry === undefined || entry.state === 'cleaning-failed-creation') return;
      extendEntry(entry, autoDeleteSeconds);
    },
    hasActiveReservations(topic): boolean {
      return (
        (entries.get(topic)?.activeReservations ?? 0) > 0 ||
        (pendingOpenings.get(topic)?.activeReservations ?? 0) > 0
      );
    },
    getState(topic): ConsumerLifecycleState {
      return entries.get(topic)?.state ?? 'absent';
    },
    async tryCloseIdle(topic, hasActiveSlots): Promise<IdleCloseOutcome> {
      const entry = entries.get(topic);
      if (entry === undefined || entry.state !== 'ready' || entry.handle === undefined) {
        return 'skipped-not-ready';
      }
      if (deps.clock.now() <= entry.expiresAt) return 'skipped-not-expired';
      if (hasActiveSlots()) return 'skipped-active-slots';
      if (this.hasActiveReservations(topic)) return 'skipped-reservations';

      await this.close(topic, 'idle');
      return 'closed';
    },
    close(topic, reason): Promise<void> {
      const entry = entries.get(topic);
      if (entry === undefined || entry.state !== 'ready' || entry.handle === undefined) {
        const barrier = barriers.get(topic);
        if (barrier?.closePromise !== undefined) return barrier.closePromise;
        if (entry?.state === 'closing' && entry.closePromise !== undefined)
          return entry.closePromise;
        return Promise.resolve();
      }

      entry.state = 'closing';
      entry.activeReservations = 0;
      entry.reservations.clear();
      let releaseBarrier!: () => void;
      const barrierPromise = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const barrier: TopicBarrier = {
        generation: entry.generation,
        promise: barrierPromise,
        release: releaseBarrier,
      };
      barriers.set(topic, barrier);

      const closePromise = (async (): Promise<void> => {
        try {
          // При отказе закрытия запись и барьер сохраняются; новые открытия ожидают барьер.
          await entry.handle!.readyConsumer.close();
        } catch {
          log('error', 'consumer-close-failed', {
            topic,
            generation: entry.generation,
            reason,
          });
          throw new Error(`Не удалось закрыть консюмера топика ${topic}`);
        }

        entry.state = 'deleting-group';
        try {
          const result = await deps.groupAdmin.deleteGroup(deps.getGroupId(topic));
          if (result.kind === 'failed') {
            log('warn', 'consumer-group-deletion-failed', {
              topic,
              generation: entry.generation,
              reason: result.reason,
            });
          }
        } catch {
          log('warn', 'consumer-group-deletion-failed', {
            topic,
            generation: entry.generation,
            reason,
          });
        } finally {
          if (entries.get(topic) === entry) entries.delete(topic);
          if (barriers.get(topic) === barrier) barriers.delete(topic);
          barrier.release();
        }
      })();
      entry.closePromise = closePromise;
      barrier.closePromise = closePromise;
      void closePromise.catch(() => undefined);
      return closePromise;
    },
    async closeAll(reason): Promise<void> {
      for (const [topic, entry] of entries) {
        if (entry.state !== 'ready') continue;
        try {
          await this.close(topic, reason);
        } catch {
          // Отказ одного консюмера не прерывает закрытие остальных.
        }
      }
    },
  };
}
