import { Kafka } from 'kafkajs';
import type {
  KafkaConsumerFactory,
  KafkaGroupAdmin,
} from '../../application/ports/kafka-consumer.js';
import type { KafkaPublisher } from '../../application/ports/kafka-publisher.js';
import type { DrainableKafkaPublisher } from './native-publisher.js';
import type { Logger } from '../../application/ports/logger.js';
import type { PreparedConfig } from '../config/prepare-config.js';
import { createNativeConsumerFactory } from './native-consumer.js';
import { createNativeGroupAdmin } from './native-group-admin.js';
import { createNativeKafkaPublisher } from './native-publisher.js';
import { createNativeProducer } from './kafka-producer-lifecycle.js';
import {
  createKafkaJsAdminAdapter,
  createKafkaJsAdminClientAdapter,
  createKafkaJsConsumerAdapter,
  createKafkaJsProducerAdapter,
} from './kafkajs-adapters.js';

export interface KafkaPorts {
  readonly publisher: KafkaPublisher & DrainableKafkaPublisher;
  readonly consumerFactory: KafkaConsumerFactory;
  readonly groupAdmin: KafkaGroupAdmin & { readonly close: () => Promise<void> };
  readonly producer?: { readonly close: () => Promise<void> };
}

/** Создаёт реальные адаптеры KafkaJS для заданного брокера. */
export function createKafkaPorts(config: PreparedConfig, logger: Logger): KafkaPorts {
  const kafka = new Kafka({ brokers: [`${config.cluster.host}:${config.cluster.port}`] });
  const nativeProducer = createNativeProducer({
    cluster: config.cluster,
    createProducer: () => createKafkaJsProducerAdapter(kafka.producer()),
  });
  const publisher = createNativeKafkaPublisher({ producer: nativeProducer, logger });
  const consumerFactory = createNativeConsumerFactory({
    createConsumer: (groupId) => createKafkaJsConsumerAdapter(kafka.consumer({ groupId })),
    createAdmin: () => createKafkaJsAdminAdapter(kafka.admin()),
    logger,
  });
  const groupAdmin = createNativeGroupAdmin({
    createAdminClient: () => createKafkaJsAdminClientAdapter(kafka.admin()),
    logger,
  });

  return {
    publisher,
    consumerFactory,
    groupAdmin,
    producer: { close: () => nativeProducer.disconnect() },
  };
}
