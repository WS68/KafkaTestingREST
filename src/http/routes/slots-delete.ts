import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from '../../application/ports/logger.js';
import type { SlotDeletionService } from '../../application/slots/slot-deletion.js';
import { mapSlotDeletionResult } from '../responses/index.js';
import { apiErrorBodySchema, emptyResponseSchema } from '../schemas/index.js';
import { setRouteErrorHandler } from './error-handler.js';

export interface SlotsDeleteRouteDependencies {
  readonly deletion: SlotDeletionService;
  readonly logger: Logger;
}

/** Регистрирует операцию удаления слота. */
export const slotsDeleteRoute: FastifyPluginAsync<SlotsDeleteRouteDependencies> = async (
  app,
  deps,
) => {
  app.delete<{ Params: { id: string } }>(
    '/api/v1/slots/:id',
    {
      schema: {
        summary: 'Удалить слот',
        description: 'Удаляет слот и прерывает связанные ожидания.',
        tags: ['Слоты'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: {
          200: emptyResponseSchema,
          404: apiErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const result = await deps.deletion.delete(request.params.id);
      const response = mapSlotDeletionResult(result);
      return reply.code(response.status).send(response.body);
    },
  );

  setRouteErrorHandler(app, deps.logger);
};
