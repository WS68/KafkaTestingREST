import type { CompiledHeaderCondition } from '../check.js';
import type { SourceRecord } from '../record.js';
import { decodeStrictUtf8 } from '../encoding/strict-utf8.js';

/** Проверяет все ожидаемые пары «имя — строковое значение» независимо. */
export function matchesHeaders(
  record: SourceRecord,
  conditions: readonly CompiledHeaderCondition[],
): boolean {
  for (const condition of conditions) {
    let matched = false;

    for (const header of record.headers) {
      const name = decodeStrictUtf8(header.name);
      if (name !== condition.name || header.value === undefined) continue;

      const value = decodeStrictUtf8(header.value);
      if (value === condition.value) {
        matched = true;
        break;
      }
    }

    if (!matched) return false;
  }

  return true;
}
