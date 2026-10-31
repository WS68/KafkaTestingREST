import { describe, expect, it } from 'vitest';
import {
  parseCheckIndexForRead,
  parseCheckIndexForWait,
  parseReadParams,
  parseStrictInteger,
  parseWaitParams,
} from '../../src/http/parsing/index.js';

describe('разбор HTTP-параметров', () => {
  it('строго разбирает безопасные целые и различает отсутствие', () => {
    expect(parseStrictInteger('0')).toEqual({ kind: 'ok', value: 0 });
    expect(parseStrictInteger('9007199254740991')).toEqual({
      kind: 'ok',
      value: Number.MAX_SAFE_INTEGER,
    });
    for (const raw of ['9007199254740992', '-1', '1.0', '1e3', ' 1', '1 ', '', '01', 'abc']) {
      expect(parseStrictInteger(raw)).toEqual({ kind: 'invalid' });
    }
    expect(parseStrictInteger(undefined)).toEqual({ kind: 'absent' });
  });

  it('разбор индексов чтения и ожидания имеет одинаковую форму', () => {
    expect(parseCheckIndexForRead('3')).toEqual(parseCheckIndexForWait('3'));
    expect(parseCheckIndexForRead('bad')).toEqual({ kind: 'invalid' });
    expect(parseCheckIndexForWait('bad')).toEqual({ kind: 'invalid' });
  });

  it('разбирает ожидание с defaults и приоритетом ошибки индекса', () => {
    const defaults = { waitTimeoutMs: 250 };
    expect(parseWaitParams('0', undefined, undefined, defaults)).toEqual({
      kind: 'ok',
      value: { n: 1, timeoutMs: 250 },
    });
    expect(parseWaitParams('0', '0', undefined, defaults)).toEqual({ kind: 'invalid-params' });
    expect(parseWaitParams('0', undefined, '0', defaults)).toEqual({ kind: 'invalid-params' });
    expect(parseWaitParams('bad', 'bad', undefined, defaults)).toEqual({ kind: 'invalid-index' });
  });

  it('разбирает пагинацию, не подменяя ошибку значением по умолчанию', () => {
    expect(parseReadParams('0', undefined, undefined)).toEqual({
      kind: 'ok',
      value: { offset: 0, count: 20 },
    });
    expect(parseReadParams('0', '-1', undefined)).toEqual({ kind: 'invalid-pagination' });
    expect(parseReadParams('0', undefined, '0')).toEqual({ kind: 'invalid-pagination' });
    expect(parseReadParams('0', undefined, 'abc')).toEqual({ kind: 'invalid-pagination' });
    expect(parseReadParams('bad', '-1', undefined)).toEqual({ kind: 'invalid-index' });
  });
});
