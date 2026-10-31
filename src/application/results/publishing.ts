export type PublishResult =
  | { readonly kind: 'published'; readonly ack: 'broker' }
  | { readonly kind: 'accepted'; readonly ack: 'none' }
  | { readonly kind: 'topic-not-allowed' }
  | {
      readonly kind: 'invalid-record';
      readonly reason: 'invalid-record-type' | 'invalid-base64';
    }
  | {
      readonly kind: 'kafka-unavailable';
      readonly stage: 'before-acceptance' | 'awaiting-confirmation';
    };

/**
 * Поздний отказ отправки без подтверждения регистрируется в журнале и не
 * меняет уже выданный результат `accepted`.
 */
export type LatePublishFailure = {
  readonly topic: string;
  readonly reason: 'kafka-unavailable';
};
