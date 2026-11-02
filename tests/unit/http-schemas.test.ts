import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  apiErrorBodySchema,
  emptyResponseSchema,
  publicationSchema,
  readRecordSchema,
  slotRegistrationSchema,
} from '../../src/http/schemas/index.js';

const ajv = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false });
const valid = (schema: object, value: unknown): boolean => ajv.compile(schema)(value);
const publication = { value: { data: 'hello' } };
const registration = { topic: 'events', checks: [{ values: [{ jsonPath: '$.id', value: '1' }] }] };

describe('HTTP-схемы', () => {
  it('проверяет публикацию и все варианты RecordDto без приведения значений', () => {
    expect(valid(publicationSchema, publication)).toBe(true);
    expect(valid(publicationSchema, { value: { type: 'STRING', data: 'text' } })).toBe(true);
    expect(valid(publicationSchema, { value: { type: 'BINARY', data: 'SGVsbG8=' } })).toBe(true);
    expect(valid(publicationSchema, { value: { type: 'JSON', data: { ok: true } } })).toBe(true);
    expect(valid(publicationSchema, { value: { data: null } })).toBe(true);
    expect(valid(publicationSchema, { value: { type: 'STRING' } })).toBe(false);
    expect(valid(publicationSchema, { ...publication, extra: true })).toBe(false);
    expect(valid(publicationSchema, { value: { type: 'XML', data: 'x' } })).toBe(false);
    expect(valid(publicationSchema, { headers: [{ name: 'x' }], value: { data: 'x' } })).toBe(
      false,
    );
    expect(valid(publicationSchema, {})).toBe(false);
  });

  it('проверяет формат записи при чтении', () => {
    const record = {
      headers: [],
      key: { type: 'BINARY', data: 'a2V5' },
      value: { type: 'JSON', data: {} },
    };
    expect(valid(readRecordSchema, record)).toBe(true);
    expect(valid(readRecordSchema, { ...record, key: { type: 'STRING', data: 'x' } })).toBe(false);
    expect(valid(readRecordSchema, { ...record, value: { type: 'STRING', data: 'x' } })).toBe(
      false,
    );
    expect(valid(readRecordSchema, { key: record.key, value: record.value })).toBe(false);
    expect(
      valid(readRecordSchema, { ...record, headers: [{ name: 'x', value: 'y', type: 'STRING' }] }),
    ).toBe(false);
  });

  it('проверяет регистрацию слота и обязательность полей', () => {
    expect(valid(slotRegistrationSchema, registration)).toBe(true);
    expect(valid(slotRegistrationSchema, { topic: 'events', checks: [] })).toBe(false);
    expect(valid(slotRegistrationSchema, { topic: 'events', checks: [{}] })).toBe(true);
    expect(valid(slotRegistrationSchema, { ...registration, autoDeleteSeconds: 0 })).toBe(false);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ headers: [{ name: 'x', value: 1 }] }],
      }),
    ).toBe(false);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ values: [{ jsonPath: '$', value: {} }] }],
      }),
    ).toBe(false);
  });

  it('проверяет operation, ignoreCase и строгую структуру элементов условий', () => {
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [
          {
            headers: [
              { name: 'x-equals', value: 'one', operation: 'EQUALS', ignoreCase: true },
              { name: 'x-contains', value: 'two', operation: 'CONTAINS', ignoreCase: false },
            ],
            values: [
              { jsonPath: '$.equals', value: 'one', operation: 'EQUALS', ignoreCase: true },
              { jsonPath: '$.contains', value: 'two', operation: 'CONTAINS', ignoreCase: false },
            ],
          },
        ],
      }),
    ).toBe(true);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ headers: [{ name: 'x', value: 'one', operation: 'STARTS_WITH' }] }],
      }),
    ).toBe(false);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ values: [{ jsonPath: '$', value: 'one', operation: 'STARTS_WITH' }] }],
      }),
    ).toBe(false);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ headers: [{ name: 'x', value: 'one', ignoreCase: 'true' }] }],
      }),
    ).toBe(false);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ values: [{ jsonPath: '$', value: 'one', ignoreCase: 1 }] }],
      }),
    ).toBe(false);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [
          { headers: [{ name: 'x', value: 'one' }], values: [{ jsonPath: '$', value: 'one' }] },
        ],
      }),
    ).toBe(true);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ headers: [{ name: 'x', value: 'one', unexpected: true }] }],
      }),
    ).toBe(false);
    expect(
      valid(slotRegistrationSchema, {
        topic: 'events',
        checks: [{ values: [{ jsonPath: '$', value: 'one', unexpected: true }] }],
      }),
    ).toBe(false);
  });

  it('проверяет ошибку API и пустое тело ответа', () => {
    expect(valid(emptyResponseSchema, {})).toBe(true);
    expect(valid(emptyResponseSchema, { extra: 1 })).toBe(false);
    expect(
      valid(apiErrorBodySchema, { code: 'INVALID_REQUEST', message: 'Некорректный запрос.' }),
    ).toBe(true);
    expect(valid(apiErrorBodySchema, { code: 'INVALID_REQUEST', message: 'x', extra: true })).toBe(
      false,
    );
    expect(valid(apiErrorBodySchema, { code: 'UNKNOWN', message: 'x' })).toBe(false);
  });
});
