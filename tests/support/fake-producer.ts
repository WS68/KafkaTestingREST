import type {
  KafkaJsProducerLike,
  KafkaJsProducerSendOptions,
} from '../../src/infrastructure/kafka/kafka-producer-lifecycle.js';

export type FakeSendPlan =
  | { readonly kind: 'resolve' }
  | { readonly kind: 'reject'; readonly error: unknown }
  | { readonly kind: 'deferred' };

type FakeCall =
  | { readonly kind: 'connect' }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'send'; readonly options: KafkaJsProducerSendOptions };

type PendingSend = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

export interface FakeProducer extends KafkaJsProducerLike {
  readonly calls: readonly FakeCall[];
  readonly sendArguments: readonly KafkaJsProducerSendOptions[];
  readonly connectCalls: number;
  readonly disconnectCalls: number;
  readonly sendCalls: number;
  readonly lateFailureListenerCount: number;
  setNextSend(plan: FakeSendPlan): void;
  setConnectFailure(error: unknown | undefined): void;
  resolvePendingSend(): void;
  rejectPendingSend(error: unknown): void;
  emitLateFailure(error: unknown): void;
}

export function createFakeProducer(): FakeProducer {
  const calls: FakeCall[] = [];
  const sendArguments: KafkaJsProducerSendOptions[] = [];
  const plans: FakeSendPlan[] = [];
  const listeners = new Set<(error: unknown) => void>();
  let connectCalls = 0;
  let disconnectCalls = 0;
  let sendCalls = 0;
  let connectFailure: unknown | undefined;
  let pendingSend: PendingSend | undefined;

  const producer: FakeProducer = {
    calls,
    sendArguments,
    get connectCalls() {
      return connectCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    get sendCalls() {
      return sendCalls;
    },
    get lateFailureListenerCount() {
      return listeners.size;
    },
    async connect(): Promise<void> {
      connectCalls += 1;
      calls.push({ kind: 'connect' });
      if (connectFailure !== undefined) throw connectFailure;
    },
    async disconnect(): Promise<void> {
      disconnectCalls += 1;
      calls.push({ kind: 'disconnect' });
    },
    send(options: KafkaJsProducerSendOptions): Promise<unknown> {
      sendCalls += 1;
      sendArguments.push(options);
      calls.push({ kind: 'send', options });
      const plan = plans.shift() ?? { kind: 'resolve' as const };
      if (plan.kind === 'resolve') return Promise.resolve();
      if (plan.kind === 'reject') return Promise.reject(plan.error);
      return new Promise<unknown>((resolve, reject) => {
        pendingSend = { resolve, reject };
      });
    },
    onLateFailure(listener: (error: unknown) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setNextSend(plan: FakeSendPlan): void {
      plans.push(plan);
    },
    setConnectFailure(error: unknown | undefined): void {
      connectFailure = error;
    },
    resolvePendingSend(): void {
      const pending = pendingSend;
      pendingSend = undefined;
      pending?.resolve(undefined);
    },
    rejectPendingSend(error: unknown): void {
      const pending = pendingSend;
      pendingSend = undefined;
      pending?.reject(error);
    },
    emitLateFailure(error: unknown): void {
      for (const listener of listeners) listener(error);
    },
  };
  return producer;
}
