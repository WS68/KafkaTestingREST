import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from '../../application/ports/logger.js';
import type { SlotQueryService } from '../../application/slots/slot-queries.js';
import type { WaitRegistry } from '../../application/waiting/wait-registry.js';
import { parseWaitParams } from '../parsing/query-params.js';
import { mapErrorCode, mapWaitResult } from '../responses/index.js';
import { apiErrorBodySchema, emptyResponseSchema, waitQuerySchema } from '../schemas/index.js';
import { setRouteErrorHandler } from './error-handler.js';

export interface SlotsWaitRouteDependencies {
  readonly queries: SlotQueryService;
  readonly waits?: WaitRegistry;
  readonly defaults: { readonly waitTimeoutMs: number };
  readonly logger: Logger;
}

/** Регистрирует операцию асинхронного ожидания. */
export const slotsWaitRoute: FastifyPluginAsync<SlotsWaitRouteDependencies> = async (app, deps) => {
  app.post<{
    Params: { id: string; index: string };
    Querystring: { n?: string; timeoutMs?: string };
  }>(
    '/api/v1/slots/:id/checks/:index/wait',
    {
      schema: {
        summary: 'Ожидать запись',
        description: 'Ожидает выполнения проверки в слоте; n по умолчанию 1.',
        tags: ['Слоты'],
        params: {
          type: 'object',
          required: ['id', 'index'],
          properties: {
            id: { type: 'string' },
            index: { type: 'string' },
          },
        },
        querystring: {
          ...waitQuerySchema,
          properties: {
            ...waitQuerySchema.properties,
            n: { ...waitQuerySchema.properties.n, description: 'Номер записи, по умолчанию 1.' },
            timeoutMs: {
              ...waitQuerySchema.properties.timeoutMs,
              description: 'Тайм-аут ожидания в миллисекундах, по умолчанию из конфигурации.',
            },
          },
        },
        response: {
          200: emptyResponseSchema,
          400: apiErrorBodySchema,
          404: apiErrorBodySchema,
          409: apiErrorBodySchema,
          503: apiErrorBodySchema,
          504: emptyResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseWaitParams(
        request.params.index,
        request.query.n,
        request.query.timeoutMs,
        deps.defaults,
      );
      if (parsed.kind === 'invalid-index' || parsed.kind === 'invalid-params') {
        const response = mapErrorCode('INVALID_REQUEST');
        return reply.code(response.status).send(response.body);
      }

      const handle = deps.queries.waitWithHandle(
        request.params.id,
        Number(request.params.index),
        parsed.value,
      );
      let disconnected = false;
      const onClose = (): void => {
        if (reply.raw.writableEnded) return;
        disconnected = true;
        if (handle.waitId !== undefined) {
          try {
            deps.waits?.cancel(handle.waitId);
          } catch {
            // Освобождение ожидания не должно порождать дополнительный HTTP-ответ.
          }
        }
      };
      reply.raw.once('close', onClose);

      try {
        const result = await handle.result;
        if (disconnected || reply.sent) return;
        const response = mapWaitResult(result);
        return reply.code(response.status).send(response.body);
      } catch {
        if (disconnected || reply.sent) return;
        throw new Error('Не удалось завершить ожидание.');
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  setRouteErrorHandler(app, deps.logger);
};
