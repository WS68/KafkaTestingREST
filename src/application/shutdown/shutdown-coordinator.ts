import type { Logger } from '../ports/logger.js';

export interface ShutdownCoordinator {
  shutdown(reason: string): Promise<void>;
}

export function createShutdownCoordinator(deps: {
  readonly httpServer: { close(): Promise<void> };
  readonly schedulers: readonly { stop(): Promise<void> }[];
  readonly waits: { settleAll(outcome: 'service-stopping'): void; pendingCount(): number };
  readonly consumerManager: { closeAll(reason: string): Promise<void> };
  readonly publisher: { drain(timeoutMs: number): Promise<boolean>; close(): Promise<void> };
  readonly groupAdmin?: { close(): Promise<void> };
  readonly producer?: { close(): Promise<void> };
  readonly logger: Logger;
  readonly drainTimeoutMs: number;
}): ShutdownCoordinator {
  let shutdownPromise: Promise<void> | undefined;

  const logError = (step: string, error: unknown): void => {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    try {
      deps.logger.error('shutdown-step-failed', { step, errorName });
    } catch {
      // Сбой журналирования не должен прерывать освобождение ресурсов.
    }
  };

  const runStep = async (step: string, action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      logError(step, error);
    }
  };

  return {
    shutdown(reason: string): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;

      const promise = Promise.resolve().then(async (): Promise<void> => {
        try {
          deps.logger.info('shutdown-start');
        } catch {
          // Сбой журналирования не должен прерывать остановку.
        }

        let httpServerClosePromise: Promise<void>;
        try {
          httpServerClosePromise = deps.httpServer.close();
          try {
            deps.logger.info('shutdown-http-close');
          } catch {
            // Сбой журналирования не должен прерывать остановку.
          }
        } catch (error) {
          logError('http-close-start', error);
          httpServerClosePromise = Promise.resolve();
        }

        await runStep('settle-waits', () => deps.waits.settleAll('service-stopping'));

        try {
          const schedulerResults = await Promise.allSettled(
            deps.schedulers.map(async (scheduler) => scheduler.stop()),
          );
          for (const result of schedulerResults) {
            if (result.status === 'rejected') logError('scheduler-stop', result.reason);
          }
          try {
            deps.logger.info('shutdown-schedulers');
          } catch {
            // Сбой журналирования не должен прерывать остановку.
          }
        } catch (error) {
          logError('schedulers-stop', error);
        }

        try {
          await deps.consumerManager.closeAll(reason);
          try {
            deps.logger.info('shutdown-consumers');
          } catch {
            // Сбой журналирования не должен прерывать остановку.
          }
        } catch (error) {
          logError('consumers-close', error);
        }

        try {
          const drained = await deps.publisher.drain(deps.drainTimeoutMs);
          try {
            const fields = { drained, timeoutMs: deps.drainTimeoutMs };
            if (drained) deps.logger.info('shutdown-publisher-drain', fields);
            else deps.logger.warn('shutdown-publisher-drain', fields);
          } catch {
            // Сбой журналирования не должен прерывать остановку.
          }
        } catch (error) {
          logError('publisher-drain', error);
        }

        await runStep('publisher-close', () => deps.publisher.close());
        if (deps.groupAdmin !== undefined) {
          await runStep('group-admin-close', () => deps.groupAdmin!.close());
        }
        if (deps.producer !== undefined) {
          await runStep('producer-close', () => deps.producer!.close());
        }
        await runStep('http-close-wait', () => httpServerClosePromise);

        try {
          deps.logger.info('shutdown-complete', { pendingWaits: deps.waits.pendingCount() });
        } catch {
          // Сбой журналирования не должен менять результат остановки.
        }
      });
      shutdownPromise = promise;

      return promise;
    },
  };
}
