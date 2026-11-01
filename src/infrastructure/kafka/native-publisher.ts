import type {
  KafkaPublisher,
  PublicationRecordBytes,
  PublishAckResult,
} from '../../application/ports/kafka-publisher.js';
import type { LatePublishFailure } from '../../application/results/publishing.js';
import type { Logger } from '../../application/ports/logger.js';
import { toNativeMessage } from './native-record.js';
import type { NativeMessage } from './native-record.js';
import {
  ProducerConnectionError,
  type KafkaJsMessage,
  type NativeProducer,
} from './kafka-producer-lifecycle.js';

/**
 * Преобразует ошибку нативного клиента в причину отказа прикладного порта.
 * Ошибки подключения и сетевые ошибки относятся к брокеру, а ошибки аргументов
 * и обращения к отключённому клиенту — к клиенту.
 */
function failureReason(error: unknown): 'client' | 'broker' {
  if (error instanceof ProducerConnectionError) return error.reason;

  if (typeof error !== 'object' || error === null) return 'broker';

  const details = error as {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly message?: unknown;
    readonly reason?: unknown;
  };
  if (details.reason === 'client' || details.reason === 'broker') {
    return details.reason;
  }

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

  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    /connection|network|socket|timeout|timed out|broker|unavailable|leader not available/.test(text)
  ) {
    return 'broker';
  }

  return 'broker';
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Формирует сообщение KafkaJS из нативной формы.
 *
 * KafkaJS принимает заголовки как объект, поэтому порядок заголовков с разными
 * именами здесь не сохраняется. Массив значений для каждого имени сохраняет
 * порядок и дубликаты заголовков одного имени.
 */
function toKafkaMessage(nativeMessage: NativeMessage): KafkaJsMessage {
  const headers: Record<string, Buffer[]> = {};
  for (const header of nativeMessage.headers) {
    const values = headers[header.name];
    if (values === undefined) {
      headers[header.name] = [header.value];
    } else {
      values.push(header.value);
    }
  }

  const value = asBuffer(nativeMessage.value);
  return nativeMessage.key === undefined
    ? { value, headers }
    : { key: nativeMessage.key, value, headers };
}

function failedResult(reason: 'client' | 'broker'): PublishAckResult {
  return { kind: 'failed', reason };
}

/** Публикатор с ограниченным ожиданием завершения выполняющихся отправок. */
export interface DrainableKafkaPublisher extends KafkaPublisher {
  readonly inFlightCount: number;
  drain(timeoutMs: number): Promise<boolean>;
}

/**
 * Создаёт публикатор нативного продюсера. В режиме `none` операция вызывается с
 * `acks: 0`, и её успешное завершение на стороне клиента задаёт границу принятия.
 * Это завершение и `accepted-without-confirmation` не подтверждают получение
 * или сохранение записи брокером. Публикатор не обращается к реестрам слотов.
 */
export function createNativeKafkaPublisher(options: {
  readonly producer: NativeProducer;
  readonly logger: Logger;
}): DrainableKafkaPublisher {
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const inFlight = new Set<Promise<void>>();
  const lateFailureUnsubscribers = new Set<() => void>();

  const track = <T>(operation: Promise<T>): Promise<T> => {
    let tracked: Promise<void>;
    tracked = operation.then(
      () => {
        inFlight.delete(tracked);
      },
      () => {
        inFlight.delete(tracked);
      },
    );
    inFlight.add(tracked);
    return operation;
  };

  const publish = async (
    topic: string,
    record: PublicationRecordBytes,
    ackMode: 'broker' | 'none',
  ): Promise<PublishAckResult> => {
    if (closed) return failedResult('client');

    const nativeResult = toNativeMessage(record);
    if (nativeResult.kind === 'invalid-header-name') {
      options.logger.warn('kafka-publish-rejected', {
        topic,
        reason: 'client',
      });
      return failedResult('client');
    }

    const message = toKafkaMessage(nativeResult.message);
    const operation = (async (): Promise<PublishAckResult> => {
      let unsubscribe: (() => void) | undefined;
      let accepted = false;
      try {
        await options.producer.ensureConnected();

        let resolveBeforeAcceptanceFailure: (() => void) | undefined;
        const beforeAcceptanceFailure =
          ackMode === 'none'
            ? new Promise<void>((resolve) => {
                resolveBeforeAcceptanceFailure = resolve;
              })
            : undefined;

        if (ackMode === 'none') {
          unsubscribe = options.producer.producer.onLateFailure?.(() => {
            if (accepted) {
              const failure: LatePublishFailure = {
                topic,
                reason: 'kafka-unavailable',
              };
              options.logger.warn('kafka-publish-late-failure', failure);
              return;
            }
            resolveBeforeAcceptanceFailure?.();
          });
          if (unsubscribe !== undefined) lateFailureUnsubscribers.add(unsubscribe);
        }

        const sendResult = options.producer.producer.send({
          topic,
          messages: [message],
          acks: ackMode === 'none' ? 0 : -1,
        });

        if (beforeAcceptanceFailure === undefined) {
          await sendResult;
        } else {
          const sendOutcome = (async () => {
            try {
              await sendResult;
              accepted = true;
              return { kind: 'sent' as const };
            } catch (error: unknown) {
              return { kind: 'failed' as const, error };
            }
          })();
          const outcome = await Promise.race([
            sendOutcome,
            beforeAcceptanceFailure.then(() => ({ kind: 'before-failure' as const })),
          ]);
          if (outcome.kind === 'before-failure') {
            throw new ProducerConnectionError('broker');
          }
          if (outcome.kind === 'failed') throw outcome.error;
        }

        return ackMode === 'none'
          ? { kind: 'accepted-without-confirmation' }
          : { kind: 'confirmed' };
      } catch (error: unknown) {
        const reason = failureReason(error);
        options.logger.error('kafka-publish-failed', { topic, reason });
        return failedResult(reason);
      } finally {
        if (!accepted) {
          unsubscribe?.();
          if (unsubscribe !== undefined) lateFailureUnsubscribers.delete(unsubscribe);
        }
      }
    })();
    return track(operation);
  };

  const drain = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    try {
      while (inFlight.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const completed = Promise.all([...inFlight]).then(() => true);
        const timedOut = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        });
        const drained = await Promise.race([completed, timedOut]);
        if (timer !== undefined) clearTimeout(timer);
        if (!drained) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const close = (): Promise<void> => {
    closed = true;
    for (const unsubscribe of lateFailureUnsubscribers) unsubscribe();
    lateFailureUnsubscribers.clear();
    closePromise ??= options.producer.disconnect();
    return closePromise;
  };

  return {
    publish,
    close,
    get inFlightCount(): number {
      return inFlight.size;
    },
    drain,
  };
}
