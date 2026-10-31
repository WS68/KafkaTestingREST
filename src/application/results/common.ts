export type ServiceUnavailableResult = {
  readonly kind: 'kafka-unavailable';
};

export type ServiceStoppingResult = {
  readonly kind: 'service-stopping';
};

export type ApplicationFailure = ServiceUnavailableResult | ServiceStoppingResult;
