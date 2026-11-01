import { expect, test } from 'vitest';
import { parseJsonPath, selectNodes } from '../../src/domain/checking/index.js';
import type { JsonPathSegment } from '../../src/domain/checking/json-path.js';

function path(jsonPath: string): readonly JsonPathSegment[] {
  const result = parseJsonPath(jsonPath);
  if (result === undefined) throw new Error(`Unexpected invalid JSONPath: ${jsonPath}`);
  return result;
}

test.each([
  ['$', [{ kind: 'root' }]],
  ['$.a', [{ kind: 'root' }, { kind: 'property', name: 'a' }]],
  [
    '$.constructor.constructor',
    [
      { kind: 'root' },
      { kind: 'property', name: 'constructor' },
      { kind: 'property', name: 'constructor' },
    ],
  ],
  ['$.a.b', [{ kind: 'root' }, { kind: 'property', name: 'a' }, { kind: 'property', name: 'b' }]],
  ['$["a.b"]', [{ kind: 'root' }, { kind: 'property', name: 'a.b' }]],
  ['$[""]', [{ kind: 'root' }, { kind: 'property', name: '' }]],
  ['$["статус"]', [{ kind: 'root' }, { kind: 'property', name: 'статус' }]],
  [
    '$.items[0]',
    [{ kind: 'root' }, { kind: 'property', name: 'items' }, { kind: 'index', index: 0 }],
  ],
  [
    '$.items[10].id',
    [
      { kind: 'root' },
      { kind: 'property', name: 'items' },
      { kind: 'index', index: 10 },
      { kind: 'property', name: 'id' },
    ],
  ],
  ['$[*]', [{ kind: 'root' }, { kind: 'wildcard' }]],
  [
    '$.items[*].id',
    [
      { kind: 'root' },
      { kind: 'property', name: 'items' },
      { kind: 'wildcard' },
      { kind: 'property', name: 'id' },
    ],
  ],
] as const)('parses allowed JSONPath %s', (jsonPath, expected) => {
  expect(parseJsonPath(jsonPath)).toEqual(expected);
});

test.each([
  '',
  '$..id',
  '$.*',
  "$['id']",
  '$.items[0,1]',
  '$.items[0:2]',
  '$.items[-1]',
  '$.items[?(@.id == 1)]',
  '$.items[(@.length-1)]',
  '$ ',
  ' $.a',
  '$.a ',
  '$["a"] ',
  '$.items[01]',
  '$.items[1.0]',
  '$.items[1e2]',
  '$.items[9007199254740992]',
  '$.items[]',
  '$[]',
  '"$"',
  '$(1+1)',
  '$[1+1]',
])('rejects forbidden JSONPath %s', (jsonPath) => {
  expect(parseJsonPath(jsonPath)).toBeUndefined();
});

test('freezes parsed paths and produces independent stable results', () => {
  const first = parseJsonPath('$.items[0].id');
  const second = parseJsonPath('$.items[0].id');

  expect(first).toBeDefined();
  expect(Object.isFrozen(first)).toBe(true);
  expect(first?.every((segment) => Object.isFrozen(segment))).toBe(true);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
});

test.each([
  [{ x: { a: 1 } }, '$.x.a', [1]],
  [{ x: { a: { b: 2 } } }, '$.x.a.b', [2]],
  [{ items: [{ id: 'first' }, { id: 'second' }] }, '$.items[1].id', ['second']],
  [{ x: [] }, '$.x[*]', []],
  [{ x: [1, 2] }, '$.x[*]', [1, 2]],
  [{ x: [[1, 2], [3]] }, '$.x[*]', [[1, 2], [3]]],
  [{ x: { a: 1, b: 2 } }, '$.x[*]', [1, 2]],
  [{ x: { 0: 'a' } }, '$.x[0]', []],
  [{ x: 'abc' }, '$.x.length', []],
  [{}, '$.constructor', []],
  [{ constructor: 'a' }, '$.constructor', ['a']],
  [null, '$', [null]],
  [{ x: [1] }, '$.x[1]', []],
  [42, '$[*]', []],
] as const)('selects nodes for %s at %s', (value, jsonPath, expected) => {
  expect(selectNodes(value, path(jsonPath))).toEqual(expected);
});

test('keeps constructor access own-property-only and does not pollute Object.prototype', () => {
  expect(selectNodes({}, path('$.constructor.constructor'))).toEqual([]);
  expect(
    selectNodes({ constructor: { constructor: 'x' } }, path('$.constructor.constructor')),
  ).toEqual(['x']);
  expect(selectNodes({}, path('$.constructor'))).toEqual([]);
  expect(selectNodes({ constructor: 'a' }, path('$.constructor'))).toEqual(['a']);

  const value = { x: { constructor: { prototype: { polluted: true } } } };
  expect(selectNodes(value, path('$.x.constructor.prototype.polluted'))).toEqual([true]);
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
});
