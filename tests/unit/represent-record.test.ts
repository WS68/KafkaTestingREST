import { expect, test } from 'vitest';
import {
  decodeValueJson,
  representRecord,
} from '../../src/application/reading/represent-record.js';
import { decodeStrictUtf8 } from '../../src/application/reading/strict-utf8.js';
import type { SourceHeader, SourceRecord } from '../../src/domain/record.js';

const textEncoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}

function raw(...numbers: number[]): Uint8Array {
  return new Uint8Array(numbers);
}

function sourceRecord(
  value: Uint8Array | undefined,
  options: { headers?: readonly SourceHeader[]; key?: Uint8Array } = {},
): SourceRecord {
  return {
    headers: options.headers ?? [],
    key: options.key,
    value,
  };
}

test('represents headers, a binary key, and a JSON object', () => {
  const result = representRecord(
    sourceRecord(bytes('{"a":1}'), {
      key: bytes('key'),
      headers: [{ name: bytes('trace'), value: bytes('привет') }],
    }),
  );

  expect(result).toEqual({
    kind: 'ok',
    record: {
      headers: [{ name: 'trace', value: 'привет' }],
      key: { type: 'BINARY', data: 'a2V5' },
      value: { type: 'JSON', data: { a: 1 } },
    },
  });
  if (result.kind !== 'ok') return;
  expect(result.record.key?.type).toBe('BINARY');
  expect(result.record.value.type).toBe('JSON');
  expect(typeof result.record.value.data).toBe('object');
  expect(result.record.value.data).not.toBe('{"a":1}');
});

test.each([
  { label: 'an empty header array', headers: [] },
  { label: 'missing headers', headers: undefined },
])('represents $label as an empty array', ({ headers }) => {
  const result = representRecord(
    headers === undefined ? sourceRecord(bytes('null')) : sourceRecord(bytes('null'), { headers }),
  );

  expect(result).toEqual({
    kind: 'ok',
    record: { headers: [], value: { type: 'JSON', data: null } },
  });
});

test('preserves duplicate header names, order, and multiplicity', () => {
  const headers: readonly SourceHeader[] = [
    { name: bytes('tag'), value: bytes('first') },
    { name: bytes('tag'), value: bytes('second') },
    { name: bytes('other'), value: bytes('third') },
  ];

  const result = representRecord(sourceRecord(bytes('true'), { headers }));

  expect(result).toEqual({
    kind: 'ok',
    record: {
      headers: [
        { name: 'tag', value: 'first' },
        { name: 'tag', value: 'second' },
        { name: 'other', value: 'third' },
      ],
      value: { type: 'JSON', data: true },
    },
  });
});

test('represents empty header value as an empty string', () => {
  const result = representRecord(
    sourceRecord(bytes('0'), { headers: [{ name: bytes('empty'), value: new Uint8Array(0) }] }),
  );

  expect(result).toEqual({
    kind: 'ok',
    record: {
      headers: [{ name: 'empty', value: '' }],
      value: { type: 'JSON', data: 0 },
    },
  });
});

test('omits an absent key and distinguishes it from an empty key', () => {
  const absent = representRecord(sourceRecord(bytes('null')));
  const empty = representRecord(sourceRecord(bytes('null'), { key: new Uint8Array(0) }));

  expect(absent).toEqual({
    kind: 'ok',
    record: { headers: [], value: { type: 'JSON', data: null } },
  });
  if (absent.kind === 'ok') expect('key' in absent.record).toBe(false);
  expect(empty).toEqual({
    kind: 'ok',
    record: {
      headers: [],
      key: { type: 'BINARY', data: '' },
      value: { type: 'JSON', data: null },
    },
  });
  if (empty.kind === 'ok') {
    expect(empty.record.key?.type).toBe('BINARY');
    expect(empty.record.key?.data).toBe('');
  }
});

test.each([
  { text: 'null', expected: null },
  { text: '"foo"', expected: 'foo' },
  { text: '[1,"two"]', expected: [1, 'two'] },
  { text: '1', expected: 1 },
  { text: '{}', expected: {} },
])('represents JSON $text as parsed data', ({ text, expected }) => {
  const result = representRecord(sourceRecord(bytes(text)));

  expect(result).toEqual({
    kind: 'ok',
    record: { headers: [], value: { type: 'JSON', data: expected } },
  });
});

test('does not treat JSON null as a missing value', () => {
  const result = representRecord(sourceRecord(bytes('null')));

  expect(result).toEqual({
    kind: 'ok',
    record: { headers: [], value: { type: 'JSON', data: null } },
  });
});

test('returns a page-level representation error for a missing value', () => {
  expect(representRecord(sourceRecord(undefined))).toEqual({
    kind: 'not-representable',
    reason: 'value-missing',
  });
});

test.each(['', '   ', '\n\t'])('rejects empty or whitespace-only JSON: %j', (text) => {
  expect(representRecord(sourceRecord(bytes(text)))).toEqual({
    kind: 'not-representable',
    reason: 'value-invalid-json',
  });
});

test.each([
  { label: 'an invalid lead byte', value: raw(0xff) },
  { label: 'a truncated sequence', value: raw(0xc3) },
  { label: 'a UTF-8 encoded surrogate', value: raw(0xed, 0xa0, 0x80) },
])('rejects $label without U+FFFD', ({ value }) => {
  const result = representRecord(sourceRecord(value));

  expect(result).toEqual({ kind: 'not-representable', reason: 'value-invalid-utf8' });
  expect(JSON.stringify(result)).not.toContain('\uFFFD');
});

test.each([
  { label: 'an invalid name', header: { name: raw(0xff), value: bytes('ok') } },
  { label: 'an invalid value', header: { name: bytes('name'), value: raw(0xc3) } },
])('rejects a header with $label without U+FFFD', ({ header }) => {
  const result = representRecord(sourceRecord(bytes('null'), { headers: [header] }));

  expect(result).toEqual({ kind: 'not-representable', reason: 'header-value-invalid' });
  expect(JSON.stringify(result)).not.toContain('\uFFFD');
});

test('rejects an absent header value instead of dropping the header', () => {
  expect(
    representRecord(
      sourceRecord(bytes('null'), { headers: [{ name: bytes('missing'), value: undefined }] }),
    ),
  ).toEqual({ kind: 'not-representable', reason: 'header-value-invalid' });
});

test('accepts a valid U+FFFD and the strict decoder accepts its UTF-8 bytes', () => {
  const text = 'a\uFFFDb';
  const result = representRecord(sourceRecord(bytes(JSON.stringify(text))));

  expect(result).toEqual({
    kind: 'ok',
    record: { headers: [], value: { type: 'JSON', data: text } },
  });
  expect(decodeStrictUtf8(raw(0xef, 0xbf, 0xbd))).toBe('\uFFFD');
  expect(decodeStrictUtf8(raw(0xef, 0xbf, 0xbd))).not.toBeUndefined();
});

test.each([
  { label: 'an absent value', value: undefined, expected: { kind: 'missing' } },
  { label: 'invalid UTF-8', value: raw(0xff), expected: { kind: 'invalid-utf8' } },
  { label: 'invalid JSON', value: bytes('foobar'), expected: { kind: 'invalid-json' } },
  { label: 'JSON null', value: bytes('null'), expected: { kind: 'ok', value: null } },
])('decodeValueJson independently returns $label', ({ value, expected }) => {
  expect(decodeValueJson(value)).toEqual(expected);
});

test('does not restore the source publication type', () => {
  const stringPublication = representRecord(sourceRecord(bytes('{"a":1}')));
  const jsonPublication = representRecord(sourceRecord(bytes('{"a":1}')));
  const stringText = representRecord(sourceRecord(bytes('foobar')));

  expect(stringPublication).toEqual(jsonPublication);
  expect(stringPublication).toEqual({
    kind: 'ok',
    record: { headers: [], value: { type: 'JSON', data: { a: 1 } } },
  });
  expect(stringText).toEqual({ kind: 'not-representable', reason: 'value-invalid-json' });
});

test('does not mutate source bytes', () => {
  const record: SourceRecord = {
    headers: [{ name: bytes('name'), value: bytes('header') }],
    key: bytes('key'),
    value: bytes('{"a":1}'),
  };
  const before = {
    headerName: Array.from(record.headers[0]?.name ?? []),
    headerValue: Array.from(record.headers[0]?.value ?? []),
    key: Array.from(record.key ?? []),
    value: Array.from(record.value ?? []),
  };

  expect(representRecord(record).kind).toBe('ok');
  expect(Array.from(record.headers[0]?.name ?? [])).toEqual(before.headerName);
  expect(Array.from(record.headers[0]?.value ?? [])).toEqual(before.headerValue);
  expect(Array.from(record.key ?? [])).toEqual(before.key);
  expect(Array.from(record.value ?? [])).toEqual(before.value);
});
