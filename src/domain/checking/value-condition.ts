function containsUnsupportedValue(value: unknown, active: WeakSet<object>): boolean {
  if (value === null) return false;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value !== 'object') {
    return (
      typeof value === 'undefined' ||
      typeof value === 'function' ||
      typeof value === 'symbol' ||
      typeof value === 'bigint'
    );
  }
  if (active.has(value)) return true;
  active.add(value);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (containsUnsupportedValue(value[index], active)) return true;
      }
    } else {
      for (const key of Object.keys(value)) {
        if (containsUnsupportedValue((value as Record<string, unknown>)[key], active)) return true;
      }
    }
    return false;
  } finally {
    active.delete(value);
  }
}

/** Преобразует один выбранный JSON-узел в строку условия. */
export function nodeToString(node: unknown): string | undefined {
  try {
    if (node === null) return 'null';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return Number.isFinite(node) ? String(node) : undefined;
    if (typeof node === 'boolean') return String(node);
    if (typeof node !== 'object' || containsUnsupportedValue(node, new WeakSet<object>()))
      return undefined;

    const serialized = JSON.stringify(node);
    return serialized === undefined ? undefined : serialized;
  } catch {
    return undefined;
  }
}
