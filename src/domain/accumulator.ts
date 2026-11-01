import type { CompiledCheck } from './check.js';
import type { SourceRecord } from './record.js';

/** Снимок состояния накопителя записей для одной проверки. */
export interface CheckAccumulator {
  readonly check: CompiledCheck;
  readonly records: readonly SourceRecord[];
  readonly count: number;
}
