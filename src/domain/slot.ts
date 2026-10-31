import type { CompiledCheck } from './check.js';

export type SlotId = string;

/** Зафиксированный слот с неизменяемым описанием проверки и сроком удаления. */
export interface Slot {
  readonly id: SlotId;
  readonly topic: string;
  readonly checks: readonly CompiledCheck[];
  readonly expiresAt: number;
  readonly deleted: boolean;
}

/** Подготовленный к фиксации слот с эффективным сроком автоматического удаления. */
export interface SlotRegistration {
  readonly topic: string;
  readonly checks: readonly CompiledCheck[];
  readonly autoDeleteSeconds: number;
}
