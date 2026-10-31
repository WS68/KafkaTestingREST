import type { FastifyInstance } from 'fastify';
import type { Clock } from './ports/clock.js';
import type { IdSource } from './ports/ids.js';
import type { Logger } from './ports/logger.js';
import type { KafkaConsumerFactory } from './ports/kafka-consumer.js';
import { createSlotRegistry } from '../domain/slots/slot-registry.js';
import { createWaitRegistry } from './waiting/wait-registry.js';
import { createRecordRouter } from './routing/record-router.js';
import { createConsumerManager } from './consumers/consumer-manager.js';
import { createIdleSweeper } from './consumers/idle-sweeper.js';
import {
  createConsumerIdleScheduler,
  createSlotCleanupScheduler,
  type ConsumerIdleScheduler,
  type SlotCleanupScheduler,
} from './scheduling/index.js';
import {
  createSlotDeletionService,
  createSlotQueryService,
  createSlotRegistrationService,
} from './slots/index.js';
import { createPublishingService } from './publishing/publishing-service.js';
import { createGroupNameProvider } from '../infrastructure/consumers/group-name.js';
import { createTopicMatcher } from '../infrastructure/config/topic-matcher.js';
import type { PreparedConfig } from '../infrastructure/config/prepare-config.js';
import type { KafkaPorts } from '../infrastructure/kafka/create-kafka-ports.js';
import { createApp } from '../main.js';

export interface AppComposition {
  readonly app: FastifyInstance;
  readonly schedulers: {
    readonly slots: SlotCleanupScheduler;
    readonly consumers: ConsumerIdleScheduler;
  };
  readonly shutdownDeps: {
    readonly consumerManager: ReturnType<typeof createConsumerManager>;
    readonly waits: ReturnType<typeof createWaitRegistry>;
    readonly publisher: KafkaPorts['publisher'];
    readonly groupAdmin: KafkaPorts['groupAdmin'];
    readonly producer: KafkaPorts['producer'];
  };
}

export function composeApplication(deps: {
  readonly config: PreparedConfig;
  readonly logger: Logger;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly kafka: KafkaPorts;
}): AppComposition {
  const slots = createSlotRegistry();
  const waits = createWaitRegistry({ ids: deps.ids, clock: deps.clock });
  const router = createRecordRouter({ registry: slots, waits });
  const consumerFactory: KafkaConsumerFactory = {
    create: (topic, groupId) =>
      deps.kafka.consumerFactory.create(topic, groupId, async (record) => {
        // Топик известен фабрике консюмеров; поэтому маршрутизатор не входит в менеджер.
        router.route(topic, record);
      }),
  };
  const groups = createGroupNameProvider({
    prefix: deps.config.consumerGroupPrefix,
    runId: deps.ids.newRunId(),
    logger: deps.logger,
  });
  const consumers = createConsumerManager({
    factory: consumerFactory,
    groupAdmin: deps.kafka.groupAdmin,
    clock: deps.clock,
    getIdleSeconds: () => deps.config.consumerIdleSeconds,
    getGroupId: groups.getGroupId,
    onRecord: async () => undefined,
    logger: deps.logger,
  });
  const registration = createSlotRegistrationService({
    registry: slots,
    consumers,
    ids: deps.ids,
    clock: deps.clock,
    getDefaultAutoDeleteSeconds: () => deps.config.autoDeleteSlotsSeconds,
  });
  const queries = createSlotQueryService({ registry: slots, waits });
  const deletion = createSlotDeletionService({ registry: slots, waits });
  const publishing = createPublishingService({
    publisher: deps.kafka.publisher,
    isTopicAllowed: createTopicMatcher(deps.config.publisherTopics),
  });
  const sweeper = createIdleSweeper({
    manager: consumers,
    clock: deps.clock,
    hasActiveSlots: (topic) => slots.listByTopic(topic).length > 0,
    logger: deps.logger,
  });
  const schedulers = {
    slots: createSlotCleanupScheduler({
      registry: slots,
      deletion,
      clock: deps.clock,
      logger: deps.logger,
    }),
    consumers: createConsumerIdleScheduler({
      sweeper,
      clock: deps.clock,
      logger: deps.logger,
    }),
  };

  return {
    app: createApp({
      publishing,
      slots: registration,
      queries,
      waits,
      deletion,
      defaults: { waitTimeoutMs: deps.config.defaultWaitMs },
      logger: deps.logger,
    }),
    schedulers,
    shutdownDeps: {
      consumerManager: consumers,
      waits,
      publisher: deps.kafka.publisher,
      groupAdmin: deps.kafka.groupAdmin,
      producer: deps.kafka.producer,
    },
  };
}
