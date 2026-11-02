import { expect, test } from 'vitest';
import type { CompiledValueCondition } from '../../src/domain/check.js';
import { matchesCheck, parseJsonPath, prepareCheck } from '../../src/domain/checking/index.js';
import { matchesValueCondition, nodeToString } from '../../src/domain/checking/index.js';
import type { SourceRecord } from '../../src/domain/record.js';

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function record(value?: string | Uint8Array): SourceRecord {
  return {
    headers: [],
    key: undefined,
    value: typeof value === 'string' ? bytes(value) : value,
  };
}

function condition(
  jsonPath: string,
  value: string,
  operation: CompiledValueCondition['operation'] = 'EQUALS',
  ignoreCase = false,
): CompiledValueCondition {
  const segments = parseJsonPath(jsonPath);
  if (segments === undefined) throw new Error(`Unexpected invalid JSONPath: ${jsonPath}`);
  return { jsonPath: segments, value, operation, ignoreCase };
}

test.each([
  ['string is compared without JSON quotes', '{"x":"foo"}', '$.x', '"foo"', false],
  ['numeric string and number have the same text', '{"x":"42"}', '$.x', '42', true],
  ['number has the same text as numeric string', '{"x":42}', '$.x', '42', true],
  ['decimal zero is rendered canonically', '{"x":1.0}', '$.x', '1', true],
  ['exponential zero is rendered canonically', '{"x":1e0}', '$.x', '1', true],
  ['negative zero is rendered as zero', '{"x":-0}', '$.x', '0', true],
  ['negative zero does not retain a minus sign', '{"x":-0}', '$.x', '-0', false],
  ['boolean true is rendered as text', '{"x":true}', '$.x', 'true', true],
  ['boolean false is rendered as text', '{"x":false}', '$.x', 'false', true],
  ['null is rendered as text', '{"x":null}', '$.x', 'null', true],
  ['null is not an empty string', '{"x":null}', '$.x', '', false],
  ['empty string remains empty', '{"x":""}', '$.x', '', true],
  ['missing value is not an empty string', '{}', '$.x', '', false],
  ['missing value is not null text', '{}', '$.x', 'null', false],
  ['object preserves insertion order', '{"x":{"b":2,"a":1}}', '$.x', '{"b":2,"a":1}', true],
  ['object order matters', '{"x":{"b":2,"a":1}}', '$.x', '{"a":1,"b":2}', false],
  ['empty object is serialized', '{"x":{}}', '$.x', '{}', true],
  [
    'integer-like object keys use JSON order',
    '{"x":{"2":"b","1":"a"}}',
    '$.x',
    '{"1":"a","2":"b"}',
    true,
  ],
  ['array is serialized as JSON', '{"x":[1,"a",null]}', '$.x', '[1,"a",null]', true],
  ['empty array is serialized', '{"x":[]}', '$.x', '[]', true],
  [
    'a missing wildcard property does not block null',
    '{"x":[{"v":1},{"y":2},{"v":null}]}',
    '$.x[*].v',
    'null',
    true,
  ],
  ['object wildcard can match its last value', '{"x":{"a":1,"b":2}}', '$.x[*]', '2', true],
  ['leading and trailing spaces are significant', '{"x":" a "}', '$.x', 'a', false],
  ['Unicode values are not normalized', '{"x":"e\\u0301"}', '$.x', 'é', false],
  [
    'unsafe integer follows JSON number parsing',
    '{"x":9007199254740993}',
    '$.x',
    '9007199254740992',
    true,
  ],
  ['top-level non-finite number is not a value', '{"x":1e400}', '$.x', 'null', false],
  ['top-level non-finite number is not Infinity text', '{"x":1e400}', '$.x', 'Infinity', false],
  [
    'nested non-finite number is not replaced with null',
    '{"x":{"n":1e400}}',
    '$.x',
    '{"n":null}',
    false,
  ],
] as const)('%s', (_title, json, jsonPath, expected, result) => {
  expect(matchesValueCondition(record(json), condition(jsonPath, expected))).toBe(result);
});

test('value matching supports contains and Unicode case folding', () => {
  expect(
    matchesValueCondition(
      record('{"x":"A Straße event"}'),
      condition('$.x', 'STRASSE', 'CONTAINS', true),
    ),
  ).toBe(true);
  expect(matchesValueCondition(record('{"x":"Straße"}'), condition('$.x', 'STRASSE'))).toBe(false);
});

test('omitted value options default to strict, case-sensitive EQUALS', () => {
  const defaults = prepareCheck({ values: [{ jsonPath: '$.x', value: 'Ready' }] });
  const explicit = prepareCheck({
    values: [{ jsonPath: '$.x', value: 'Ready', operation: 'EQUALS', ignoreCase: false }],
  });

  expect(defaults).toEqual(explicit);
  expect(defaults.kind).toBe('ok');
  if (defaults.kind !== 'ok') return;
  const compiled = defaults.check.values[0];
  if (compiled === undefined) throw new Error('Expected a compiled value condition');
  expect(matchesValueCondition(record('{"x":"Ready"}'), compiled)).toBe(true);
  expect(matchesValueCondition(record('{"x":"ready"}'), compiled)).toBe(false);
  expect(matchesValueCondition(record('{"x":"Ready now"}'), compiled)).toBe(false);
});

test('prepareCheck applies defaults to value conditions', () => {
  const prepared = prepareCheck({ values: [{ jsonPath: '$.x', value: 'Ready' }] });

  expect(prepared).toEqual({
    kind: 'ok',
    check: {
      headers: [],
      values: [
        {
          jsonPath: [{ kind: 'root' }, { kind: 'property', name: 'x' }],
          value: 'Ready',
          operation: 'EQUALS',
          ignoreCase: false,
        },
      ],
    },
  });
});

test.each([
  ['contains finds a substring', '{"x":"event-ready"}', 'ready', 'CONTAINS', false, true],
  [
    'contains rejects an absent substring',
    '{"x":"event-pending"}',
    'ready',
    'CONTAINS',
    false,
    false,
  ],
  ['ignoreCase equals matches', '{"x":"READY"}', 'ready', 'EQUALS', true, true],
  ['ignoreCase contains matches', '{"x":"event-READY"}', 'ready', 'CONTAINS', true, true],
  [
    'case-sensitive equals rejects case difference',
    '{"x":"READY"}',
    'ready',
    'EQUALS',
    false,
    false,
  ],
  [
    'case-sensitive contains rejects case difference',
    '{"x":"event-READY"}',
    'ready',
    'CONTAINS',
    false,
    false,
  ],
] as const)('%s', (_title, json, expected, operation, ignoreCase, result) => {
  expect(
    matchesValueCondition(record(json), condition('$.x', expected, operation, ignoreCase)),
  ).toBe(result);
});

test.each([
  ['sharp s expands to SS', '{"x":"Straße"}', 'STRASSE', true],
  ['medial and final Greek sigma fold together', '{"x":"οσς"}', 'ΟΣΣ', true],
  ['Turkish dotted I folds to i plus dot', '{"x":"İ"}', 'i\u0307', true],
  ['Turkish dotless i remains distinct from i', '{"x":"ı"}', 'i', false],
  ['ligature expands to FF', '{"x":"ﬀ"}', 'FF', true],
] as const)('%s', (_title, json, expected, result) => {
  expect(matchesValueCondition(record(json), condition('$.x', expected, 'EQUALS', true))).toBe(
    result,
  );
});

test('case folding does not normalize NFC and NFD forms', () => {
  expect(
    matchesValueCondition(record('{"x":"é"}'), condition('$.x', 'e\u0301', 'EQUALS', true)),
  ).toBe(false);
});

test('a matching node among several JSONPath results is sufficient', () => {
  expect(
    matchesValueCondition(
      record('{"items":[{"name":"other"},{"name":"TARGET"}]}'),
      condition('$.items[*].name', 'target'),
    ),
  ).toBe(false);
  expect(
    matchesValueCondition(
      record('{"items":[{"name":"other"},{"name":"TARGET"}]}'),
      condition('$.items[*].name', 'target', 'EQUALS', true),
    ),
  ).toBe(true);
});

test('nodeToString uses the same JSON serialization rules', () => {
  expect(nodeToString('foo')).toBe('foo');
  expect(nodeToString({ b: 2, a: 1 })).toBe('{"b":2,"a":1}');
  expect(nodeToString(Number.POSITIVE_INFINITY)).toBeUndefined();
});

test.each([
  [undefined, '42'],
  [new Uint8Array(), '42'],
  [new Uint8Array([0xc3, 0x28]), '42'],
  ['{"x":', '42'],
] as const)('invalid or absent record value does not match (%s)', (value, expected) => {
  expect(matchesValueCondition(record(value), condition('$.x', expected))).toBe(false);
});

test('an invalid prepared check does not prevent a valid check on the same record', () => {
  const invalid = prepareCheck({
    values: [{ jsonPath: '$.items[?(@.id == 1)]', value: '1' }],
  });
  const valid = prepareCheck({ values: [{ jsonPath: '$.status', value: 'ok' }] });

  expect(invalid.kind).toBe('invalid-json-path');
  expect(valid.kind).toBe('ok');
  if (valid.kind === 'ok') expect(matchesCheck(record('{"status":"ok"}'), valid.check)).toBe(true);
});

test('a false check does not prevent a later true check on the same record', () => {
  const first = prepareCheck({ values: [{ jsonPath: '$.status', value: 'wrong' }] });
  const second = prepareCheck({ values: [{ jsonPath: '$.status', value: 'ok' }] });

  expect(first.kind).toBe('ok');
  expect(second.kind).toBe('ok');
  if (first.kind === 'ok' && second.kind === 'ok') {
    const source = record('{"status":"ok"}');
    expect(matchesCheck(source, first.check)).toBe(false);
    expect(matchesCheck(source, second.check)).toBe(true);
  }
});
