import type { SourceRecord } from '../../domain/record.js';

export type ReadResult =
  | { readonly kind: 'records'; readonly records: readonly SourceRecord[] }
  | { readonly kind: 'slot-not-found' }
  | { readonly kind: 'check-not-found' }
  | { readonly kind: 'invalid-pagination' }
  | { readonly kind: 'not-representable' };
