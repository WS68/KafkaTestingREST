import { caseFold } from 'unicode-case-folding';
import type { CheckOperation } from '../check.js';

/** Сравнивает фактическую и ожидаемую строки по операции проверки. */
export function matchesStringCondition(
  actual: string,
  expected: string,
  operation: CheckOperation,
  ignoreCase: boolean,
): boolean {
  const comparableActual = ignoreCase ? caseFold(actual) : actual;
  const comparableExpected = ignoreCase ? caseFold(expected) : expected;

  switch (operation) {
    case 'EQUALS':
      return comparableActual === comparableExpected;
    case 'CONTAINS':
      return comparableActual.includes(comparableExpected);
    default:
      return false;
  }
}
