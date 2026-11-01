import type { Clock } from '../application/ports/clock.js';
import type { IdSource } from '../application/ports/ids.js';
import type { Logger } from '../application/ports/logger.js';
import type { ConsumerManager } from '../application/consumers/consumer-manager.js';
import type {
  ConsumerIdleScheduler,
  SlotCleanupScheduler,
} from '../application/scheduling/index.js';
import { createShutdownCoordinator } from '../application/shutdown/shutdown-coordinator.js';
import { loadConfig } from '../infrastructure/config/load-config.js';
import type { ConfigIssue } from '../infrastructure/config/app-config.js';
import { prepareConfig } from '../infrastructure/config/prepare-config.js';
import { createSystemIds } from '../infrastructure/ids/system-ids.js';
import { createKafkaPorts, type KafkaPorts } from '../infrastructure/kafka/create-kafka-ports.js';
import { createSystemClock } from '../infrastructure/time/system-clock.js';
import { composeApplication } from './app-composition.js';

export interface RuntimeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  readonly installSignalHandlers?: boolean;
  readonly kafka?: KafkaPorts;
  readonly clock?: Clock;
  readonly ids?: IdSource;
}

export interface RunningApplication {
  readonly shutdown: (reason: string) => Promise<void>;
  readonly address: () => { readonly host: string; readonly port: number } | undefined;
  readonly test: {
    readonly slots: SlotCleanupScheduler;
    readonly consumers: ConsumerManager;
    readonly waits?: Awaited<ReturnType<typeof composeApplication>>['test']['waits'];
    readonly consumerIdle: ConsumerIdleScheduler;
    readonly getGroupId: (topic: string) => string;
  };
}

export class ConfigurationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super('Invalid application configuration');
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export async function startApplication(options: RuntimeOptions): Promise<RunningApplication> {
  const loaded = loadConfig(options.env);
  if (loaded.kind === 'error') throw new ConfigurationError(loaded.issues);

  const prepared = prepareConfig(loaded.config);
  if (prepared.kind === 'error') throw new ConfigurationError(prepared.issues);

  const clock = options.clock ?? createSystemClock();
  const ids = options.ids ?? createSystemIds();
  const kafka = options.kafka ?? createKafkaPorts(prepared.config, options.logger);
  let composition: Awaited<ReturnType<typeof composeApplication>> | undefined;
  let coordinator: ReturnType<typeof createShutdownCoordinator> | undefined;

  const closeCreatedResources = async (): Promise<void> => {
    if (composition === undefined) {
      await Promise.allSettled([
        kafka.publisher.close(),
        kafka.groupAdmin.close(),
        ...(kafka.producer === undefined ? [] : [kafka.producer.close()]),
      ]);
      return;
    }
    await Promise.allSettled([
      composition.app.close(),
      composition.schedulers.slots.stop(),
      composition.schedulers.consumers.stop(),
      composition.shutdownDeps.waits.settleAll('service-stopping'),
      composition.shutdownDeps.consumerManager.closeAll('startup-failed'),
      composition.shutdownDeps.publisher.close(),
      composition.shutdownDeps.groupAdmin.close(),
      ...(composition.shutdownDeps.producer === undefined
        ? []
        : [composition.shutdownDeps.producer.close()]),
    ]);
  };

  try {
    composition = await composeApplication({
      config: prepared.config,
      logger: options.logger,
      ids,
      clock,
      kafka,
    });
    await composition.app.listen({
      host: prepared.config.httpHost,
      port: prepared.config.httpPort,
    });
    composition.schedulers.slots.start();
    composition.schedulers.consumers.start();

    coordinator = createShutdownCoordinator({
      httpServer: composition.app,
      schedulers: [composition.schedulers.slots, composition.schedulers.consumers],
      waits: composition.shutdownDeps.waits,
      consumerManager: composition.shutdownDeps.consumerManager,
      publisher: composition.shutdownDeps.publisher,
      groupAdmin: composition.shutdownDeps.groupAdmin,
      ...(composition.shutdownDeps.producer === undefined
        ? {}
        : { producer: composition.shutdownDeps.producer }),
      logger: options.logger,
      drainTimeoutMs: 5_000,
    });
    let onSignal: (() => void) | undefined;
    const removeSignalHandlers = (): void => {
      if (onSignal === undefined) return;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      onSignal = undefined;
    };
    const shutdown = (reason: string): Promise<void> =>
      coordinator!.shutdown(reason).finally(removeSignalHandlers);
    const address = (): { readonly host: string; readonly port: number } | undefined => {
      const value = composition?.app.server.address();
      if (value === null || value === undefined || typeof value === 'string') return undefined;
      return { host: value.address, port: value.port };
    };

    if (options.installSignalHandlers !== false) {
      let stopping = false;
      onSignal = (): void => {
        if (stopping) {
          try {
            options.logger.warn('shutdown-signal-ignored');
          } catch {
            // Повторный сигнал не прерывает согласованную остановку.
          }
          return;
        }
        stopping = true;
        void shutdown('signal');
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    }

    return {
      shutdown,
      address,
      test: {
        slots: composition.schedulers.slots,
        consumers: composition.test.consumers,
        waits: composition.test.waits,
        consumerIdle: composition.schedulers.consumers,
        getGroupId: composition.test.getGroupId,
      },
    };
  } catch (error) {
    if (coordinator !== undefined) await coordinator.shutdown('startup-failed');
    else await closeCreatedResources();
    throw error;
  }
}
