import type { CompiledCheck } from '../check.js';
import type { ReadonlyBytes, SourceHeader, SourceRecord } from '../record.js';

/** Накопитель записей, соответствующих одной проверке. */
export interface CheckAccumulatorStore {
  readonly check: CompiledCheck;
  append(record: SourceRecord): number;
  count(): number;
  snapshot(offset: number, limit: number): readonly SourceRecord[];
  clear(): void;
}

/** Создаёт независимую копию записи вместе со всеми её байтами. */
export function cloneSourceRecord(record: SourceRecord): SourceRecord {
  const headers: SourceHeader[] = record.headers.map((header) => ({
    name: cloneBytes(header.name),
    value: header.value === undefined ? undefined : cloneBytes(header.value),
  }));

  return {
    headers,
    key: record.key === undefined ? undefined : cloneBytes(record.key),
    value: record.value === undefined ? undefined : cloneBytes(record.value),
  };
}

/** Создаёт накопитель с сохранением порядка поступления записей. */
export function createCheckAccumulator(check: CompiledCheck): CheckAccumulatorStore {
  let records: SourceRecord[] = [];
  let currentCount = 0;

  return {
    check,

    append(record): number {
      records.push(cloneSourceRecord(record));
      currentCount += 1;
      return currentCount;
    },

    count(): number {
      return currentCount;
    },

    snapshot(offset, limit): readonly SourceRecord[] {
      if (offset < 0 || limit <= 0) return [];

      return records.slice(offset, offset + limit).map(cloneSourceRecord);
    },

    clear(): void {
      records = [];
      currentCount = 0;
    },
  };
}

function cloneBytes(bytes: ReadonlyBytes): ReadonlyBytes {
  return bytes.slice();
}
