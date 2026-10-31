export type SlotRegistrationResponseDto = {
  id: string;
};

export type CountResponseDto = {
  count: number;
};

export type EmptyResponseDto = {
  readonly [key: string]: never;
};

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RECORD_TYPE'
  | 'INVALID_BASE64'
  | 'TOPIC_NOT_ALLOWED'
  | 'SLOT_NOT_FOUND'
  | 'CHECK_NOT_FOUND'
  | 'SLOT_DELETED'
  | 'KAFKA_UNAVAILABLE'
  | 'SERVICE_STOPPING'
  | 'RECORD_NOT_REPRESENTABLE'
  | 'INTERNAL_ERROR';

export type ApiErrorBodyDto = {
  code: ApiErrorCode;
  message: string;
};
