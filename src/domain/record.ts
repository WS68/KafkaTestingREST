/** Исходные байты записи; тип намеренно не использует Node.js `Buffer`. */
export type ReadonlyBytes = Uint8Array;

/** Заголовок сохраняет исходные байты имени и значения. */
export interface SourceHeader {
  readonly name: ReadonlyBytes;
  readonly value: ReadonlyBytes | undefined;
}

/**
 * Исходная запись Kafka. Массив заголовков сохраняет порядок и дубликаты имён.
 */
export interface SourceRecord {
  readonly headers: readonly SourceHeader[];
  /** `undefined` означает отсутствие ключа, а пустые байты — существующий пустой ключ. */
  readonly key: ReadonlyBytes | undefined;
  /** `undefined` означает отсутствие значения, а пустые байты — существующее пустое значение. */
  readonly value: ReadonlyBytes | undefined;
}
