import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from '../../application/ports/logger.js';
import type { SlotRegistrationService } from '../../application/slots/slot-registration.js';
import type { SlotRegistrationRequestDto } from '../dto/slot.js';
import { mapSlotRegistrationResult } from '../responses/index.js';
import { setRouteErrorHandler } from './error-handler.js';
import {
  apiErrorBodySchema,
  slotRegistrationResponseSchema,
  slotRegistrationSchema,
} from '../schemas/index.js';

export interface SlotsRegisterRouteDependencies {
  readonly slots: SlotRegistrationService;
  readonly logger: Logger;
}

/** Регистрирует операцию регистрации слота. */
export const slotsRegisterRoute: FastifyPluginAsync<SlotsRegisterRouteDependencies> = async (
  app,
  deps,
) => {
  app.post<{ Body: SlotRegistrationRequestDto }>(
    '/api/v1/slots',
    {
      schema: {
        summary: 'Зарегистрировать слот',
        description: 'Создаёт слот для наблюдения за записями топика Kafka.',
        tags: ['Слоты'],
        body: slotRegistrationSchema,
        response: {
          201: slotRegistrationResponseSchema,
          400: apiErrorBodySchema,
          503: apiErrorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const { topic, checks, autoDeleteSeconds } = request.body;
      const result = await deps.slots.register({
        topic,
        checks,
        ...(autoDeleteSeconds === undefined ? {} : { autoDeleteSeconds }),
      });
      const response = mapSlotRegistrationResult(result);
      return reply.code(response.status).send(response.body);
    },
  );

  setRouteErrorHandler(app, deps.logger);
};
