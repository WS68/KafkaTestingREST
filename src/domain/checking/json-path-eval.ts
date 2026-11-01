import type { JsonPathSegment } from './json-path.js';

/** Безопасно выбирает узлы по заранее разобранному JSONPath. */
export function selectNodes(
  value: unknown,
  segments: readonly JsonPathSegment[],
): readonly unknown[] {
  try {
    let nodes: readonly unknown[] = [value];

    for (const segment of segments) {
      if (segment.kind === 'root') continue;
      const next: unknown[] = [];

      for (const node of nodes) {
        if (segment.kind === 'property') {
          if (
            node === null ||
            typeof node !== 'object' ||
            Array.isArray(node) ||
            !Object.prototype.hasOwnProperty.call(node, segment.name)
          )
            continue;
          next.push((node as Record<string, unknown>)[segment.name]);
        } else if (segment.kind === 'index') {
          if (
            !Array.isArray(node) ||
            segment.index >= node.length ||
            !Object.prototype.hasOwnProperty.call(node, String(segment.index))
          )
            continue;
          next.push(node[segment.index]);
        } else if (Array.isArray(node)) {
          next.push(...node);
        } else if (node !== null && typeof node === 'object') {
          for (const key of Object.keys(node)) {
            next.push((node as Record<string, unknown>)[key]);
          }
        }
      }

      nodes = next;
    }

    return nodes;
  } catch {
    return [];
  }
}
