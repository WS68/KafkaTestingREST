import type { SlotId } from '../../domain/slot.js';

/** Sources of identifiers used by application operations. */
export interface IdSource {
  /** Create an identifier for a newly registered slot. */
  newSlotId(): SlotId;

  /** Create an identifier for a waiting operation. */
  newWaitId(): string;

  /**
   * Create the application run identifier.
   * The adapter creates this identifier once during application startup.
   */
  newRunId(): string;
}
