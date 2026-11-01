import type { LogFields, LogLevel, Logger } from '../../application/ports/logger.js';

const consoleMethod: Record<LogLevel, (...values: unknown[]) => void> = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export function createConsoleLogger(): Logger {
  const log = (level: LogLevel, event: string, fields?: LogFields): void => {
    const payload = fields === undefined ? { event } : { event, ...fields };
    consoleMethod[level](JSON.stringify(payload));
  };

  return {
    log,
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}
