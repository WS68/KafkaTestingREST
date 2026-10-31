import type { AppConfig, ConfigIssue } from './app-config.js';

export interface PreparedConfig {
  readonly cluster: { readonly host: string; readonly port: number };
  readonly httpHost: string;
  readonly httpPort: number;
  readonly publisherTopics: readonly RegExp[];
  readonly autoDeleteSlotsSeconds: number;
  readonly consumerIdleSeconds: number;
  readonly consumerGroupPrefix: string;
  readonly defaultWaitSeconds: number;
  readonly autoDeleteSlotsMs: number;
  readonly consumerIdleMs: number;
  readonly defaultWaitMs: number;
}

export type PrepareConfigResult =
  | { readonly kind: 'ok'; readonly config: PreparedConfig }
  | { readonly kind: 'error'; readonly issues: readonly ConfigIssue[] };

const maxSeconds = 2_147_483_647;
const validPort = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
const validSeconds = (value: number, allowZero: boolean): boolean =>
  Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= maxSeconds;

export function prepareConfig(raw: AppConfig): PrepareConfigResult {
  const issues: ConfigIssue[] = [];
  let cluster: PreparedConfig['cluster'] | undefined;

  const clusterMatch = /^([^:]+):(\d+)$/.exec(raw.cluster);
  if (
    clusterMatch === null ||
    /\s/.test(raw.cluster) ||
    raw.cluster.includes('://') ||
    raw.cluster.includes('/') ||
    raw.cluster.includes('@') ||
    raw.cluster.includes(',')
  ) {
    issues.push({ field: 'cluster', reason: 'invalid-cluster' });
  } else {
    const host = clusterMatch[1];
    const port = Number(clusterMatch[2]);
    if (host === undefined || !validPort(port))
      issues.push({ field: 'cluster', reason: 'invalid-cluster' });
    else cluster = { host, port };
  }

  if (raw.httpHost === '') issues.push({ field: 'httpHost', reason: 'empty' });
  else if (raw.httpHost.trim() !== raw.httpHost || raw.httpHost.trim() === '')
    issues.push({ field: 'httpHost', reason: 'invalid-host' });

  if (!validPort(raw.httpPort)) issues.push({ field: 'httpPort', reason: 'out-of-range' });

  const publisherTopics: RegExp[] = [];
  for (const expression of raw.publisherTopics) {
    try {
      publisherTopics.push(new RegExp(expression));
    } catch {
      issues.push({ field: 'publisherTopics', reason: 'invalid-regex' });
      break;
    }
  }

  if (!/^[A-Za-z0-9._-]+$/.test(raw.consumerGroupPrefix)) {
    issues.push({
      field: 'consumerGroupPrefix',
      reason: raw.consumerGroupPrefix === '' ? 'empty' : 'invalid-prefix',
    });
  }

  const secondsFields = [
    ['autoDeleteSlotsSeconds', raw.autoDeleteSlotsSeconds, false],
    ['consumerIdleSeconds', raw.consumerIdleSeconds, true],
    ['defaultWaitSeconds', raw.defaultWaitSeconds, false],
  ] as const;
  for (const [field, value, allowZero] of secondsFields) {
    if (!validSeconds(value, allowZero)) issues.push({ field, reason: 'out-of-range' });
  }

  const autoDeleteSlotsMs = raw.autoDeleteSlotsSeconds * 1000;
  const consumerIdleMs = raw.consumerIdleSeconds * 1000;
  const defaultWaitMs = raw.defaultWaitSeconds * 1000;
  if (
    (validSeconds(raw.autoDeleteSlotsSeconds, false) && !Number.isSafeInteger(autoDeleteSlotsMs)) ||
    (validSeconds(raw.consumerIdleSeconds, true) && !Number.isSafeInteger(consumerIdleMs)) ||
    (validSeconds(raw.defaultWaitSeconds, false) && !Number.isSafeInteger(defaultWaitMs))
  ) {
    issues.push({ field: 'timeouts', reason: 'out-of-range' });
  }

  if (issues.length > 0 || cluster === undefined) return { kind: 'error', issues };
  return {
    kind: 'ok',
    config: {
      cluster,
      httpHost: raw.httpHost,
      httpPort: raw.httpPort,
      publisherTopics,
      autoDeleteSlotsSeconds: raw.autoDeleteSlotsSeconds,
      consumerIdleSeconds: raw.consumerIdleSeconds,
      consumerGroupPrefix: raw.consumerGroupPrefix,
      defaultWaitSeconds: raw.defaultWaitSeconds,
      autoDeleteSlotsMs,
      consumerIdleMs,
      defaultWaitMs,
    },
  };
}
