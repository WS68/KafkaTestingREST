import type { SlotCheckDto } from './check.js';

export type SlotRegistrationRequestDto = {
  topic: string;
  autoDeleteSeconds?: number;
  checks: readonly SlotCheckDto[];
};
