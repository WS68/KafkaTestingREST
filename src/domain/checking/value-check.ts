import type { CompiledValueCondition } from '../check.js';
import { decodeStrictUtf8 } from '../encoding/strict-utf8.js';
import type { SourceRecord } from '../record.js';
import { selectNodes } from './json-path-eval.js';
import { nodeToString } from './value-condition.js';

/** Проверяет значение записи по подготовленному JSONPath без выхода исключений наружу. */
export function matchesValueCondition(
  record: SourceRecord,
  condition: CompiledValueCondition,
): boolean {
  try {
    if (record.value === undefined) return false;

    const text = decodeStrictUtf8(record.value);
    if (text === undefined) return false;

    const decoded = JSON.parse(text) as unknown;
    for (const node of selectNodes(decoded, condition.jsonPath)) {
      if (nodeToString(node) === condition.value) return true;
    }
  } catch {
    return false;
  }

  return false;
}
