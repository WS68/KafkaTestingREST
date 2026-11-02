import { expect, test } from 'vitest';
import type { CompiledHeaderCondition } from '../../src/domain/check.js';
import { matchesHeaders } from '../../src/domain/checking/headers.js';
import { prepareCheck } from '../../src/domain/checking/check.js';
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

function record(headers: readonly SourceHeader[]): SourceRecord {
  return { headers, key: undefined, value: undefined };
}

function condition(
  name: string,
  value: string,
  operation: CompiledHeaderCondition['operation'] = 'EQUALS',
  ignoreCase = false,
): CompiledHeaderCondition {
  return { name, value, operation, ignoreCase };
}

test.each([
  [
    'one of repeated values matches',
    [header('tag', 'a'), header('tag', 'b')],
    [condition('tag', 'b')],
    true,
  ],
  [
    'different conditions may use repeated values',
    [header('tag', 'a'), header('tag', 'b')],
    [condition('tag', 'a'), condition('tag', 'b')],
    true,
  ],
  [
    'one record header satisfies a repeated condition',
    [header('tag', 'a')],
    [condition('tag', 'a'), condition('tag', 'a')],
    true,
  ],
  [
    'one candidate cannot satisfy different values',
    [header('tag', 'a')],
    [condition('tag', 'a'), condition('tag', 'b')],
    false,
  ],
  [
    'invalid candidate does not hide a valid candidate',
    [header('tag', new Uint8Array([0xc3, 0x28])), header('tag', 'b')],
    [condition('tag', 'b')],
    true,
  ],
  [
    'invalid or absent values do not equal an empty string',
    [header('tag', new Uint8Array([0xc3, 0x28])), header('tag')],
    [condition('tag', '')],
    false,
  ],
  [
    'empty bytes equal an empty string',
    [header('tag', new Uint8Array())],
    [condition('tag', '')],
    true,
  ],
  ['header names are case-sensitive', [header('Tag', 'a')], [condition('tag', 'a')], false],
  ['missing headers do not match', [], [condition('tag', '')], false],
] as const)('%s', (_title, headers, conditions, expected) => {
  expect(matchesHeaders(record(headers), conditions)).toBe(expected);
});

test('empty conditions ignore undecodable unrelated headers', () => {
  expect(matchesHeaders(record([header('other', new Uint8Array([0xff]))]), [])).toBe(true);
});

test('unrelated headers are not decoded for a matching condition', () => {
  expect(
    matchesHeaders(record([header('tag', 'a'), header('other', new Uint8Array([0xff]))]), [
      condition('tag', 'a'),
    ]),
  ).toBe(true);
});

test('default and explicit EQUALS compare values exactly and case-sensitively', () => {
  const prepared = prepareCheck({ headers: [{ name: 'tag', value: 'Exact' }] });
  expect(prepared.kind).toBe('ok');
  if (prepared.kind !== 'ok') return;
  expect(prepared.check.headers).toEqual([
    { name: 'tag', value: 'Exact', operation: 'EQUALS', ignoreCase: false },
  ]);
  expect(matchesHeaders(record([header('tag', 'Exact')]), prepared.check.headers)).toBe(true);
  expect(matchesHeaders(record([header('tag', 'exact')]), prepared.check.headers)).toBe(false);
  expect(
    matchesHeaders(record([header('tag', 'Exact')]), [condition('tag', 'Exact', 'EQUALS')]),
  ).toBe(true);
  expect(
    matchesHeaders(record([header('tag', 'exact')]), [condition('tag', 'Exact', 'EQUALS')]),
  ).toBe(false);
});

test('CONTAINS matches a present substring and rejects an absent substring', () => {
  const source = record([header('tag', 'prefix-middle-suffix')]);
  expect(matchesHeaders(source, [condition('tag', 'middle', 'CONTAINS')])).toBe(true);
  expect(matchesHeaders(source, [condition('tag', 'missing', 'CONTAINS')])).toBe(false);
});

test.each([
  ['EQUALS', 'MiXeD', 'mixed'],
  ['CONTAINS', 'prefix-MiXeD-suffix', 'mixed'],
] as const)('%s ignores value case when ignoreCase is true', (operation, actual, expected) => {
  expect(
    matchesHeaders(record([header('tag', actual)]), [condition('tag', expected, operation, true)]),
  ).toBe(true);
});

test.each([
  ['EQUALS', 'MiXeD', 'mixed'],
  ['CONTAINS', 'prefix-MiXeD-suffix', 'mixed'],
] as const)('%s preserves value case when ignoreCase is false', (operation, actual, expected) => {
  expect(
    matchesHeaders(record([header('tag', actual)]), [condition('tag', expected, operation, false)]),
  ).toBe(false);
});

test.each([
  ['ß', 'SS'],
  ['ς', 'Σ'],
  ['σ', 'ς'],
  ['ﬀ', 'FF'],
] as const)('case-folds Unicode %s and %s', (actual, expected) => {
  expect(
    matchesHeaders(record([header('tag', actual)]), [condition('tag', expected, 'EQUALS', true)]),
  ).toBe(true);
});

test('uses locale-independent Unicode folding for Turkish I variants', () => {
  expect(
    matchesHeaders(record([header('tag', 'İ')]), [condition('tag', 'i\u0307', 'EQUALS', true)]),
  ).toBe(true);
  expect(
    matchesHeaders(record([header('tag', 'İ')]), [condition('tag', 'i', 'EQUALS', true)]),
  ).toBe(false);
  expect(
    matchesHeaders(record([header('tag', 'ı')]), [condition('tag', 'I', 'EQUALS', true)]),
  ).toBe(false);
});

test('case folding does not normalize canonically equivalent Unicode', () => {
  expect(
    matchesHeaders(record([header('tag', '\u00e9')]), [
      condition('tag', 'e\u0301', 'EQUALS', true),
    ]),
  ).toBe(false);
});

test('repeated values need only one match and distinct conditions are all required', () => {
  expect(
    matchesHeaders(record([header('tag', 'no'), header('tag', 'yes')]), [condition('tag', 'yes')]),
  ).toBe(true);
  expect(
    matchesHeaders(record([header('first', 'yes'), header('second', 'yes')]), [
      condition('first', 'yes'),
      condition('second', 'yes'),
    ]),
  ).toBe(true);
  expect(
    matchesHeaders(record([header('first', 'yes'), header('second', 'no')]), [
      condition('first', 'yes'),
      condition('second', 'yes'),
    ]),
  ).toBe(false);
});

test('invalid UTF-8 and absent values are skipped without throwing or matching', () => {
  expect(() =>
    matchesHeaders(record([header('tag', new Uint8Array([0xc3, 0x28]))]), [condition('tag', '')]),
  ).not.toThrow();
  expect(
    matchesHeaders(record([header('tag', new Uint8Array([0xc3, 0x28]))]), [condition('tag', '')]),
  ).toBe(false);
  expect(matchesHeaders(record([header('tag')]), [condition('tag', '')])).toBe(false);
  expect(
    matchesHeaders(record([header('tag'), header('tag', ' A ')]), [condition('tag', ' A ')]),
  ).toBe(true);
});

test('header names remain case-sensitive even when value comparison ignores case', () => {
  expect(
    matchesHeaders(record([header('Tag', 'MIXED')]), [condition('tag', 'mixed', 'EQUALS', true)]),
  ).toBe(false);
});
