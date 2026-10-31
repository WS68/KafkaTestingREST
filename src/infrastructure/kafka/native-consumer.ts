import type {
  ConsumerInitializationFailure,
  KafkaConsumerFactory,
  ReadyConsumer,
} from '../../application/ports/kafka-consumer.js';
import type { Logger } from '../../application/ports/logger.js';
import type { SourceRecord } from '../../domain/record.js';

export interface KafkaJsConsumedMessage {
  readonly key?: Uint8Array | string | null;
  readonly value?: Uint8Array | string | null;
  readonly headers?: Readonly<
    Record<string, Uint8Array | string | readonly (Uint8Array | string)[] | undefined>
  >;
}

/** Минимальная граница KafkaJS, необходимая для создания консюмера. */
export interface KafkaJsConsumerLike {
  connect(): Promise<void>;
  subscribe(options: { topic: string; fromBeginning: boolean }): Promise<void>;
  run(options: {
    eachMessage: (payload: { topic: string; message: KafkaJsConsumedMessage }) => Promise<void>;
  }): Promise<void>;
  disconnect(): Promise<void>;
  on(
    event: 'GROUP_JOIN',
    listener: (payload: {
      payload: { memberAssignment: Record<string, readonly number[]> };
    }) => void,
  ): () => void;
  seek(options: { topic: string; partition: number; offset: string }): void;
  pause?(topics: readonly { topic: string; partitions?: readonly number[] }[]): void;
  resume?(topics: readonly { topic: string; partitions?: readonly number[] }[]): void;
}

export interface KafkaJsAdminLike {
  fetchTopicOffsets(topic: string): Promise<readonly { partition: number; offset: string }[]>;
  disconnect(): Promise<void>;
}

function failureReason(error: unknown): 'client' | 'broker' {
  if (typeof error !== 'object' || error === null) return 'broker';

  const details = error as {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly message?: unknown;
    readonly reason?: unknown;
  };
  if (details.reason === 'client' || details.reason === 'broker') return details.reason;

  const code = typeof details.code === 'string' ? details.code : '';
  const name = typeof details.name === 'string' ? details.name : '';
  const message = typeof details.message === 'string' ? details.message : '';
  const text = `${code} ${name} ${message}`.toLowerCase();
  if (
    code.startsWith('ERR_INVALID_') ||
    code === 'ERR_OUT_OF_RANGE' ||
    code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
    /invalid (?:argument|parameter|message|header)|bad argument/.test(text) ||
    /not connected|disconnected|must be connected/.test(text)
  ) {
    return 'client';
  }
  return 'broker';
}

function asBytes(value: Uint8Array | string | null | undefined): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

/**
 * Переводит сообщение KafkaJS в исходные байты без декодирования или base64.
 *
 * KafkaJS представляет заголовки объектом, поэтому транспорт не сохраняет
 * порядок заголовков с разными именами — это ограничение библиотеки, а не
 * потеря в адаптере. Порядок всех значений внутри одного имени сохраняется,
 * включая повторяющиеся заголовки.
 */
function toSourceRecord(message: KafkaJsConsumedMessage): SourceRecord {
  const headers: { name: Uint8Array; value: Uint8Array | undefined }[] = [];
  const encoder = new TextEncoder();
  for (const [name, rawValue] of Object.entries(message.headers ?? {})) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      headers.push({ name: encoder.encode(name), value: asBytes(value) });
    }
  }

  return {
    headers,
    key: asBytes(message.key),
    value: asBytes(message.value),
  };
}

function offsetsByPartition(
  offsets: readonly { partition: number; offset: string }[],
): ReadonlyMap<number, string> {
  return new Map(offsets.map(({ partition, offset }) => [partition, offset]));
}

/**
 * Создаёт фабрику нативных консюмеров.
 *
 * Адаптер только нормализует байты и передаёт запись прикладному обработчику.
 * Он не сопоставляет условия проверок, не обращается к реестрам слотов или
 * ожиданий и не уведомляет публикацию. Отказ обработчика только записывается
 * в журнал и не удаляет слоты.
 *
 * После первого `GROUP_JOIN` позиции устанавливаются по снимку последних смещений,
 * полученному до запуска чтения. При каждом последующем `GROUP_JOIN` (rebalance)
 * смещения запрашиваются заново и `seek` повторяется для всех новых назначений.
 * Готовность подтверждается только один раз — после первого полного применения позиций.
 * Закрытие прекращает чтение, ожидает активные обработчики и освобождает клиентов.
 * Удаление группы выполняется отдельным адаптером по решению менеджера консюмеров;
 * эта фабрика не удаляет группу ни при закрытии, ни при ошибке инициализации.
 */
export function createNativeConsumerFactory(options: {
  readonly createConsumer: (groupId: string) => KafkaJsConsumerLike;
  readonly createAdmin: () => KafkaJsAdminLike;
  readonly logger: Logger;
}): KafkaConsumerFactory {
  return {
    async create(topic, groupId, onRecord): Promise<ReadyConsumer> {
      let consumer: KafkaJsConsumerLike | undefined;
      let admin: KafkaJsAdminLike | undefined;
      let unsubscribe: (() => void) | undefined;
      let closePromise: Promise<void> | undefined;
      let isClosing = false;
      const activeHandlers = new Set<Promise<void>>();

      const disconnect = async (
        resource: 'consumer' | 'admin',
        disconnectResource: () => Promise<void>,
      ): Promise<void> => {
        try {
          await disconnectResource();
        } catch {
          try {
            options.logger.warn('kafka-client-disconnect-failed', { resource });
          } catch {
            // Отказ журнала не должен изменить результат закрытия.
          }
        }
      };

      const close = (): Promise<void> => {
        if (closePromise !== undefined) return closePromise;
        isClosing = true;
        unsubscribe?.();
        closePromise = (async (): Promise<void> => {
          await Promise.allSettled([...activeHandlers]);
          await Promise.allSettled([
            ...(consumer === undefined
              ? []
              : [disconnect('consumer', () => consumer!.disconnect())]),
            ...(admin === undefined ? [] : [disconnect('admin', () => admin!.disconnect())]),
          ]);
        })();
        return closePromise;
      };

      const readyConsumer: ReadyConsumer = { close };
      let ready = false;
      let resolveReady!: (value: ReadyConsumer) => void;
      let rejectReady!: (error: unknown) => void;
      const readyPromise = new Promise<ReadyConsumer>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      try {
        const createdConsumer = options.createConsumer(groupId);
        consumer = createdConsumer;
        const createdAdmin = options.createAdmin();
        admin = createdAdmin;

        await createdConsumer.connect();
        await createdConsumer.subscribe({ topic, fromBeginning: false });
        const initialOffsets = offsetsByPartition(await createdAdmin.fetchTopicOffsets(topic));

        let useInitialOffsets = true;
        let assignmentChain = Promise.resolve();
        unsubscribe = consumer.on('GROUP_JOIN', ({ payload }) => {
          const offsets = useInitialOffsets ? initialOffsets : undefined;
          useInitialOffsets = false;
          assignmentChain = assignmentChain
            .then(async () => {
              const currentOffsets =
                offsets ?? offsetsByPartition(await createdAdmin.fetchTopicOffsets(topic));
              for (const partition of payload.memberAssignment[topic] ?? []) {
                const offset = currentOffsets.get(partition);
                if (offset === undefined) {
                  throw new Error(`No latest offset for assigned partition ${partition}`);
                }
                createdConsumer.seek({ topic, partition, offset });
              }
              if (!ready) {
                ready = true;
                resolveReady(readyConsumer);
              }
            })
            .catch((error: unknown) => {
              if (!ready) {
                rejectReady(error);
              } else {
                void close();
              }
            });
        });

        // KafkaJS присылает GROUP_JOIN только после запуска run, поэтому run запускается
        // до ожидания барьера готовности, а не после вызова subscribe.
        const runPromise = createdConsumer.run({
          eachMessage: async ({ topic: messageTopic, message }) => {
            if (isClosing) return;
            const handler = (async (): Promise<void> => {
              try {
                await onRecord(toSourceRecord(message));
              } catch {
                try {
                  options.logger.error('kafka-record-handler-failed', {
                    topic: messageTopic,
                    reason: 'handler-failed',
                  });
                } catch {
                  // Отказ журнала не должен останавливать чтение Kafka.
                }
              }
            })();
            activeHandlers.add(handler);
            try {
              await handler;
            } finally {
              activeHandlers.delete(handler);
            }
          },
        });
        void runPromise.catch((error: unknown) => {
          if (!ready) rejectReady(error);
        });

        return await readyPromise;
      } catch (error: unknown) {
        const failure: ConsumerInitializationFailure = { reason: failureReason(error) };
        await close();
        throw failure;
      }
    },
  };
}
