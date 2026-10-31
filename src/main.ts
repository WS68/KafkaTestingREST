import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from './application/ports/logger.js';
import type { PublishingService } from './application/publishing/publishing-service.js';
import type { SlotDeletionService } from './application/slots/slot-deletion.js';
import type { SlotRegistrationService } from './application/slots/slot-registration.js';
import type { SlotQueryService } from './application/slots/slot-queries.js';
import type { WaitRegistry } from './application/waiting/wait-registry.js';
import {
  publishRoute,
  slotsCountRoute,
  slotsDeleteRoute,
  slotsReadRoute,
  slotsRegisterRoute,
  slotsWaitRoute,
} from './http/routes/index.js';
import { registerOpenApi } from './http/openapi/register-openapi.js';

interface AppDependenciesBase {
  readonly publishing: PublishingService;
  readonly slots?: SlotRegistrationService;
  readonly deletion?: SlotDeletionService;
  readonly logger?: Logger;
}

export type AppDependencies = AppDependenciesBase &
  (
    | {
        readonly queries: SlotQueryService;
        readonly waits?: WaitRegistry;
        readonly defaults: { readonly waitTimeoutMs: number };
      }
    | {
        readonly queries?: undefined;
        readonly waits?: WaitRegistry;
        readonly defaults?: { readonly waitTimeoutMs: number };
      }
  );

const noopLogger: Logger = {
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Создаёт Fastify-приложение и при наличии зависимостей регистрирует HTTP-маршруты.
 * Вызов без аргументов сохранён для проверок базового приложения и не регистрирует маршруты.
 * Приложение не открывает порт; журналирование ошибок маршрутов можно настроить через logger.
 */
export function createApp(deps?: AppDependencies): FastifyInstance {
  const app = Fastify({
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });
  if (deps !== undefined) {
    void app.register(registerOpenApi);
    const logger = deps.logger ?? noopLogger;
    void app.register(publishRoute, {
      publishing: deps.publishing,
      logger,
    });
    if (deps.slots !== undefined) {
      void app.register(slotsRegisterRoute, {
        slots: deps.slots,
        logger,
      });
    }
    if (deps.deletion !== undefined) {
      void app.register(slotsDeleteRoute, {
        deletion: deps.deletion,
        logger,
      });
    }
    if (deps.queries !== undefined) {
      void app.register(slotsCountRoute, {
        queries: deps.queries,
        logger,
      });
      void app.register(slotsReadRoute, {
        queries: deps.queries,
        logger,
      });
      void app.register(slotsWaitRoute, {
        queries: deps.queries,
        ...(deps.waits === undefined ? {} : { waits: deps.waits }),
        defaults: deps.defaults,
        logger,
      });
    }
  }
  return app;
}

export function main(): void {
  createApp();
}

main();
