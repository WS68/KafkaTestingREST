import type { KafkaPublisher } from '../ports/kafka-publisher.js';
import { encodeRecord } from './encode-record.js';
import type { RecordDto } from './publication-input.js';
import type { PublishResult } from '../results/publishing.js';

export interface PublishingService {
  publish(input: {
    readonly topic: string;
    readonly record: RecordDto;
    readonly ack: 'broker' | 'none';
  }): Promise<PublishResult>;
}

/**
 * Создаёт сервис публикации без доступа к слотам и реестрам наблюдения.
 * Успешная публикация не означает, что запись накоплена в слоте.
 * Пустой список разрешающих выражений задаётся вызывающим кодом как функция,
 * всегда возвращающая `true`, и в этом случае разрешает любой топик.
 */
export function createPublishingService(deps: {
  readonly publisher: KafkaPublisher;
  readonly isTopicAllowed: (topic: string) => boolean;
}): PublishingService {
  return {
    async publish(input): Promise<PublishResult> {
      if (!deps.isTopicAllowed(input.topic)) {
        return { kind: 'topic-not-allowed' };
      }

      const encoded = encodeRecord(input.record);
      if (encoded.kind === 'invalid-record-type') {
        return { kind: 'invalid-record', reason: 'invalid-record-type' };
      }
      if (encoded.kind === 'invalid-base64') {
        return { kind: 'invalid-record', reason: 'invalid-base64' };
      }

      const result = await deps.publisher.publish(input.topic, encoded.record, input.ack);
      if (result.kind === 'confirmed') {
        return { kind: 'published', ack: 'broker' };
      }
      if (result.kind === 'accepted-without-confirmation') {
        return { kind: 'accepted', ack: 'none' };
      }

      return {
        kind: 'kafka-unavailable',
        stage: input.ack === 'broker' ? 'awaiting-confirmation' : 'before-acceptance',
      };
    },
  };
}
