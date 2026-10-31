/** A handle for a scheduled task owned by a clock adapter. */
export interface ScheduledTask {
  /** Whether the task is still eligible to run. */
  readonly active: boolean;

  /**
   * Cancel the task. Repeated cancellation is safe; the adapter must release
   * the underlying timer when the task is cancelled or completed.
   */
  cancel(): void;
}

/** Time and scheduling operations required by the application layer. */
export interface Clock {
  /** Current epoch time in milliseconds. */
  now(): number;

  /** Schedule a task without coupling the application to a runtime timer API. */
  schedule(delayMs: number, task: () => void): ScheduledTask;
}
