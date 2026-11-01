export interface AppConfig {
  readonly cluster: string;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly publisherTopics: readonly string[];
  readonly autoDeleteSlotsSeconds: number;
  readonly consumerIdleSeconds: number;
  readonly consumerGroupPrefix: string;
  readonly defaultWaitSeconds: number;
}

export type ConfigIssue = {
  readonly field: string;
  readonly reason:
    | 'missing'
    | 'empty'
    | 'invalid-number'
    | 'invalid-json'
    | 'invalid-cluster'
    | 'invalid-host'
    | 'out-of-range'
    | 'invalid-prefix'
    | 'invalid-regex';
};

export type ConfigLoadResult =
  | { readonly kind: 'ok'; readonly config: AppConfig }
  | { readonly kind: 'error'; readonly issues: readonly ConfigIssue[] };
