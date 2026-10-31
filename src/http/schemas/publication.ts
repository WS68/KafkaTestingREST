import type { FastifySchema } from 'fastify';

const recordDataType = {
  type: 'string',
  enum: ['STRING', 'BINARY', 'JSON'],
} as const;

const publicationPayloadSchema = {
  type: 'object',
  required: ['data'],
  additionalProperties: false,
  properties: {
    type: recordDataType,
    data: {},
  },
} as const;

/** Схема входной записи для публикации. */
export const publicationSchema = {
  type: 'object',
  required: ['value'],
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
          type: recordDataType,
          value: {},
        },
      },
    },
    key: publicationPayloadSchema,
    value: publicationPayloadSchema,
  },
} as const satisfies FastifySchema['body'];

export type PublicationSchema = typeof publicationSchema;
