import { createHash } from 'node:crypto';
import type { Logger } from '../../application/ports/logger.js';

export interface GroupNameProvider {
  getGroupId(topic: string): string;
}

/** Возвращает десятичный отпечаток первых восьми байтов MD5 имени топика. */
export function topicHash(topic: string): string {
  const digest = createHash('md5').update(topic, 'utf8').digest('hex');
  return BigInt(`0x${digest.slice(0, 16)}`).toString(10);
}

export interface GroupNameProviderOptions {
  readonly prefix: string;
  readonly runId: string;
  readonly logger: Logger;
  readonly hash?: (topic: string) => string;
}

/** Создаёт провайдер имён групп с кэшем и регистрацией коллизий отпечатка. */
export function createGroupNameProvider(options: GroupNameProviderOptions): GroupNameProvider {
  const groupsByTopic = new Map<string, string>();
  const topicsByHash = new Map<string, string>();
  const hashTopic = options.hash ?? topicHash;

  return {
    getGroupId(topic: string): string {
      const cachedGroupId = groupsByTopic.get(topic);
      if (cachedGroupId !== undefined) return cachedGroupId;

      const hash = hashTopic(topic);
      const previousTopic = topicsByHash.get(hash);
      if (previousTopic !== undefined && previousTopic !== topic) {
        options.logger.warn('consumer-group-name-collision', {
          topicHash: hash,
          firstTopic: previousTopic,
          secondTopic: topic,
        });
      } else if (previousTopic === undefined) {
        topicsByHash.set(hash, topic);
      }

      const groupId = `${options.prefix}-${options.runId}-${hash}`;
      groupsByTopic.set(topic, groupId);
      return groupId;
    },
  };
}
