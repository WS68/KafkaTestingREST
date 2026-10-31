import type { Logger } from '../../application/ports/logger.js';
import type { ApiErrorBodyDto, ApiErrorCode, EmptyResponseDto } from '../dto/responses.js';

/** Ответ HTTP, подготовленный адаптером для выдачи клиенту. */
export interface ApiHttpResponse {
  readonly status: number;
  readonly body: EmptyResponseDto | ApiErrorBodyDto | Record<string, unknown> | readonly unknown[];
}

/** Преобразует публичный код ошибки в безопасное единое HTTP-представление. */
export function mapErrorCode(code: ApiErrorCode): { status: number; body: ApiErrorBodyDto } {
  switch (code) {
    case 'INVALID_REQUEST':
      return { status: 400, body: { code, message: 'Некорректный запрос.' } };
    case 'INVALID_RECORD_TYPE':
      return { status: 400, body: { code, message: 'Недопустимый тип записи.' } };
    case 'INVALID_BASE64':
      return { status: 400, body: { code, message: 'Некорректные двоичные данные.' } };
    case 'TOPIC_NOT_ALLOWED':
      return { status: 400, body: { code, message: 'Публикация в этот топик запрещена.' } };
    case 'SLOT_NOT_FOUND':
      return { status: 404, body: { code, message: 'Слот не найден.' } };
    case 'CHECK_NOT_FOUND':
      return { status: 404, body: { code, message: 'Проверка не найдена.' } };
    case 'SLOT_DELETED':
      return { status: 409, body: { code, message: 'Слот удалён.' } };
    case 'KAFKA_UNAVAILABLE':
      return { status: 503, body: { code, message: 'Kafka временно недоступна.' } };
    case 'SERVICE_STOPPING':
      return { status: 503, body: { code, message: 'Сервис останавливается.' } };
    case 'RECORD_NOT_REPRESENTABLE':
      return { status: 500, body: { code, message: 'Запись невозможно представить в ответе.' } };
    case 'INTERNAL_ERROR':
      return { status: 500, body: { code, message: 'Внутренняя ошибка сервера.' } };
    default: {
      const exhaustiveCheck: never = code;
      return exhaustiveCheck;
    }
  }
}

/** Преобразует неожиданную внутреннюю ошибку без раскрытия её подробностей. */
export function mapUnexpectedError(error: unknown, logger: Logger): ApiHttpResponse {
  const reason = error instanceof Error ? 'exception' : typeof error;
  logger.error('http-unexpected-error', { reason });
  return mapErrorCode('INTERNAL_ERROR');
}

/**
 * Распознаёт ошибки валидации Fastify как некорректный запрос. Ошибки схемы
 * не должны подменять CHECK_NOT_FOUND: индекс операции проверяется результатом
 * parsing из HTTP-адаптера, а не схемой Fastify.
 */
export function mapValidationError(error: unknown): ApiHttpResponse | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { readonly statusCode?: unknown };
  if ('validation' in error || candidate.statusCode === 400) {
    return mapErrorCode('INVALID_REQUEST');
  }

  return undefined;
}
