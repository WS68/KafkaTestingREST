import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from '../../application/ports/logger.js';
import type { ReadRecordDto } from '../dto/read-record.js';
import type { SlotQueryService } from '../../application/slots/slot-queries.js';
import { representRecord } from '../../application/reading/represent-record.js';
import { parseReadParams } from '../parsing/query-params.js';
import { mapErrorCode, mapReadResult } from '../responses/index.js';
import { apiErrorBodySchema, readQuerySchema, readRecordSchema } from '../schemas/index.js';
import { setRouteErrorHandler } from './error-handler.js';

export interface SlotsReadRouteDependencies {
  readonly queries: SlotQueryService;
  readonly logger: Logger;
}

/** Регистрирует операцию чтения страницы записей проверки. */
export const slotsReadRoute: FastifyPluginAsync<SlotsReadRouteDependencies> = async (app, deps) => {
  app.get<{
    Params: { id: string; index: string };
    Querystring: { offset?: string; count?: string };
  }>(
    '/api/v1/slots/:id/checks/:index',
    {
      schema: {
        summary: 'Прочитать записи',
        description: 'Возвращает страницу записей, offset по умолчанию 0, count по умолчанию 20.',
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
          ...readQuerySchema,
          properties: {
            ...readQuerySchema.properties,
            offset: {
              ...readQuerySchema.properties.offset,
              description: 'Смещение, по умолчанию 0.',
            },
            count: {
              ...readQuerySchema.properties.count,
              description: 'Лимит выборки, по умолчанию 20.',
            },
          },
        },
        response: {
          200: { type: 'array', items: readRecordSchema },
          400: apiErrorBodySchema,
          404: apiErrorBodySchema,
          500: apiErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseReadParams(
        request.params.index,
        request.query.offset,
        request.query.count,
      );
      if (parsed.kind === 'invalid-index') {
        const response = mapErrorCode('CHECK_NOT_FOUND');
        return reply.code(response.status).send(response.body);
      }
      if (parsed.kind === 'invalid-pagination') {
        const response = mapErrorCode('INVALID_REQUEST');
        return reply.code(response.status).send(response.body);
      }

      const result = await deps.queries.read(
        request.params.id,
        Number(request.params.index),
        parsed.value.offset,
        parsed.value.count,
      );
      if (result.kind === 'records') {
        const represented: ReadRecordDto[] = [];
        for (const record of result.records) {
          const representation = representRecord(record);
          if (representation.kind !== 'ok') {
            const response = mapErrorCode('RECORD_NOT_REPRESENTABLE');
            return reply.code(response.status).send(response.body);
          }
          represented.push(representation.record);
        }

        // mapReadResult принимает уже представленные записи, а не SourceRecord[].
        const response = mapReadResult({ kind: 'records', records: represented });
        return reply.code(response.status).send(response.body);
      }

      const response = mapReadResult(result);
      return reply.code(response.status).send(response.body);
    },
  );

  setRouteErrorHandler(app, deps.logger);
};
