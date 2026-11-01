export type ParsedNumber =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly value: number }
  | { readonly kind: 'invalid' };

const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

/** Строго разбирает строку неотрицательного безопасного целого числа. */
export function parseStrictInteger(raw: string | undefined): ParsedNumber {
  if (raw === undefined) {
    return { kind: 'absent' };
  }

  if (!NON_NEGATIVE_INTEGER_PATTERN.test(raw)) {
    return { kind: 'invalid' };
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return { kind: 'invalid' };
  }

  return { kind: 'ok', value };
}

/** Возвращает число только для корректной строки; отсутствие и ошибка дают undefined. */
export function parseStrictNonNegativeInteger(raw: string | undefined): number | undefined {
  const parsed = parseStrictInteger(raw);
  return parsed.kind === 'ok' ? parsed.value : undefined;
}
