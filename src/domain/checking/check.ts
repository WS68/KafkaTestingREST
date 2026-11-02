import type {
  CheckOperation,
  CompiledCheck,
  CompiledHeaderCondition,
  CompiledValueCondition,
} from '../check.js';
import { matchesHeaders } from './headers.js';
import { parseJsonPath } from './json-path.js';
import { matchesValueCondition } from './value-check.js';
import type { SourceRecord } from '../record.js';

export type CheckInput = {
  readonly headers?: readonly {
    readonly name: string;
    readonly value: string;
    readonly operation?: CheckOperation;
    readonly ignoreCase?: boolean;
  }[];
  readonly values?: readonly {
    readonly jsonPath: string;
    readonly value: string;
    readonly operation?: CheckOperation;
    readonly ignoreCase?: boolean;
  }[];
};

export type PrepareCheckResult =
  | { readonly kind: 'ok'; readonly check: CompiledCheck }
  | { readonly kind: 'invalid-json-path'; readonly jsonPath: string };

/** Проверяет запись по всем условиям заголовков и значения. */
export function matchesCheck(record: SourceRecord, check: CompiledCheck): boolean {
  try {
    return (
      matchesHeaders(record, check.headers) &&
      check.values.every((condition) => matchesValueCondition(record, condition))
    );
  } catch {
    return false;
  }
}

/** Подготавливает все JSON-пути проверки без создания частичного результата. */
export function prepareCheck(input: CheckInput): PrepareCheckResult {
  const headers: CompiledHeaderCondition[] = (input.headers ?? []).map((condition) => ({
    name: condition.name,
    value: condition.value,
    operation: condition.operation ?? 'EQUALS',
    ignoreCase: condition.ignoreCase ?? false,
  }));
  const values: CompiledValueCondition[] = [];

  for (const condition of input.values ?? []) {
    const jsonPath = parseJsonPath(condition.jsonPath);
    if (jsonPath === undefined) {
      return { kind: 'invalid-json-path', jsonPath: condition.jsonPath };
    }
    values.push({
      jsonPath,
      value: condition.value,
      operation: condition.operation ?? 'EQUALS',
      ignoreCase: condition.ignoreCase ?? false,
    });
  }

  return {
    kind: 'ok',
    check: { headers, values },
  };
}
