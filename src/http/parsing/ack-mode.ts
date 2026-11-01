export type AckMode = 'broker' | 'none';

export type ParsedAckMode =
  { readonly kind: 'ok'; readonly value: AckMode } | { readonly kind: 'invalid' };

/** Строго разбирает режим подтверждения публикации из query-параметра ack. */
export function parseAckMode(raw: unknown): ParsedAckMode {
  if (raw === undefined) {
    return { kind: 'ok', value: 'broker' };
  }

  if (raw === '0') {
    return { kind: 'ok', value: 'none' };
  }

  if (raw === '1') {
    return { kind: 'ok', value: 'broker' };
  }

  return { kind: 'invalid' };
}
