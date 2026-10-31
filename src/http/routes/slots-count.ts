import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from '../../application/ports/logger.js';
import type { SlotQueryService } from '../../application/slots/slot-queries.js';
import { parseCheckIndexForRead } from '../parsing/query-params.js';
import { mapErrorCode, mapCountResult } from '../responses/index.js';
import { apiErrorBodySchema, countResponseSchema } from '../schemas/index.js';
import { setRouteErrorHandler } from './error-handler.js';

export interface SlotsCountRouteDependencies {
  readonly queries: SlotQueryService;
  readonly logger: Logger;
}

/** Регистрирует операцию подсчёта записей проверки. */
export const slotsCountRoute: FastifyPluginAsync<SlotsCountRouteDependencies> = async (
  app,
  deps,
) => {
  app.get<{ Params: { id: string; index: string } }>(
    '/api/v1/slots/:id/checks/:index/count',
    {
      schema: {
        summary: 'Подсчитать записи',
        description: 'Возвращает количество записей, соответствующих проверке.',
        tags: ['Слоты'],
        params: {
          type: 'object',
          required: ['id', 'index'],
          properties: {
            id: { type: 'string' },
            index: { type: 'string' },
          },
        },
        response: {
          200: countResponseSchema,
          404: apiErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseCheckIndexForRead(request.params.index);
      if (parsed.kind === 'invalid') {
        const response = mapErrorCode('CHECK_NOT_FOUND');
        return reply.code(response.status).send(response.body);
      }

      const result = await deps.queries.count(request.params.id, parsed.value);
      const response = mapCountResult(result);
      return reply.code(response.status).send(response.body);
    },
  );

  setRouteErrorHandler(app, deps.logger);
};
