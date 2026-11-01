import type { WaitOutcome } from '../../domain/wait.js';
import type { ServiceStoppingResult } from './common.js';

type CompletedWaitResult = {
  [Outcome in Exclude<WaitOutcome, 'service-stopping'>]: {
    readonly kind: Outcome extends 'condition' ? 'condition-met' : Outcome;
  };
}[Exclude<WaitOutcome, 'service-stopping'>];

export type WaitResult =
  | CompletedWaitResult
  | ServiceStoppingResult
  | { readonly kind: 'slot-not-found' }
  | { readonly kind: 'check-not-found' }
  | { readonly kind: 'invalid-request' };
