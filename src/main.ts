import { ConfigurationError, startApplication } from './composition/runtime.js';
import { createConsoleLogger } from './infrastructure/logging/console-logger.js';

export async function main(): Promise<void> {
  const logger = createConsoleLogger();
  try {
    await startApplication({ env: process.env, logger });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error('Некорректная конфигурация приложения:', error.issues);
      process.exitCode = 1;
      return;
    }
    console.error('Не удалось запустить приложение.');
    process.exitCode = 1;
  }
}
