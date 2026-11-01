export function createTopicMatcher(patterns: readonly RegExp[]): (topic: string) => boolean {
  if (patterns.length === 0) return () => true;

  return (topic: string): boolean => {
    try {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        const match = pattern.exec(topic);
        // Собственные якоря выражения сохраняют заданную автором семантику; без них требуется полное совпадение.
        if (
          match !== null &&
          (pattern.source.startsWith('^') || pattern.source.endsWith('$') || match[0] === topic)
        )
          return true;
      }
    } catch {
      return false;
    }
    return false;
  };
}
