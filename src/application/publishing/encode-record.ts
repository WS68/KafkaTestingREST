import type { PublicationRecordBytes } from '../ports/kafka-publisher.js';
import { encodeBase64 } from '../reading/base64.js';
import type { RecordDataType, RecordDto } from './publication-input.js';

type EncodePayloadResult =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  | { readonly kind: 'invalid-record-type' }
  | { readonly kind: 'invalid-base64' };

type PayloadInput = { readonly type?: unknown; readonly data: unknown };

export type EncodeRecordResult =
  | { readonly kind: 'ok'; readonly record: PublicationRecordBytes }
  | { readonly kind: 'invalid-record-type' }
  | { readonly kind: 'invalid-base64' };

const textEncoder = new TextEncoder();

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length === 0) return new Uint8Array(0);
  if (value.length % 4 !== 0) return undefined;

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataLength = value.length - padding;
  const firstPaddingIndex = value.indexOf('=');

  if (firstPaddingIndex !== (padding === 0 ? -1 : dataLength)) return undefined;
  if (padding === 0 ? dataLength % 4 !== 0 : dataLength % 4 !== 4 - padding) {
    return undefined;
  }

  for (let index = 0; index < dataLength; index += 1) {
    if (base64Value(value.charCodeAt(index)) < 0) return undefined;
  }

  if (padding > 0) {
    const lastValue = base64Value(value.charCodeAt(dataLength - 1));
    const unusedBits = padding === 1 ? 2 : 4;
    if ((lastValue & ((1 << unusedBits) - 1)) !== 0) return undefined;
  }

  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let byteIndex = 0;

  for (let offset = 0; offset < value.length; offset += 4) {
    const first = base64Value(value.charCodeAt(offset));
    const second = base64Value(value.charCodeAt(offset + 1));
    const third =
      value.charCodeAt(offset + 2) === 61 ? 0 : base64Value(value.charCodeAt(offset + 2));
    const fourth =
      value.charCodeAt(offset + 3) === 61 ? 0 : base64Value(value.charCodeAt(offset + 3));

    if (byteIndex < bytes.length) bytes[byteIndex++] = (first << 2) | (second >>> 4);
    if (byteIndex < bytes.length) bytes[byteIndex++] = ((second & 0x0f) << 4) | (third >>> 2);
    if (byteIndex < bytes.length) bytes[byteIndex++] = ((third & 0x03) << 6) | fourth;
  }

  return encodeBase64(bytes) === value ? bytes : undefined;
}

function isPayloadInput(value: unknown): value is PayloadInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodePayload(
  data: unknown,
  type: unknown,
  defaultType: RecordDataType,
): EncodePayloadResult {
  const resolvedType = type === undefined ? defaultType : type;

  if (resolvedType !== 'STRING' && resolvedType !== 'BINARY' && resolvedType !== 'JSON') {
    return { kind: 'invalid-record-type' };
  }

  if (resolvedType === 'STRING') {
    return typeof data === 'string'
      ? { kind: 'ok', bytes: textEncoder.encode(data) }
      : { kind: 'invalid-record-type' };
  }

  if (resolvedType === 'BINARY') {
    if (typeof data !== 'string') return { kind: 'invalid-record-type' };
    const bytes = decodeBase64(data);
    return bytes === undefined ? { kind: 'invalid-base64' } : { kind: 'ok', bytes };
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return { kind: 'invalid-record-type' };
  }

  return serialized === undefined
    ? { kind: 'invalid-record-type' }
    : { kind: 'ok', bytes: textEncoder.encode(serialized) };
}

function invalidResult(result: EncodePayloadResult): EncodeRecordResult {
  return result.kind === 'invalid-base64'
    ? { kind: 'invalid-base64' }
    : { kind: 'invalid-record-type' };
}

export function encodeRecord(record: RecordDto): EncodeRecordResult {
  if (record.headers !== undefined && !Array.isArray(record.headers)) {
    return { kind: 'invalid-record-type' };
  }
  if (!isPayloadInput(record.value)) return { kind: 'invalid-record-type' };

  const encodedHeaders: PublicationRecordBytes['headers'][number][] = [];
  for (const header of record.headers ?? []) {
    if (!isPayloadInput(header) || typeof header.name !== 'string') {
      return { kind: 'invalid-record-type' };
    }

    const encodedValue = encodePayload(header.value, header.type, 'STRING');
    if (encodedValue.kind !== 'ok') return invalidResult(encodedValue);
    encodedHeaders.push({ name: textEncoder.encode(header.name), value: encodedValue.bytes });
  }

  let encodedKey: Uint8Array | undefined;
  if (record.key !== undefined) {
    if (!isPayloadInput(record.key)) return { kind: 'invalid-record-type' };
    const key = encodePayload(record.key.data, record.key.type, 'STRING');
    if (key.kind !== 'ok') return invalidResult(key);
    encodedKey = key.bytes;
  }

  const encodedValue = encodePayload(record.value.data, record.value.type, 'JSON');
  if (encodedValue.kind !== 'ok') return invalidResult(encodedValue);

  return {
    kind: 'ok',
    record: {
      key: encodedKey,
      value: encodedValue.bytes,
      headers: encodedHeaders,
    },
  };
}
