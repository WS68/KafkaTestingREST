import type { JsonPathSegment } from './checking/json-path.js';

/** Допустимая операция сравнения строкового условия. */
export type CheckOperation = 'EQUALS' | 'CONTAINS';

/** Ожидаемое строковое условие для одного заголовка записи. */
export interface CompiledHeaderCondition {
  readonly name: string;
  readonly value: string;
  readonly operation: CheckOperation;
  readonly ignoreCase: boolean;
}

/** Ожидаемое строковое условие для значения записи по подготовленному JSON-пути. */
export interface CompiledValueCondition {
  readonly jsonPath: readonly JsonPathSegment[];
  readonly value: string;
  readonly operation: CheckOperation;
  readonly ignoreCase: boolean;
}

/** Неизменяемая проверка; пустые массивы означают отсутствие соответствующего ограничения. */
export interface CompiledCheck {
  readonly headers: readonly CompiledHeaderCondition[];
  readonly values: readonly CompiledValueCondition[];
}
