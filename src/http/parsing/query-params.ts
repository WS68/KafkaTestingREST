import { parseStrictInteger } from './index-number.js';

export interface SlotQueryDefaults {
  readonly waitTimeoutMs: number;
}

export type Parsed<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'invalid' };

export interface WaitParams {
  readonly n: number;
  readonly timeoutMs: number;
}

export type WaitParamsResult =
  | { readonly kind: 'ok'; readonly value: WaitParams }
  | { readonly kind: 'invalid-index' }
  | { readonly kind: 'invalid-params' };

export interface ReadParams {
  readonly offset: number;
  readonly count: number;
}

export type ReadParamsResult =
  | { readonly kind: 'ok'; readonly value: ReadParams }
  | { readonly kind: 'invalid-index' }
  | { readonly kind: 'invalid-pagination' };

/** Проверяет форму индекса для подсчёта и чтения. */
export function parseCheckIndexForRead(raw: string | undefined): Parsed<number> {
  return parseIndex(raw);
}

/** Проверяет форму индекса для ожидания. */
export function parseCheckIndexForWait(raw: string | undefined): Parsed<number> {
  return parseIndex(raw);
}

/** Разбирает индекс и параметры ожидания в контрактном порядке. */
export function parseWaitParams(
  index: string | undefined,
  n: string | undefined,
  timeoutMs: string | undefined,
  defaults: SlotQueryDefaults,
): WaitParamsResult {
  const parsedIndex = parseCheckIndexForWait(index);
  if (parsedIndex.kind === 'invalid') {
    return { kind: 'invalid-index' };
  }

  const parsedN = parseOptionalInteger(n, 1);
  const parsedTimeout = parseOptionalInteger(timeoutMs, defaults.waitTimeoutMs);
  if (parsedN === undefined || parsedN < 1 || parsedTimeout === undefined || parsedTimeout <= 0) {
    return { kind: 'invalid-params' };
  }

  return {
    kind: 'ok',
    value: { n: parsedN, timeoutMs: parsedTimeout },
  };
}

/** Разбирает индекс и параметры чтения в контрактном порядке. */
export function parseReadParams(
  index: string | undefined,
  offset: string | undefined,
  count: string | undefined,
): ReadParamsResult {
  const parsedIndex = parseCheckIndexForRead(index);
  if (parsedIndex.kind === 'invalid') {
    return { kind: 'invalid-index' };
  }

  const parsedOffset = parseOptionalInteger(offset, 0);
  const parsedCount = parseOptionalInteger(count, 20);
  if (
    parsedOffset === undefined ||
    parsedOffset < 0 ||
    parsedCount === undefined ||
    parsedCount <= 0
  ) {
    return { kind: 'invalid-pagination' };
  }

  return {
    kind: 'ok',
    value: { offset: parsedOffset, count: parsedCount },
  };
}

function parseIndex(raw: string | undefined): Parsed<number> {
  const parsed = parseStrictInteger(raw);
  return parsed.kind === 'ok' ? { kind: 'ok', value: parsed.value } : { kind: 'invalid' };
}

function parseOptionalInteger(raw: string | undefined, defaultValue: number): number | undefined {
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = parseStrictInteger(raw);
  return parsed.kind === 'ok' ? parsed.value : undefined;
}
