import type { FastifySchema } from 'fastify';

/** Схема представления записи, полученной при чтении. */
export const readRecordSchema = {
  type: 'object',
  required: ['headers', 'value'],
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
        },
      },
    },
    key: {
      type: 'object',
      required: ['type', 'data'],
      additionalProperties: false,
      properties: {
        type: { const: 'BINARY' },
        data: { type: 'string' },
      },
    },
    value: {
      type: 'object',
      required: ['type', 'data'],
      additionalProperties: false,
      properties: {
        type: { const: 'JSON' },
        data: {},
      },
    },
  },
} as const satisfies FastifySchema['response'];

export type ReadRecordSchema = typeof readRecordSchema;
