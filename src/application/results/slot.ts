import type { SlotId } from '../../domain/slot.js';
import type { ServiceUnavailableResult } from './common.js';

export type SlotRegistrationResult =
  | { readonly kind: 'registered'; readonly slotId: SlotId; readonly checkCount: number }
  | { readonly kind: 'invalid-request' }
  | ServiceUnavailableResult;

export type SlotDeletionResult = { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

export type CountResult =
  | { readonly kind: 'counted'; readonly count: number }
  | { readonly kind: 'slot-not-found' }
  | { readonly kind: 'check-not-found' };
