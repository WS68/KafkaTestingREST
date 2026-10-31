import type { ReadonlyBytes } from '../../domain/record.js';

export interface PublicationRecordBytes {
  readonly key: ReadonlyBytes | undefined;
  readonly value: ReadonlyBytes;
  readonly headers: readonly { readonly name: ReadonlyBytes; readonly value: ReadonlyBytes }[];
}

export type PublishAckMode = 'broker' | 'none';
export type PublishAckResult =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'accepted-without-confirmation' }
  /** Детали отказа журналируются адаптером и не входят в публичный контракт. */
  | { readonly kind: 'failed'; readonly reason: 'client' | 'broker' };

export interface KafkaPublisher {
  publish(
    topic: string,
    record: PublicationRecordBytes,
    ackMode: PublishAckMode,
  ): Promise<PublishAckResult>;
  close(): Promise<void>;
}
