import { expect, test } from 'vitest';
import type { CompiledHeaderCondition } from '../../src/domain/check.js';
import { matchesHeaders } from '../../src/domain/checking/headers.js';
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

function condition(name: string, value: string): CompiledHeaderCondition {
  return { name, value };
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

test('value comparison preserves spaces, case, and missing-value candidates', () => {
  expect(
    matchesHeaders(record([header('tag'), header('tag', ' A ')]), [condition('tag', ' A ')]),
  ).toBe(true);
  expect(matchesHeaders(record([header('tag', 'a')]), [condition('tag', 'A')])).toBe(false);
});
