import { expect, test } from 'vitest';
import { encodeRecord } from '../../src/application/publishing/encode-record.js';
import type { RecordDto } from '../../src/application/publishing/publication-input.js';

const textEncoder = new TextEncoder();

function expectBytes(actual: Uint8Array, expected: Uint8Array | readonly number[]): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

function encodedRecord(record: RecordDto) {
  const result = encodeRecord(record);
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error(`Unexpected result: ${result.kind}`);
  return result.record;
}

test.each([
  { label: 'ASCII text', data: 'foo', expected: [0x66, 0x6f, 0x6f] },
  {
    label: 'Cyrillic text',
    data: 'привет',
    expected: Array.from(textEncoder.encode('привет')),
  },
])('encodes STRING value as UTF-8 bytes: $label', ({ data, expected }) => {
  const record = encodedRecord({ value: { type: 'STRING', data } });
  expectBytes(record.value, expected);
});

test('encodes a JSON object compactly without external string quotes', () => {
  const data = { orderId: '42', status: 'CREATED' };
  const record = encodedRecord({ value: { type: 'JSON', data } });
  const json = '{"orderId":"42","status":"CREATED"}';

  expectBytes(record.value, textEncoder.encode(json));
  expect(Array.from(record.value)).not.toEqual(
    Array.from(textEncoder.encode(JSON.stringify(json))),
  );
});

test('serializes a JSON string once, including its data quotes', () => {
  const record = encodedRecord({ value: { type: 'JSON', data: 'foo' } });
  expectBytes(record.value, textEncoder.encode('"foo"'));
  expect(record.value).toHaveLength(5);
});

test('does not double-serialize a JSON string input', () => {
  const record = encodedRecord({ value: { type: 'JSON', data: '{"a":1}' } });
  expectBytes(record.value, textEncoder.encode('"{\\"a\\":1}"'));
  expect(Array.from(record.value)).not.toEqual(Array.from(textEncoder.encode('{"a":1}')));
});

test('decodes BINARY base64 into source bytes instead of text bytes', () => {
  const record = encodedRecord({ value: { type: 'BINARY', data: 'Zm9vYmFy' } });
  expectBytes(record.value, [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]);
  expect(Array.from(record.value)).not.toEqual(Array.from(textEncoder.encode('Zm9vYmFy')));
});

test('preserves an explicitly empty binary value', () => {
  const record = encodedRecord({ value: { type: 'BINARY', data: '' } });
  expect(record.value).toHaveLength(0);
});

test('preserves an explicitly empty key and distinguishes it from an absent key', () => {
  const emptyKey = encodedRecord({
    value: { type: 'STRING', data: 'v' },
    key: { type: 'STRING', data: '' },
  });
  const absentKey = encodedRecord({ value: { type: 'STRING', data: 'v' } });

  expect(emptyKey.key).toBeDefined();
  expect(emptyKey.key).toHaveLength(0);
  expect(absentKey.key).toBeUndefined();
});

test('uses JSON as the default value type', () => {
  // Проверяется рантайм-default, который шире текущего дискриминируемого типа DTO.
  const input = { value: { data: { a: 1 } } } as unknown as RecordDto;
  const record = encodedRecord(input);
  expectBytes(record.value, textEncoder.encode('{"a":1}'));
});

test('uses STRING as the default key type', () => {
  const record = encodedRecord({ value: { type: 'STRING', data: 'v' }, key: { data: 'k' } });
  expectBytes(record.key ?? new Uint8Array(), textEncoder.encode('k'));
});

test('uses STRING as the default header type', () => {
  const record = encodedRecord({
    value: { type: 'STRING', data: 'v' },
    headers: [{ name: 'x', value: 'header' }],
  });
  expectBytes(record.headers[0]?.value ?? new Uint8Array(), textEncoder.encode('header'));
});

test('returns an empty header array when headers are absent', () => {
  const record = encodedRecord({ value: { type: 'STRING', data: 'v' } });
  expect(record.headers).toEqual([]);
});

test('preserves header order, duplicates, values, and UTF-8 names', () => {
  const record = encodedRecord({
    value: { type: 'STRING', data: 'v' },
    headers: [
      { name: 'tag', value: 'first' },
      { name: 'tag', value: 'second' },
      { name: 'тег', value: 'third' },
    ],
  });

  expect(record.headers).toHaveLength(3);
  expectBytes(record.headers[0]?.name ?? new Uint8Array(), textEncoder.encode('tag'));
  expectBytes(record.headers[1]?.name ?? new Uint8Array(), textEncoder.encode('tag'));
  expectBytes(record.headers[2]?.name ?? new Uint8Array(), textEncoder.encode('тег'));
  expectBytes(record.headers[0]?.value ?? new Uint8Array(), textEncoder.encode('first'));
  expectBytes(record.headers[1]?.value ?? new Uint8Array(), textEncoder.encode('second'));
  expectBytes(record.headers[2]?.value ?? new Uint8Array(), textEncoder.encode('third'));
});

test.each([{ type: 'XML' }, { type: 1 }, { type: null }])(
  'rejects an unknown runtime record type: $type',
  ({ type }) => {
    // Проверяется рантайм-защита, поэтому тип намеренно не соответствует RecordDto.
    const record = { value: { type, data: 'value' } } as unknown as RecordDto;
    expect(encodeRecord(record)).toEqual({ kind: 'invalid-record-type' });
  },
);

test.each([
  { label: 'STRING with an object', record: { value: { type: 'STRING', data: { a: 1 } } } },
  { label: 'BINARY with a number', record: { value: { type: 'BINARY', data: 1 } } },
])('rejects a payload whose shape does not match its type: $label', ({ record }) => {
  expect(encodeRecord(record as unknown as RecordDto)).toEqual({ kind: 'invalid-record-type' });
});

test.each([
  'Zm9vYmF',
  'Zm9v YmFy',
  'Zm9v\nYmFy',
  'Zm9vYmFy-',
  'Zh==',
  'Zm9vYmFy=',
  'Zg=',
  'Zm9vYmFy=== ',
])('rejects non-canonical base64: %j', (data) => {
  const record = { value: { type: 'BINARY', data } } as const;
  expect(encodeRecord(record)).toEqual({ kind: 'invalid-base64' });
});

test('does not publish any part when a header fails encoding', () => {
  const record: RecordDto = {
    value: { type: 'STRING', data: 'valid value' },
    headers: [{ name: 'bad', type: 'BINARY', value: 'Zm9vYmF' }],
  };

  expect(encodeRecord(record)).toEqual({ kind: 'invalid-base64' });
});
