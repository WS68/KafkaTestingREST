import type {
  GroupDeletionResult,
  KafkaGroupAdmin,
} from '../../application/ports/kafka-consumer.js';
import type { Logger } from '../../application/ports/logger.js';

/** Минимальная граница KafkaJS для удаления групп консюмеров. */
export interface KafkaJsAdminClientLike {
  deleteGroups(options: { readonly groupIds: readonly string[] }): Promise<void>;
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
    /invalid (?:argument|parameter|request)|bad argument/.test(text) ||
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
    /connection|network|socket|timeout|timed out|broker|unavailable|coordinator/.test(text)
  ) {
    return 'broker';
  }

  return 'broker';
}

function logWarning(logger: Logger, event: string, fields: Record<string, string>): void {
  try {
    logger.warn(event, fields);
  } catch {
    // Отказ журнала не должен изменить результат операции Kafka.
  }
}

/**
 * Создаёт отдельный адаптер управления группами консюмеров.
 * Адаптер удаляет только имя группы, переданное менеджером, и не принимает
 * решение о том, когда удаление требуется. Консюмер и этот адаптер не удаляют
 * группы автоматически при закрытии или частичной инициализации.
 */
export function createNativeGroupAdmin(options: {
  readonly createAdminClient: () => KafkaJsAdminClientLike;
  readonly logger: Logger;
}): KafkaGroupAdmin & { readonly close: () => Promise<void> } {
  const admin = options.createAdminClient();
  let closePromise: Promise<void> | undefined;

  const deleteGroup = async (groupId: string): Promise<GroupDeletionResult> => {
    try {
      await admin.deleteGroups({ groupIds: [groupId] });
      return { kind: 'deleted' };
    } catch (error: unknown) {
      const reason = failureReason(error);
      logWarning(options.logger, 'kafka-group-deletion-failed', { groupId, reason });
      return { kind: 'failed', reason };
    }
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async (): Promise<void> => {
      try {
        await admin.disconnect();
      } catch {
        logWarning(options.logger, 'kafka-group-admin-disconnect-failed', { reason: 'client' });
      }
    })();
    return closePromise;
  };

  return { deleteGroup, close };
}
