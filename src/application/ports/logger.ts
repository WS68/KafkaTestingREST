export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** JSON-like values accepted as structured event fields. */
export type LogFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly LogFieldValue[]
  | { readonly [key: string]: LogFieldValue };

export type LogFields = Readonly<Record<string, LogFieldValue>>;

/**
 * Minimal structured journal port independent of the application runtime.
 * Events do not contain stack traces, record contents, or infrastructure addresses.
 */
export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;

  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}
