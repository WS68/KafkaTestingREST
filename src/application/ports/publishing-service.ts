import type { PublishResult } from '../results/publishing.js';
import type { PublishAckMode, PublicationRecordBytes } from './kafka-publisher.js';

/** Прикладная граница публикации для контроллеров; принимает только подготовленные байты. */
export interface PublishingServicePort {
  publish(
    topic: string,
    record: PublicationRecordBytes,
    ackMode: PublishAckMode,
  ): Promise<PublishResult>;
}
