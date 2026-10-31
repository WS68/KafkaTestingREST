import type { AppConfig, ConfigIssue, ConfigLoadResult } from './app-config.js';

const numericPattern = /^(0|[1-9][0-9]*)$/;

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigLoadResult {
  const issues: ConfigIssue[] = [];

  const text = (name: string, field: string, fallback?: string): string => {
    const value = env[name];
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      issues.push({ field, reason: 'missing' });
      return '';
    }
    if (value === '') {
      issues.push({ field, reason: 'empty' });
      return fallback ?? '';
    }
    return value;
  };

  const number = (name: string, field: string, fallback: number): number => {
    const value = env[name];
    if (value === undefined) return fallback;
    if (value === '') {
      issues.push({ field, reason: 'empty' });
      return fallback;
    }
    if (!numericPattern.test(value)) {
      issues.push({ field, reason: 'invalid-number' });
      return fallback;
    }
    return Number(value);
  };

  const cluster = text('KAFKA_TESTING_REST_CLUSTER', 'cluster');
  const httpHost = text('KAFKA_TESTING_REST_HTTP_HOST', 'httpHost', '127.0.0.1');
  const httpPort = number('KAFKA_TESTING_REST_HTTP_PORT', 'httpPort', 3000);
  // Элементы списка сохраняются без нормализации: пробелы могут быть значимы.
  const topicsValue = env['KAFKA_TESTING_REST_PUBLISHER_TOPICS'];
  let publisherTopics: readonly string[] = [];
  if (topicsValue !== undefined) {
    if (topicsValue === '') {
      issues.push({ field: 'publisherTopics', reason: 'empty' });
    } else {
      try {
        const parsed: unknown = JSON.parse(topicsValue);
        if (Array.isArray(parsed) && parsed.every((topic: unknown) => typeof topic === 'string')) {
          publisherTopics = parsed;
        } else {
          issues.push({ field: 'publisherTopics', reason: 'invalid-json' });
        }
      } catch {
        issues.push({ field: 'publisherTopics', reason: 'invalid-json' });
      }
    }
  }
  const autoDeleteSlotsSeconds = number(
    'KAFKA_TESTING_REST_AUTO_DELETE_SLOTS_SECONDS',
    'autoDeleteSlotsSeconds',
    60,
  );
  const consumerIdleSeconds = number(
    'KAFKA_TESTING_REST_CONSUMER_IDLE_SECONDS',
    'consumerIdleSeconds',
    3600,
  );
  const consumerGroupPrefix = text(
    'KAFKA_TESTING_REST_CONSUMER_GROUP_PREFIX',
    'consumerGroupPrefix',
    'testing-REST-API',
  );
  const defaultWaitSeconds = number(
    'KAFKA_TESTING_REST_DEFAULT_WAIT_SECONDS',
    'defaultWaitSeconds',
    60,
  );

  if (issues.length > 0) return { kind: 'error', issues };
  const config: AppConfig = {
    cluster,
    httpHost,
    httpPort,
    publisherTopics,
    autoDeleteSlotsSeconds,
    consumerIdleSeconds,
    consumerGroupPrefix,
    defaultWaitSeconds,
  };
  return { kind: 'ok', config };
}
