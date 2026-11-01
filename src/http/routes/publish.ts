import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from '../../application/ports/logger.js';
import type { RecordDto } from '../../application/publishing/publication-input.js';
import type { PublishingService } from '../../application/publishing/publishing-service.js';
import { parseAckMode } from '../parsing/index.js';
import { mapErrorCode, mapPublishResult } from '../responses/index.js';
import { apiErrorBodySchema, emptyResponseSchema, publicationSchema } from '../schemas/index.js';
import { setRouteErrorHandler } from './error-handler.js';

export interface PublishRouteDependencies {
  readonly publishing: PublishingService;
  readonly logger: Logger;
}

/** Регистрирует операцию публикации записи. */
export const publishRoute: FastifyPluginAsync<PublishRouteDependencies> = async (app, deps) => {
  app.post<{ Params: { name: string }; Querystring: { ack?: string }; Body: RecordDto }>(
    '/api/v1/topics/:name/records',
    {
      schema: {
        summary: 'Опубликовать запись',
        description: 'Публикует запись в топик Kafka.',
        tags: ['Публикация'],
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ack: {
              type: 'string',
              enum: ['0', '1'],
              description: 'Режим подтверждения: 1 по умолчанию.',
            },
          },
        },
        body: publicationSchema,
        response: {
          201: emptyResponseSchema,
          202: emptyResponseSchema,
          400: apiErrorBodySchema,
          503: apiErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const parsedAck = parseAckMode(request.query.ack);
      if (parsedAck.kind === 'invalid') {
        const response = mapErrorCode('INVALID_REQUEST');
        return reply.code(response.status).send(response.body);
      }

      const result = await deps.publishing.publish({
        topic: request.params.name,
        record: request.body,
        ack: parsedAck.value,
      });
      const response = mapPublishResult(result);
      return reply.code(response.status).send(response.body);
    },
  );

  setRouteErrorHandler(app, deps.logger);
};
