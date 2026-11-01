import { expect, test, vi } from 'vitest';
import type { Clock } from '../../src/application/ports/clock.js';
import type { IdSource } from '../../src/application/ports/ids.js';
import { noopLogger } from '../../src/http/create-app.js';
import type { AppComposition } from '../../src/composition/app-composition.js';
import { composeApplication } from '../../src/composition/app-composition.js';
import {
  ConfigurationError,
  startApplication,
  type RunningApplication,
} from '../../src/composition/runtime.js';
import type { KafkaPorts } from '../../src/infrastructure/kafka/create-kafka-ports.js';
import { createKafkaPorts } from '../../src/infrastructure/kafka/create-kafka-ports.js';
import { ManualClock } from '../support/manual-clock.js';

vi.mock('../../src/composition/app-composition.js', () => ({
  composeApplication: vi.fn(),
}));
vi.mock('../../src/infrastructure/kafka/create-kafka-ports.js', () => ({
  createKafkaPorts: vi.fn(),
}));

const validEnv = {
  KAFKA_TESTING_REST_CLUSTER: 'localhost:9092',
  KAFKA_TESTING_REST_HTTP_PORT: '3000',
};

function createIds(): IdSource {
  return {
    newSlotId: () => 'slot-id',
    newWaitId: () => 'wait-id',
    newRunId: () => 'run-id',
  };
}

function createKafka(): KafkaPorts {
  return {
    publisher: {
      publish: async () => ({ kind: 'accepted-without-confirmation' }),
      drain: async () => true,
      inFlightCount: 0,
      close: async () => undefined,
    },
    consumerFactory: {
      create: async () => ({ close: async () => undefined }),
    },
    groupAdmin: {
      deleteGroup: async () => ({ kind: 'deleted' }),
      close: async () => undefined,
    },
    producer: { close: async () => undefined },
  };
}

function createComposition(starts: string[]): AppComposition {
  const app = {
    listen: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
    server: { address: (): null => null },
  } as unknown as AppComposition['app'];
  const kafka = createKafka();
  return {
    app,
    schedulers: {
      slots: {
        start(): void {
          starts.push('slots');
        },
        stop: async (): Promise<void> => undefined,
        runPass: async (): Promise<readonly string[]> => [],
      },
      consumers: {
        start(): void {
          starts.push('consumers');
        },
        stop: async (): Promise<void> => undefined,
        runPass: async (): Promise<readonly never[]> => [],
      },
    },
    test: {
      consumers: {
        listTopics: () => [],
        getExpiresAt: () => undefined,
        reserve: () => ({ topic: 'test', generation: 1 }),
        ensureReady: async () => ({
          topic: 'test',
          generation: 1,
          readyConsumer: { close: async () => undefined },
        }),
        release: () => undefined,
        extend: () => undefined,
        hasActiveReservations: () => false,
        getState: () => 'absent',
        tryCloseIdle: async () => 'skipped-not-ready',
        close: async () => undefined,
        closeAll: async () => undefined,
      },
      idleSweeper: { sweep: async () => [] },
      getGroupId: () => 'test-group',
    },
    shutdownDeps: {
      waits: {
        settleAll: (): void => undefined,
        pendingCount: (): number => 0,
      } as unknown as AppComposition['shutdownDeps']['waits'],
      consumerManager: {
        closeAll: async (): Promise<void> => undefined,
      } as unknown as AppComposition['shutdownDeps']['consumerManager'],
      publisher: kafka.publisher,
      groupAdmin: kafka.groupAdmin,
      producer: kafka.producer,
    },
  };
}

test('rejects a missing cluster before creating Kafka ports or opening a port', async () => {
  vi.mocked(createKafkaPorts).mockClear();
  vi.mocked(composeApplication).mockClear();

  await expect(
    startApplication({ env: {}, logger: noopLogger, installSignalHandlers: false }),
  ).rejects.toSatisfy((error: unknown) => {
    return (
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'cluster' && issue.reason === 'missing')
    );
  });

  expect(createKafkaPorts).not.toHaveBeenCalled();
  expect(composeApplication).not.toHaveBeenCalled();
});

test('rejects an invalid cluster before startup', async () => {
  vi.mocked(createKafkaPorts).mockClear();
  vi.mocked(composeApplication).mockClear();

  await expect(
    startApplication({
      env: { ...validEnv, KAFKA_TESTING_REST_CLUSTER: 'bad' },
      logger: noopLogger,
      installSignalHandlers: false,
    }),
  ).rejects.toSatisfy((error: unknown) => {
    return (
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'cluster' && issue.reason === 'invalid-cluster')
    );
  });

  expect(createKafkaPorts).not.toHaveBeenCalled();
  expect(composeApplication).not.toHaveBeenCalled();
});

test('starts both schedulers and exposes a working shutdown with injected dependencies', async () => {
  const starts: string[] = [];
  const composition = createComposition(starts);
  vi.mocked(composeApplication).mockResolvedValue(composition);
  vi.mocked(createKafkaPorts).mockClear();

  const clock: Clock = new ManualClock();
  const application: RunningApplication = await startApplication({
    env: validEnv,
    logger: noopLogger,
    installSignalHandlers: false,
    kafka: createKafka(),
    clock,
    ids: createIds(),
  });

  expect(starts).toEqual(['slots', 'consumers']);
  expect(createKafkaPorts).not.toHaveBeenCalled();
  await expect(application.shutdown('test')).resolves.toBeUndefined();
});
