import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/application/ports/logger.js';
import {
  mapCountResult,
  mapErrorCode,
  mapPublishResult,
  mapReadResult,
  mapSlotRegistrationResult,
  mapUnexpectedError,
  mapValidationError,
  mapWaitResult,
} from '../../src/http/responses/index.js';

const codes = {
  INVALID_REQUEST: 400,
  INVALID_RECORD_TYPE: 400,
  INVALID_BASE64: 400,
  TOPIC_NOT_ALLOWED: 400,
  SLOT_NOT_FOUND: 404,
  CHECK_NOT_FOUND: 404,
  SLOT_DELETED: 409,
  KAFKA_UNAVAILABLE: 503,
  SERVICE_STOPPING: 503,
  RECORD_NOT_REPRESENTABLE: 500,
  INTERNAL_ERROR: 500,
} as const;

describe('HTTP-мапперы ошибок и результатов', () => {
  it('возвращает все публичные ошибки в единой форме', () => {
    for (const [code, status] of Object.entries(codes)) {
      const response = mapErrorCode(code as keyof typeof codes);
      expect(response.status).toBe(status);
      expect(response.body.message.length).toBeGreaterThan(0);
      expect(Object.keys(response.body).sort()).toEqual(['code', 'message']);
    }
  });

  it('маппит каждый вариант публикации', () => {
    expect(mapPublishResult({ kind: 'published', ack: 'broker' }).status).toBe(201);
    expect(mapPublishResult({ kind: 'accepted', ack: 'none' }).status).toBe(202);
    expect(mapPublishResult({ kind: 'topic-not-allowed' }).body).toMatchObject({
      code: 'TOPIC_NOT_ALLOWED',
    });
    expect(
      mapPublishResult({ kind: 'invalid-record', reason: 'invalid-record-type' }).body,
    ).toMatchObject({ code: 'INVALID_RECORD_TYPE' });
    expect(
      mapPublishResult({ kind: 'invalid-record', reason: 'invalid-base64' }).body,
    ).toMatchObject({ code: 'INVALID_BASE64' });
    expect(
      mapPublishResult({ kind: 'kafka-unavailable', stage: 'before-acceptance' }).body,
    ).toMatchObject({ code: 'KAFKA_UNAVAILABLE' });
  });

  it('сохраняет ответы чтения, регистрации и различие результата индекса по операциям', () => {
    expect(mapReadResult({ kind: 'not-representable' })).toMatchObject({
      status: 500,
      body: { code: 'RECORD_NOT_REPRESENTABLE' },
    });
    expect(mapReadResult({ kind: 'records', records: [] })).toEqual({ status: 200, body: [] });
    expect(
      mapSlotRegistrationResult({ kind: 'registered', slotId: 'slot-1' as never, checkCount: 1 }),
    ).toEqual({ status: 201, body: { id: 'slot-1' } });
    expect(mapCountResult({ kind: 'check-not-found' })).toMatchObject({
      status: 404,
      body: { code: 'CHECK_NOT_FOUND' },
    });
    expect(mapWaitResult({ kind: 'invalid-request' })).toMatchObject({
      status: 400,
      body: { code: 'INVALID_REQUEST' },
    });
  });

  it('тайм-аут ожидания возвращает строго пустое тело', () => {
    expect(mapWaitResult({ kind: 'timeout' })).toEqual({ status: 504, body: {} });
  });

  it('распознаёт ошибки валидации и скрывает неожиданную ошибку', () => {
    expect(mapValidationError({ validation: [] })).toMatchObject({
      status: 400,
      body: { code: 'INVALID_REQUEST' },
    });
    expect(mapValidationError({ statusCode: 400 })).toMatchObject({
      status: 400,
      body: { code: 'INVALID_REQUEST' },
    });
    expect(mapValidationError(new Error('ordinary'))).toBeUndefined();

    const logger = {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies Logger;
    const response = mapUnexpectedError(new Error('boom'), logger);
    expect(response).toMatchObject({ status: 500, body: { code: 'INTERNAL_ERROR' } });
    if ('message' in response.body) expect(response.body.message).not.toContain('boom');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
