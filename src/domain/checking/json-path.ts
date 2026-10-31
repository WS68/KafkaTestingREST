export type JsonPathSegment =
  | { readonly kind: 'root' }
  | { readonly kind: 'property'; readonly name: string }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'wildcard' };

const propertyName = /^[A-Za-z_][A-Za-z0-9_]*/;
const arrayIndex = /^(?:0|[1-9][0-9]*)/;

function frozen<T extends object>(value: T): T {
  return Object.freeze(value);
}

/** Разбирает только явно разрешённые формы JSONPath. */
export function parseJsonPath(path: string): JsonPathSegment[] | undefined {
  if (path.length === 0 || path[0] !== '$') return undefined;

  const segments: JsonPathSegment[] = [frozen({ kind: 'root' })];
  let position = 1;

  while (position < path.length) {
    const character = path[position];
    if (character === '.') {
      const match = propertyName.exec(path.slice(position + 1));
      if (match === null) return undefined;
      segments.push(frozen({ kind: 'property', name: match[0] }));
      position += match[0].length + 1;
      continue;
    }

    if (character !== '[') return undefined;
    const rest = path.slice(position + 1);

    if (rest.startsWith('*]')) {
      segments.push(frozen({ kind: 'wildcard' }));
      position += 3;
      continue;
    }

    const indexMatch = arrayIndex.exec(rest);
    if (indexMatch !== null && rest[indexMatch[0].length] === ']') {
      const index = Number(indexMatch[0]);
      if (!Number.isSafeInteger(index)) return undefined;
      segments.push(frozen({ kind: 'index', index }));
      position += indexMatch[0].length + 2;
      continue;
    }

    if (rest[0] !== '"') return undefined;
    let end = 1;
    let escaped = false;
    for (; end < rest.length; end += 1) {
      const current = rest[end];
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        break;
      }
    }
    if (end >= rest.length || rest[end + 1] !== ']') return undefined;

    let name: unknown;
    try {
      name = JSON.parse(rest.slice(0, end + 1)) as unknown;
    } catch {
      return undefined;
    }
    if (typeof name !== 'string') return undefined;
    segments.push(frozen({ kind: 'property', name }));
    position += end + 3;
  }

  return Object.freeze(segments) as unknown as JsonPathSegment[];
}
