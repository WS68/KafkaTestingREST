import type { SourceRecord } from '../../domain/record.js';

export type ConsumerInitializationFailure = { readonly reason: 'client' | 'broker' };

export interface ReadyConsumer {
  /** Идемпотентно закрывает консюмера и ожидает завершения текущего обработчика записи. */
  close(): Promise<void>;
}

export interface KafkaConsumerFactory {
  /**
   * Отклоняет Promise с ConsumerInitializationFailure при ошибке запуска.
   * Готовность подтверждается только после установки позиции чтения с конца
   * разделов; одного успешного subscribe недостаточно.
   */
  create(
    topic: string,
    groupId: string,
    onRecord: (record: SourceRecord) => Promise<void>,
  ): Promise<ReadyConsumer>;
}

export type GroupDeletionResult =
  { readonly kind: 'deleted' } | { readonly kind: 'failed'; readonly reason: 'client' | 'broker' };

/** Отдельный адаптер управления группами; решение об удалении принимает менеджер консюмеров. */
export interface KafkaGroupAdmin {
  deleteGroup(groupId: string): Promise<GroupDeletionResult>;
}
