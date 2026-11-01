import type { ReadonlyBytes, SourceRecord } from '../../domain/record.js';
import { encodeBase64 } from './base64.js';
import type { RepresentableRecord } from './read-record-model.js';
import { decodeStrictUtf8 } from './strict-utf8.js';

export type DecodeValueJsonResult =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid-utf8' }
  | { readonly kind: 'invalid-json' };

export type RepresentRecordResult =
  | { readonly kind: 'ok'; readonly record: RepresentableRecord }
  | {
      readonly kind: 'not-representable';
      readonly reason:
        'header-value-invalid' | 'value-missing' | 'value-invalid-utf8' | 'value-invalid-json';
    };

export function decodeValueJson(bytes: ReadonlyBytes | undefined): DecodeValueJsonResult {
  if (bytes === undefined) return { kind: 'missing' };

  const text = decodeStrictUtf8(bytes);
  if (text === undefined) return { kind: 'invalid-utf8' };

  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'invalid-json' };
  }
}

export function representRecord(record: SourceRecord): RepresentRecordResult {
  const headers: Array<{ name: string; value: string }> = [];

  for (const header of record.headers) {
    const name = decodeStrictUtf8(header.name);
    if (name === undefined || header.value === undefined) {
      return { kind: 'not-representable', reason: 'header-value-invalid' };
    }

    const value = decodeStrictUtf8(header.value);
    if (value === undefined) {
      return { kind: 'not-representable', reason: 'header-value-invalid' };
    }

    headers.push({ name, value });
  }

  const value = decodeValueJson(record.value);
  if (value.kind === 'missing') {
    return { kind: 'not-representable', reason: 'value-missing' };
  }
  if (value.kind === 'invalid-utf8') {
    return { kind: 'not-representable', reason: 'value-invalid-utf8' };
  }
  if (value.kind === 'invalid-json') {
    return { kind: 'not-representable', reason: 'value-invalid-json' };
  }

  const represented: RepresentableRecord = {
    headers,
    value: { type: 'JSON', data: value.value },
  };
  if (record.key !== undefined) {
    represented.key = { type: 'BINARY', data: encodeBase64(record.key) };
  }

  return { kind: 'ok', record: represented };
}
