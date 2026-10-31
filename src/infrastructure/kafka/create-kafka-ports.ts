import { Kafka } from 'kafkajs';
import type { KafkaConsumerFactory, KafkaGroupAdmin } from '../../application/ports/kafka-consumer.js';
import type { KafkaPublisher } from '../../application/ports/kafka-publisher.js';
import type { Logger } from '../../application/ports/logger.js';
import type { PreparedConfig } from '../config/prepare-config.js';
import { createNativeConsumerFactory } from './native-consumer.js';
import { createNativeGroupAdmin } from './native-group-admin.js';
import { createNativeKafkaPublisher } from './native-publisher.js';
import { createNativeProducer } from './kafka-producer-lifecycle.js';

export interface KafkaPorts {
  readonly publisher: KafkaPublisher;
  readonly consumerFactory: KafkaConsumerFactory;
  readonly groupAdmin: KafkaGroupAdmin;
  readonly producer?: { readonly close: () => Promise<void> };
}

/** Создаёт реальные адаптеры KafkaJS для заданного брокера. */
export function createKafkaPorts(config: PreparedConfig, logger: Logger): KafkaPorts {
  const kafka = new Kafka({ brokers: [`${config.cluster.host}:${config.cluster.port}`] });
  const nativeProducer = createNativeProducer({
    cluster: config.cluster,
    createProducer: () => kafka.producer(),
  });
  const publisher = createNativeKafkaPublisher({ producer: nativeProducer, logger });
  const consumerFactory = createNativeConsumerFactory({
    createConsumer: (groupId) => kafka.consumer({ groupId }),
    createAdmin: () => kafka.admin(),
    logger,
  });
  const groupAdmin = createNativeGroupAdmin({
    createAdminClient: () => kafka.admin(),
    logger,
  });

  return {
    publisher,
    consumerFactory,
    groupAdmin,
    producer: { close: () => nativeProducer.disconnect() },
  };
}
