import type { JsonPathSegment } from './checking/json-path.js';

/** Ожидаемое строковое условие для одного заголовка записи. */
export interface CompiledHeaderCondition {
  readonly name: string;
  readonly value: string;
}

/** Ожидаемое строковое условие для значения записи по подготовленному JSON-пути. */
export interface CompiledValueCondition {
  readonly jsonPath: readonly JsonPathSegment[];
  readonly value: string;
}

/** Неизменяемая проверка; пустые массивы означают отсутствие соответствующего ограничения. */
export interface CompiledCheck {
  readonly headers: readonly CompiledHeaderCondition[];
  readonly values: readonly CompiledValueCondition[];
}
