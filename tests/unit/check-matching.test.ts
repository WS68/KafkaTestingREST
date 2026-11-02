import { expect, test } from 'vitest';
import type { CompiledCheck } from '../../src/domain/check.js';
import { matchesCheck, prepareCheck } from '../../src/domain/checking/check.js';
import type { SourceHeader, SourceRecord } from '../../src/domain/record.js';

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function header(name: string, value?: string | Uint8Array): SourceHeader {
  return {
    name: bytes(name),
    value: typeof value === 'string' ? bytes(value) : value,
  };
}

function record(
  headers: readonly SourceHeader[] = [],
  valueBytes?: string | Uint8Array,
): SourceRecord {
  return {
    headers,
    key: undefined,
    value: typeof valueBytes === 'string' ? bytes(valueBytes) : valueBytes,
  };
}

function check(
  headers: readonly { readonly name: string; readonly value: string }[] = [],
  values: CompiledCheck['values'] = [],
): CompiledCheck {
  return {
    headers: headers.map(({ name, value }) => ({
      name,
      value,
      operation: 'EQUALS',
      ignoreCase: false,
    })),
    values,
  };
}

function prepared(jsonPath: string, value: string): CompiledCheck {
  const result = prepareCheck({ values: [{ jsonPath, value }] });
  if (result.kind !== 'ok') throw new Error(`Unexpected invalid path: ${jsonPath}`);
  return result.check;
}

test('empty check matches records without values and with undecodable unrelated headers', () => {
  const source = record([header('other', new Uint8Array([0xff]))]);
  expect(matchesCheck(source, check())).toBe(true);
  expect(matchesCheck(record(), check())).toBe(true);
});

test('header-only checks ignore whether the record has a value', () => {
  const condition = [{ name: 'tag', value: 'a' }];
  const expected = check(condition);
  expect(matchesCheck(record([header('tag', 'a')]), expected)).toBe(true);
  expect(matchesCheck(record([header('tag', 'a')], '{"x":1}'), expected)).toBe(true);
});

test('value-only checks ignore headers, including undecodable unrelated headers', () => {
  const expected = prepared('$.status', 'ok');
  expect(
    matchesCheck(record([header('other', new Uint8Array([0xff]))], '{"status":"ok"}'), expected),
  ).toBe(true);
  expect(matchesCheck(record([header('status', 'wrong')], '{"status":"ok"}'), expected)).toBe(true);
});

test('both condition sets are joined with logical AND', () => {
  const expected = {
    ...prepared('$.status', 'ok'),
    headers: check([{ name: 'tag', value: 'a' }]).headers,
  };
  const source = record([header('tag', 'a')], '{"status":"ok"}');
  expect(matchesCheck(source, expected)).toBe(true);
  expect(matchesCheck(record([header('tag', 'b')], '{"status":"ok"}'), expected)).toBe(false);
  expect(matchesCheck(record([header('tag', 'a')], '{"status":"no"}'), expected)).toBe(false);
});

test('one unmatched condition does not produce a partial match', () => {
  const expected = check(
    [
      { name: 'tag', value: 'a' },
      { name: 'kind', value: 'event' },
    ],
    prepared('$.status', 'ok').values,
  );
  expect(matchesCheck(record([header('tag', 'a')], '{"status":"ok"}'), expected)).toBe(false);
});

test('repeated calls are deterministic and do not mutate input bytes', () => {
  const value = bytes('{"status":"ok"}');
  const invalidHeader = new Uint8Array([0xff]);
  const source = record([header('tag', 'a'), header('other', invalidHeader)], value);
  const beforeValue = Array.from(value);
  const beforeHeader = Array.from(invalidHeader);
  const expected = {
    ...prepared('$.status', 'ok'),
    headers: check([{ name: 'tag', value: 'a' }]).headers,
  };

  expect(matchesCheck(source, expected)).toBe(true);
  expect(matchesCheck(source, expected)).toBe(true);
  expect(Array.from(value)).toEqual(beforeValue);
  expect(Array.from(invalidHeader)).toEqual(beforeHeader);
});

test('two checks on one record remain independent', () => {
  const source = record([header('tag', 'a')], '{"status":"ok"}');
  const first = check([{ name: 'tag', value: 'a' }]);
  const second = prepared('$.status', 'ok');
  const before = Array.from(source.value ?? []);

  expect(matchesCheck(source, first)).toBe(true);
  expect(matchesCheck(source, second)).toBe(true);
  expect(matchesCheck(source, check([{ name: 'tag', value: 'b' }]))).toBe(false);
  expect(Array.from(source.value ?? [])).toEqual(before);
});

test.each(['$..x', "$['x']", '', '$.*', '$.items[-1]'])(
  'rejects invalid JSONPath %s',
  (jsonPath) => {
    expect(prepareCheck({ values: [{ jsonPath, value: 'x' }] })).toEqual({
      kind: 'invalid-json-path',
      jsonPath,
    });
  },
);

test('prepareCheck returns compiled segments for valid paths', () => {
  expect(prepareCheck({ values: [{ jsonPath: '$.items[0].name', value: 'x' }] })).toEqual({
    kind: 'ok',
    check: {
      headers: [],
      values: [
        {
          jsonPath: [
            { kind: 'root' },
            { kind: 'property', name: 'items' },
            { kind: 'index', index: 0 },
            { kind: 'property', name: 'name' },
          ],
          value: 'x',
          operation: 'EQUALS',
          ignoreCase: false,
        },
      ],
    },
  });
});

test('prepareCheck preserves explicitly provided operation and ignoreCase', () => {
  expect(
    prepareCheck({
      headers: [{ name: 'x-test', value: 'value', operation: 'CONTAINS', ignoreCase: true }],
      values: [{ jsonPath: '$.status', value: 'ready', operation: 'CONTAINS', ignoreCase: true }],
    }),
  ).toEqual({
    kind: 'ok',
    check: {
      headers: [{ name: 'x-test', value: 'value', operation: 'CONTAINS', ignoreCase: true }],
      values: [
        {
          jsonPath: [{ kind: 'root' }, { kind: 'property', name: 'status' }],
          value: 'ready',
          operation: 'CONTAINS',
          ignoreCase: true,
        },
      ],
    },
  });
});

test('prepareCheck defaults omitted operation and ignoreCase', () => {
  expect(
    prepareCheck({
      headers: [{ name: 'x-test', value: 'value' }],
      values: [{ jsonPath: '$.status', value: 'ready' }],
    }),
  ).toEqual({
    kind: 'ok',
    check: {
      headers: [{ name: 'x-test', value: 'value', operation: 'EQUALS', ignoreCase: false }],
      values: [
        {
          jsonPath: [{ kind: 'root' }, { kind: 'property', name: 'status' }],
          value: 'ready',
          operation: 'EQUALS',
          ignoreCase: false,
        },
      ],
    },
  });
});

test('prepareCheck does not return a partial result after a later invalid path', () => {
  expect(
    prepareCheck({
      values: [
        { jsonPath: '$.ok', value: 'yes' },
        { jsonPath: '$..bad', value: 'no' },
      ],
    }),
  ).toEqual({ kind: 'invalid-json-path', jsonPath: '$..bad' });
});
