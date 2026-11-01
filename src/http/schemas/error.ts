import type { FastifySchema } from 'fastify';

/** Схема тела ошибки API. */
export const apiErrorBodySchema = {
  type: 'object',
  required: ['code', 'message'],
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      enum: [
        'INVALID_REQUEST',
        'INVALID_RECORD_TYPE',
        'INVALID_BASE64',
        'TOPIC_NOT_ALLOWED',
        'SLOT_NOT_FOUND',
        'CHECK_NOT_FOUND',
        'SLOT_DELETED',
        'KAFKA_UNAVAILABLE',
        'SERVICE_STOPPING',
        'RECORD_NOT_REPRESENTABLE',
        'INTERNAL_ERROR',
      ],
    },
    message: { type: 'string' },
  },
} as const satisfies FastifySchema['response'];

/** Схема пустого ответа. */
export const emptyResponseSchema = {
  type: 'object',
  additionalProperties: false,
} as const satisfies FastifySchema['response'];

export type ApiErrorBodySchema = typeof apiErrorBodySchema;
export type EmptyResponseSchema = typeof emptyResponseSchema;
