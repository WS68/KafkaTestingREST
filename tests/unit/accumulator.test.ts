import { expect, test } from 'vitest';
import type { CompiledCheck } from '../../src/domain/check.js';
import { createCheckAccumulator } from '../../src/domain/accumulation/accumulator.js';
import type { SourceRecord } from '../../src/domain/record.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function record(
  valueJson: string,
  options?: { key?: string; headers?: Array<{ name: string; value?: string }> },
): SourceRecord {
  return {
    value: bytes(valueJson),
    key: options?.key === undefined ? undefined : bytes(options.key),
    headers: (options?.headers ?? []).map((header) => ({
      name: bytes(header.name),
      value: header.value === undefined ? undefined : bytes(header.value),
    })),
  };
}

function check(): CompiledCheck {
  return { headers: [], values: [] };
}

function valueText(source: SourceRecord): string | undefined {
  return source.value === undefined ? undefined : decoder.decode(source.value);
}

test('appends in order and returns a monotonically increasing count', () => {
  const accumulator = createCheckAccumulator(check());

  expect(accumulator.append(record('{"n":1}'))).toBe(1);
  expect(accumulator.append(record('{"n":2}'))).toBe(2);
  expect(accumulator.append(record('{"n":3}'))).toBe(3);
  expect(accumulator.count()).toBe(3);
  expect(accumulator.snapshot(0, 10).map(valueText)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
});

test('applies page boundaries and returns remaining records past the end', () => {
  const accumulator = createCheckAccumulator(check());
  [1, 2, 3].forEach((value) => accumulator.append(record(String(value))));

  expect(accumulator.snapshot(1, 1).map(valueText)).toEqual(['2']);
  expect(accumulator.snapshot(0, 0)).toEqual([]);
  expect(accumulator.snapshot(-1, 5)).toEqual([]);
  expect(accumulator.snapshot(0, -1)).toEqual([]);
  expect(accumulator.snapshot(10, 5)).toEqual([]);
  expect(accumulator.snapshot(1, 10).map(valueText)).toEqual(['2', '3']);
});

test('reading does not remove records and the limit does not limit accumulation', () => {
  const accumulator = createCheckAccumulator(check());
  accumulator.append(record('first'));
  accumulator.append(record('second'));

  expect(accumulator.snapshot(0, 1).map(valueText)).toEqual(['first']);
  expect(accumulator.count()).toBe(2);
  expect(accumulator.snapshot(0, 10).map(valueText)).toEqual(['first', 'second']);

  expect(accumulator.append(record('third'))).toBe(3);
  expect(accumulator.count()).toBe(3);
  expect(accumulator.snapshot(0, 10).map(valueText)).toEqual(['first', 'second', 'third']);
});

test('accumulators are independent and clear releases records safely', () => {
  const first = createCheckAccumulator(check());
  const second = createCheckAccumulator(first.check);

  first.append(record('only-first'));
  expect(first.count()).toBe(1);
  expect(second.count()).toBe(0);

  first.clear();
  expect(first.count()).toBe(0);
  expect(first.snapshot(0, 10)).toEqual([]);
  first.clear();
  expect(first.append(record('after-clear'))).toBe(1);
});

test('isolates bytes, preserves duplicate headers, and distinguishes undefined from empty bytes', () => {
  const accumulator = createCheckAccumulator(check());
  const source = record('value', {
    key: 'key',
    headers: [{ name: 'tag', value: 'first' }, { name: 'tag' }, { name: 'other', value: 'last' }],
  });
  accumulator.append(source);

  source.value![0] = bytes('X')[0]!;
  source.key![0] = bytes('X')[0]!;
  source.headers[0]!.name[0] = bytes('X')[0]!;
  source.headers[0]!.value![0] = bytes('X')[0]!;

  const snapshot = accumulator.snapshot(0, 1)[0]!;
  snapshot.value![0] = bytes('Y')[0]!;
  snapshot.key![0] = bytes('Y')[0]!;
  snapshot.headers[0]!.name[0] = bytes('Y')[0]!;
  snapshot.headers[0]!.value![0] = bytes('Y')[0]!;

  const unchanged = accumulator.snapshot(0, 1)[0]!;
  expect(valueText(unchanged)).toBe('value');
  expect(decoder.decode(unchanged.key)).toBe('key');
  expect(unchanged.headers.map((header) => decoder.decode(header.name))).toEqual([
    'tag',
    'tag',
    'other',
  ]);
  expect(
    unchanged.headers.map((header) =>
      header.value === undefined ? undefined : decoder.decode(header.value),
    ),
  ).toEqual(['first', undefined, 'last']);

  const missing = record('ignored');
  const empty = record('', { key: '', headers: [{ name: 'empty', value: '' }] });
  accumulator.append({ ...missing, value: undefined });
  accumulator.append(empty);
  const tail = accumulator.snapshot(1, 2);
  expect(tail[0]!.value).toBeUndefined();
  expect(tail[0]!.key).toBeUndefined();
  expect(tail[1]!.value).toHaveLength(0);
  expect(tail[1]!.key).toHaveLength(0);
  expect(tail[1]!.headers[0]!.value).toHaveLength(0);
});
