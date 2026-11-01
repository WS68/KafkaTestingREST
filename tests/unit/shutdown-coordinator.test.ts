import { expect, test } from 'vitest';
import { createShutdownCoordinator } from '../../src/application/shutdown/shutdown-coordinator.js';
import type { LogFields, Logger } from '../../src/application/ports/logger.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface LoggerEvent {
  readonly level: 'warn' | 'error';
  readonly event: string;
  readonly fields?: LogFields;
}

function createLogger(): { readonly logger: Logger; readonly events: LoggerEvent[] } {
  const events: LoggerEvent[] = [];
  const record = (level: 'warn' | 'error', event: string, fields?: LogFields): void => {
    events.push(fields === undefined ? { level, event } : { level, event, fields });
  };
  return {
    events,
    logger: {
      log: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (event, fields) => record('warn', event, fields),
      error: (event, fields) => record('error', event, fields),
    },
  };
}

function createDependencies(events: string[], suppliedHttpClose?: Deferred<void>) {
  const httpClose = suppliedHttpClose ?? deferred<void>();
  if (suppliedHttpClose === undefined) httpClose.resolve(undefined);
  const logger = createLogger();
  const dependencies = {
    httpServer: {
      close: (): Promise<void> => {
        events.push('http-close-start');
        return httpClose.promise.then(() => {
          events.push('http-close-resolved');
        });
      },
    },
    schedulers: [
      {
        stop: async (): Promise<void> => {
          events.push('scheduler-0-stop');
        },
      },
      {
        stop: async (): Promise<void> => {
          events.push('scheduler-1-stop');
        },
      },
    ],
    waits: {
      settleAll: (outcome: 'service-stopping'): void => {
        expect(outcome).toBe('service-stopping');
        events.push('settle-all');
      },
      pendingCount: (): number => 0,
    },
    consumerManager: {
      closeAll: async (): Promise<void> => {
        events.push('consumer-close-all');
      },
    },
    publisher: {
      drain: async (timeoutMs: number): Promise<boolean> => {
        events.push(`publisher-drain:${timeoutMs}`);
        return true;
      },
      close: async (): Promise<void> => {
        events.push('publisher-close');
      },
    },
    groupAdmin: {
      close: async (): Promise<void> => {
        events.push('group-admin-close');
      },
    },
    producer: {
      close: async (): Promise<void> => {
        events.push('producer-close');
      },
    },
    logger: logger.logger,
    drainTimeoutMs: 25,
  };
  return { dependencies, logger };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

test('starts HTTP closing first, settles waits before it resolves, then closes resources', async () => {
  const events: string[] = [];
  const httpClose = deferred<void>();
  const { dependencies } = createDependencies(events, httpClose);
  const shutdown = createShutdownCoordinator(dependencies);

  const result = shutdown.shutdown('test');
  await flushMicrotasks();

  expect(events[0]).toBe('http-close-start');
  expect(events).toContain('settle-all');
  expect(events.indexOf('settle-all')).toBeLessThan(events.indexOf('scheduler-0-stop'));
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await flushMicrotasks();
  expect(settled).toBe(false);

  httpClose.resolve(undefined);
  await result;

  expect(events).toEqual([
    'http-close-start',
    'settle-all',
    'scheduler-0-stop',
    'scheduler-1-stop',
    'consumer-close-all',
    'publisher-drain:25',
    'publisher-close',
    'group-admin-close',
    'producer-close',
    'http-close-resolved',
  ]);
});

test('shares one promise and executes every shutdown step once', async () => {
  const events: string[] = [];
  const httpClose = deferred<void>();
  const { dependencies } = createDependencies(events, httpClose);
  const shutdown = createShutdownCoordinator(dependencies);

  const first = shutdown.shutdown('a');
  const second = shutdown.shutdown('b');
  expect(second).toBe(first);
  await flushMicrotasks();
  httpClose.resolve(undefined);
  await Promise.all([first, second]);

  expect(events).toHaveLength(10);
  expect(new Set(events).size).toBe(10);
});

test('warns when drain is limited and still closes publisher and producer', async () => {
  const events: string[] = [];
  const { dependencies, logger } = createDependencies(events);
  dependencies.publisher.drain = async (timeoutMs): Promise<boolean> => {
    events.push(`publisher-drain:${timeoutMs}`);
    return false;
  };

  await createShutdownCoordinator(dependencies).shutdown('drain-timeout');

  expect(logger.events).toContainEqual({
    level: 'warn',
    event: 'shutdown-publisher-drain',
    fields: { drained: false, timeoutMs: 25 },
  });
  expect(events).toContain('publisher-close');
  expect(events).toContain('producer-close');
});

test('logs a scheduler failure and continues with the remaining steps', async () => {
  const events: string[] = [];
  const { dependencies, logger } = createDependencies(events);
  dependencies.schedulers[0]!.stop = async (): Promise<void> => {
    events.push('scheduler-0-stop');
    throw new Error('scheduler failed');
  };

  await expect(
    createShutdownCoordinator(dependencies).shutdown('scheduler-error'),
  ).resolves.toBeUndefined();

  expect(events).toContain('scheduler-1-stop');
  expect(events).toContain('consumer-close-all');
  expect(events).toContain('publisher-drain:25');
  expect(events).toContain('publisher-close');
  expect(logger.events).toContainEqual({
    level: 'error',
    event: 'shutdown-step-failed',
    fields: { step: 'scheduler-stop', errorName: 'Error' },
  });
});

test('logs closeAll failure and continues draining and closing', async () => {
  const events: string[] = [];
  const { dependencies, logger } = createDependencies(events);
  dependencies.consumerManager.closeAll = async (): Promise<void> => {
    events.push('consumer-close-all');
    throw new Error('consumer close failed');
  };

  await createShutdownCoordinator(dependencies).shutdown('consumer-error');

  expect(events).toContain('publisher-drain:25');
  expect(events).toContain('publisher-close');
  expect(logger.events).toContainEqual({
    level: 'error',
    event: 'shutdown-step-failed',
    fields: { step: 'consumers-close', errorName: 'Error' },
  });
});

test('logs HTTP close failure and resolves the shutdown promise', async () => {
  const events: string[] = [];
  const httpClose = deferred<void>();
  const { dependencies, logger } = createDependencies(events, httpClose);
  const result = createShutdownCoordinator(dependencies).shutdown('http-error');
  await flushMicrotasks();
  httpClose.reject(new Error('HTTP close failed'));

  await expect(result).resolves.toBeUndefined();
  expect(logger.events).toContainEqual({
    level: 'error',
    event: 'shutdown-step-failed',
    fields: { step: 'http-close-wait', errorName: 'Error' },
  });
});

test('always delegates empty registry handling to closeAll without deleteGroup', async () => {
  const events: string[] = [];
  const { dependencies } = createDependencies(events);
  const shutdownDependencies = { ...dependencies };
  const coordinator = createShutdownCoordinator(shutdownDependencies);

  await coordinator.shutdown('empty');

  expect(events).toContain('consumer-close-all');
  expect('deleteGroup' in shutdownDependencies).toBe(false);
});

test('settles active waits before closing consumers and ignores a repeated signal', async () => {
  const events: string[] = [];
  const { dependencies } = createDependencies(events);
  const coordinator = createShutdownCoordinator(dependencies);
  const first = coordinator.shutdown('first');
  const second = coordinator.shutdown('second');

  expect(second).toBe(first);
  await first;
  expect(events.indexOf('settle-all')).toBeLessThan(events.indexOf('consumer-close-all'));
  expect(events.filter((event) => event === 'settle-all')).toHaveLength(1);
  expect(events.filter((event) => event === 'consumer-close-all')).toHaveLength(1);
});
