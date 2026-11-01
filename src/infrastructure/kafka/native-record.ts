import type { PublicationRecordBytes } from '../../application/ports/kafka-publisher.js';
import type { ReadonlyBytes } from '../../domain/record.js';
import { decodeStrictUtf8 } from '../../domain/encoding/strict-utf8.js';

export interface NativeHeader {
  readonly name: string;
  readonly value: Buffer;
}

/** Сообщение сохраняет заголовки массивом, поскольку KafkaJS не сохраняет порядок имён в объекте. */
export interface NativeMessage {
  readonly key?: Buffer;
  readonly value: ReadonlyBytes;
  readonly headers: readonly NativeHeader[];
}

export type NativeMessageResult =
  | { readonly kind: 'ok'; readonly message: NativeMessage }
  | { readonly kind: 'invalid-header-name' };

/** Создаёт Buffer-представление без копирования общего буфера исходных байтов. */
function asBuffer(bytes: ReadonlyBytes): Buffer {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Преобразует подготовленную запись в транспортную форму без HTTP- или base64-конверта.
 * Преобразование массива заголовков в KafkaJS IHeaders выполняется только при отправке.
 */
export function toNativeMessage(record: PublicationRecordBytes): NativeMessageResult {
  const headers: NativeHeader[] = [];
  for (const header of record.headers) {
    const name = decodeStrictUtf8(header.name);
    if (name === undefined) return { kind: 'invalid-header-name' };
    headers.push({ name, value: asBuffer(header.value) });
  }

  const message =
    record.key === undefined
      ? { value: record.value, headers }
      : { key: asBuffer(record.key), value: record.value, headers };
  return { kind: 'ok', message };
}
