import type { FastifySchema } from 'fastify';

const checkSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'value'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          operation: { type: 'string', enum: ['EQUALS', 'CONTAINS'] },
          ignoreCase: { type: 'boolean' },
        },
      },
    },
    values: {
      type: 'array',
      items: {
        type: 'object',
        required: ['jsonPath', 'value'],
        additionalProperties: false,
        properties: {
          jsonPath: { type: 'string', minLength: 1 },
          value: { type: 'string' },
          operation: { type: 'string', enum: ['EQUALS', 'CONTAINS'] },
          ignoreCase: { type: 'boolean' },
        },
      },
    },
  },
} as const;

/** Схема тела регистрации слота. */
export const slotRegistrationSchema = {
  type: 'object',
  required: ['topic', 'checks'],
  additionalProperties: false,
  properties: {
    topic: { type: 'string', minLength: 1 },
    autoDeleteSeconds: { type: 'integer', minimum: 1 },
    checks: {
      type: 'array',
      minItems: 1,
      items: checkSchema,
    },
  },
} as const satisfies FastifySchema['body'];

/** Схема ответа регистрации слота. */
export const slotRegistrationResponseSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
  },
} as const satisfies FastifySchema['response'];

/** Схема ответа с количеством записей. */
export const countResponseSchema = {
  type: 'object',
  required: ['count'],
  additionalProperties: false,
  properties: {
    count: { type: 'integer', minimum: 0 },
  },
} as const satisfies FastifySchema['response'];

// Строгий разбор строковых значений и различение ошибок индекса выполняет задача 65; схема не приводит значения молча.
/** Схема параметров ожидания. */
export const waitQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    n: { type: 'string' },
    timeoutMs: { type: 'string' },
  },
} as const satisfies FastifySchema['querystring'];

/** Схема параметров чтения. */
export const readQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    offset: { type: 'string' },
    count: { type: 'string' },
  },
} as const satisfies FastifySchema['querystring'];

export type SlotRegistrationSchema = typeof slotRegistrationSchema;
export type SlotRegistrationResponseSchema = typeof slotRegistrationResponseSchema;
export type CountResponseSchema = typeof countResponseSchema;
export type WaitQuerySchema = typeof waitQuerySchema;
export type ReadQuerySchema = typeof readQuerySchema;
