import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../application/ports/logger.js';
import { mapUnexpectedError, mapValidationError } from '../responses/error-mapper.js';

/** Устанавливает единый обработчик ошибок маршрутов. */
export function setRouteErrorHandler(
  app: {
    setErrorHandler: (
      handler: (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => unknown,
    ) => unknown;
  },
  logger: Logger,
): void {
  app.setErrorHandler((error, _request, reply) => {
    const validationResponse = mapValidationError(error);
    const response = validationResponse ?? mapUnexpectedError(error, logger);
    return reply.code(response.status).send(response.body);
  });
}
