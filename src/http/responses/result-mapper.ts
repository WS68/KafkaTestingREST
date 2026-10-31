import type {
  CountResult,
  PublishResult,
  ReadResult,
  SlotDeletionResult,
  SlotRegistrationResult,
  WaitResult,
} from '../../application/results/index.js';
import type { ReadRecordDto } from '../dto/read-record.js';
import type { ApiHttpResponse } from './error-mapper.js';
import { mapErrorCode } from './error-mapper.js';

const emptyBody = {};

/** Преобразует результат публикации в HTTP-ответ. */
export function mapPublishResult(result: PublishResult): ApiHttpResponse {
  switch (result.kind) {
    case 'published':
      return { status: 201, body: emptyBody };
    case 'accepted':
      return { status: 202, body: emptyBody };
    case 'topic-not-allowed':
      return mapErrorCode('TOPIC_NOT_ALLOWED');
    case 'invalid-record':
      return mapErrorCode(
        result.reason === 'invalid-record-type' ? 'INVALID_RECORD_TYPE' : 'INVALID_BASE64',
      );
    case 'kafka-unavailable':
      return mapErrorCode('KAFKA_UNAVAILABLE');
  }
}

/** Преобразует результат подсчёта в HTTP-ответ. */
export function mapCountResult(result: CountResult): ApiHttpResponse {
  switch (result.kind) {
    case 'counted':
      return { status: 200, body: { count: result.count } };
    case 'slot-not-found':
      return mapErrorCode('SLOT_NOT_FOUND');
    case 'check-not-found':
      return mapErrorCode('CHECK_NOT_FOUND');
  }
}

/** Преобразует уже представленные записи в HTTP-ответ. */
type RepresentedReadResult =
  | Exclude<ReadResult, { readonly kind: 'records' }>
  | { readonly kind: 'records'; readonly records: readonly ReadRecordDto[] };

export function mapReadResult(result: RepresentedReadResult): ApiHttpResponse {
  switch (result.kind) {
    case 'records':
      return { status: 200, body: result.records };
    case 'not-representable':
      return mapErrorCode('RECORD_NOT_REPRESENTABLE');
    case 'invalid-pagination':
      return mapErrorCode('INVALID_REQUEST');
    case 'slot-not-found':
      return mapErrorCode('SLOT_NOT_FOUND');
    case 'check-not-found':
      return mapErrorCode('CHECK_NOT_FOUND');
  }
}

/** Преобразует результат асинхронного ожидания в HTTP-ответ. */
export function mapWaitResult(result: WaitResult): ApiHttpResponse {
  switch (result.kind) {
    case 'condition-met':
      return { status: 200, body: emptyBody };
    case 'timeout':
      return { status: 504, body: emptyBody };
    case 'slot-deleted':
      return mapErrorCode('SLOT_DELETED');
    case 'service-stopping':
      return mapErrorCode('SERVICE_STOPPING');
    case 'slot-not-found':
      return mapErrorCode('SLOT_NOT_FOUND');
    case 'check-not-found':
      return mapErrorCode('CHECK_NOT_FOUND');
    case 'invalid-request':
      return mapErrorCode('INVALID_REQUEST');
  }
}

/** Преобразует результат удаления слота в HTTP-ответ. */
export function mapSlotDeletionResult(result: SlotDeletionResult): ApiHttpResponse {
  switch (result.kind) {
    case 'deleted':
      return { status: 200, body: emptyBody };
    case 'not-found':
      return mapErrorCode('SLOT_NOT_FOUND');
  }
}

/** Преобразует результат регистрации слота в HTTP-ответ. */
export function mapSlotRegistrationResult(result: SlotRegistrationResult): ApiHttpResponse {
  switch (result.kind) {
    case 'registered':
      return { status: 201, body: { id: result.slotId } };
    case 'invalid-request':
      return mapErrorCode('INVALID_REQUEST');
    case 'kafka-unavailable':
      return mapErrorCode('KAFKA_UNAVAILABLE');
  }
}
