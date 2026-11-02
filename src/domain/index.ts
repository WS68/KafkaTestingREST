export type {
  CheckOperation,
  CompiledCheck,
  CompiledHeaderCondition,
  CompiledValueCondition,
} from './check.js';
export { matchesCheck, prepareCheck } from './checking/index.js';
export type { CheckAccumulator } from './accumulator.js';
export { cloneSourceRecord, createCheckAccumulator } from './accumulation/index.js';
export type { CheckAccumulatorStore } from './accumulation/index.js';
export { createSlotRegistry } from './slots/index.js';
export type {
  AppendToCheckResult,
  PreparedSlot,
  RegisteredSlot,
  SlotRegistrationResult,
  SlotRegistry,
} from './slots/index.js';
export type {
  ConsumerGeneration,
  ConsumerLifecycleState,
  ConsumerReservation,
  SlotLifecycleState,
} from './consumer.js';
export type { ReadonlyBytes, SourceHeader, SourceRecord } from './record.js';
export type { Slot, SlotId, SlotRegistration } from './slot.js';
export type { WaitHandle, WaitOutcome, WaitRequest } from './wait.js';
