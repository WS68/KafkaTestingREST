import type { Admin, Consumer, ConsumerGroupJoinEvent, IHeaders, Message, Producer } from 'kafkajs';
import type {
  KafkaJsAdminLike,
  KafkaJsConsumedMessage,
  KafkaJsConsumerLike,
} from './native-consumer.js';
import type {
  KafkaJsMessage,
  KafkaJsProducerLike,
  KafkaJsProducerSendOptions,
} from './kafka-producer-lifecycle.js';
import type { KafkaJsAdminClientLike } from './native-group-admin.js';

function isHeaderValues(
  value: Buffer | string | readonly (Buffer | string)[] | undefined,
): value is readonly (Buffer | string)[] {
  return Array.isArray(value);
}

function toKafkaHeaders(
  headers: Readonly<Record<string, Buffer | string | readonly (Buffer | string)[] | undefined>>,
): IHeaders {
  const result: IHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = isHeaderValues(value) ? [...value] : value;
  }
  return result;
}

function toKafkaMessage(message: KafkaJsMessage): Message {
  const headers = message.headers === undefined ? undefined : toKafkaHeaders(message.headers);
  if (message.key === undefined) {
    return headers === undefined ? { value: message.value } : { value: message.value, headers };
  }
  return headers === undefined
    ? { key: message.key, value: message.value }
    : { key: message.key, value: message.value, headers };
}

export function createKafkaJsProducerAdapter(producer: Producer): KafkaJsProducerLike {
  return {
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
    send: (options: KafkaJsProducerSendOptions) =>
      producer.send({
        topic: options.topic,
        messages: options.messages.map(toKafkaMessage),
        ...(options.acks === undefined ? {} : { acks: options.acks }),
      }),
  };
}

function toConsumerMessage(message: KafkaJsConsumedMessage): KafkaJsConsumedMessage {
  return {
    ...(message.key === undefined ? {} : { key: message.key }),
    ...(message.value === undefined ? {} : { value: message.value }),
    ...(message.headers === undefined ? {} : { headers: message.headers }),
  };
}

function toConsumerTopics(
  topics: readonly { topic: string; partitions?: readonly number[] }[],
): { topic: string; partitions?: number[] }[] {
  return topics.map(({ topic, partitions }) =>
    partitions === undefined ? { topic } : { topic, partitions: [...partitions] },
  );
}

export function createKafkaJsConsumerAdapter(consumer: Consumer): KafkaJsConsumerLike {
  return {
    connect: () => consumer.connect(),
    subscribe: (options) => consumer.subscribe(options),
    run: (options) =>
      consumer.run({
        eachMessage: async (payload) =>
          options.eachMessage({
            topic: payload.topic,
            message: toConsumerMessage(payload.message),
          }),
      }),
    disconnect: () => consumer.disconnect(),
    on: (event, listener) => {
      if (event !== 'GROUP_JOIN') {
        throw new Error(`Неподдерживаемое событие консюмера: ${event}`);
      }
      return consumer.on('consumer.group_join', (payload: ConsumerGroupJoinEvent) =>
        listener({ payload: { memberAssignment: payload.payload.memberAssignment } }),
      );
    },
    seek: (options) => consumer.seek(options),
    pause: (topics) => consumer.pause(toConsumerTopics(topics)),
    resume: (topics) => consumer.resume(toConsumerTopics(topics)),
  };
}

export function createKafkaJsAdminClientAdapter(admin: Admin): KafkaJsAdminClientLike {
  return {
    deleteGroups: async (options) => {
      await admin.deleteGroups([...options.groupIds]);
    },
    disconnect: () => admin.disconnect(),
  };
}

export function createKafkaJsAdminAdapter(admin: Admin): KafkaJsAdminLike {
  return {
    fetchTopicOffsets: async (topic) => admin.fetchTopicOffsets(topic),
    disconnect: () => admin.disconnect(),
  };
}
