import type {
  KafkaJsAdminLike,
  KafkaJsConsumedMessage,
  KafkaJsConsumerLike,
} from '../../src/infrastructure/kafka/native-consumer.js';
import type { KafkaJsAdminClientLike } from '../../src/infrastructure/kafka/native-group-admin.js';

type ConsumerCall =
  | { readonly kind: 'connect' }
  | { readonly kind: 'subscribe'; readonly options: { topic: string; fromBeginning: boolean } }
  | { readonly kind: 'run' }
  | { readonly kind: 'disconnect' }
  | {
      readonly kind: 'seek';
      readonly options: { topic: string; partition: number; offset: string };
    };

type AdminCall =
  { readonly kind: 'fetchTopicOffsets'; readonly topic: string } | { readonly kind: 'disconnect' };

type AdminClientCall =
  | {
      readonly kind: 'deleteGroups';
      readonly options: { readonly groupIds: readonly string[] };
    }
  | { readonly kind: 'disconnect' };

type EachMessage = (payload: { topic: string; message: KafkaJsConsumedMessage }) => Promise<void>;

type FailurePlan = { readonly error: unknown } | undefined;

export interface FakeConsumer extends KafkaJsConsumerLike {
  readonly calls: readonly ConsumerCall[];
  readonly subscribeArguments: readonly { topic: string; fromBeginning: boolean }[];
  readonly seekCalls: readonly { topic: string; partition: number; offset: string }[];
  readonly connectCalls: number;
  readonly subscribeCalls: number;
  readonly runCalls: number;
  readonly disconnectCalls: number;
  setConnectFailure(error: unknown | undefined): void;
  setSubscribeFailure(error: unknown | undefined): void;
  setSeekFailure(error: unknown | undefined): void;
  emitGroupJoin(assignment: Record<string, number[]>): void;
  emitMessage(message: KafkaJsConsumedMessage, topic?: string): Promise<void>;
}

export interface FakeAdmin extends KafkaJsAdminLike {
  readonly calls: readonly AdminCall[];
  readonly fetchCalls: number;
  readonly disconnectCalls: number;
  setOffsets(offsets: readonly { partition: number; offset: string }[]): void;
  setFetchFailure(error: unknown | undefined): void;
}

export interface FakeAdminClient extends KafkaJsAdminClientLike {
  readonly calls: readonly AdminClientCall[];
  readonly deleteGroupsArguments: readonly { readonly groupIds: readonly string[] }[];
  readonly deleteGroupsCalls: number;
  readonly disconnectCalls: number;
  setDeleteGroupsFailure(error: unknown | undefined): void;
  setDisconnectFailure(error: unknown | undefined): void;
}

export function createFakeConsumer(): FakeConsumer {
  const calls: ConsumerCall[] = [];
  const subscribeArguments: { topic: string; fromBeginning: boolean }[] = [];
  const seekCalls: { topic: string; partition: number; offset: string }[] = [];
  const listeners = new Set<
    (payload: { payload: { memberAssignment: Record<string, readonly number[]> } }) => void
  >();
  let eachMessage: EachMessage | undefined;
  let connectFailure: FailurePlan;
  let subscribeFailure: FailurePlan;
  let seekFailure: FailurePlan;
  let connectCalls = 0;
  let subscribeCalls = 0;
  let runCalls = 0;
  let disconnectCalls = 0;

  return {
    calls,
    subscribeArguments,
    seekCalls,
    get connectCalls() {
      return connectCalls;
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get runCalls() {
      return runCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    async connect(): Promise<void> {
      connectCalls += 1;
      calls.push({ kind: 'connect' });
      if (connectFailure !== undefined) throw connectFailure.error;
    },
    async subscribe(options): Promise<void> {
      subscribeCalls += 1;
      subscribeArguments.push(options);
      calls.push({ kind: 'subscribe', options });
      if (subscribeFailure !== undefined) throw subscribeFailure.error;
    },
    async run(options): Promise<void> {
      runCalls += 1;
      eachMessage = options.eachMessage;
      calls.push({ kind: 'run' });
    },
    async disconnect(): Promise<void> {
      disconnectCalls += 1;
      calls.push({ kind: 'disconnect' });
    },
    on(_event, listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    seek(options): void {
      if (seekFailure !== undefined) throw seekFailure.error;
      seekCalls.push(options);
      calls.push({ kind: 'seek', options });
    },
    setConnectFailure(error): void {
      connectFailure = error === undefined ? undefined : { error };
    },
    setSubscribeFailure(error): void {
      subscribeFailure = error === undefined ? undefined : { error };
    },
    setSeekFailure(error): void {
      seekFailure = error === undefined ? undefined : { error };
    },
    emitGroupJoin(assignment): void {
      for (const listener of listeners) listener({ payload: { memberAssignment: assignment } });
    },
    async emitMessage(message, topic = 'topic'): Promise<void> {
      await eachMessage?.({ topic, message });
    },
  };
}

export function createFakeAdmin(): FakeAdmin {
  const calls: AdminCall[] = [];
  let offsets: readonly { partition: number; offset: string }[] = [];
  let fetchFailure: FailurePlan;
  let fetchCalls = 0;
  let disconnectCalls = 0;

  return {
    calls,
    get fetchCalls() {
      return fetchCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    async fetchTopicOffsets(topic): Promise<readonly { partition: number; offset: string }[]> {
      fetchCalls += 1;
      calls.push({ kind: 'fetchTopicOffsets', topic });
      if (fetchFailure !== undefined) throw fetchFailure.error;
      return offsets;
    },
    async disconnect(): Promise<void> {
      disconnectCalls += 1;
      calls.push({ kind: 'disconnect' });
    },
    setOffsets(value): void {
      offsets = value;
    },
    setFetchFailure(error): void {
      fetchFailure = error === undefined ? undefined : { error };
    },
  };
}

export function createFakeAdminClient(): FakeAdminClient {
  const calls: AdminClientCall[] = [];
  const deleteGroupsArguments: { readonly groupIds: readonly string[] }[] = [];
  let deleteGroupsFailure: FailurePlan;
  let disconnectFailure: FailurePlan;
  let deleteGroupsCalls = 0;
  let disconnectCalls = 0;

  return {
    calls,
    deleteGroupsArguments,
    get deleteGroupsCalls() {
      return deleteGroupsCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    async deleteGroups(options): Promise<void> {
      deleteGroupsCalls += 1;
      deleteGroupsArguments.push(options);
      calls.push({ kind: 'deleteGroups', options });
      if (deleteGroupsFailure !== undefined) throw deleteGroupsFailure.error;
    },
    async disconnect(): Promise<void> {
      disconnectCalls += 1;
      if (disconnectFailure !== undefined) throw disconnectFailure.error;
      calls.push({ kind: 'disconnect' });
    },
    setDeleteGroupsFailure(error): void {
      deleteGroupsFailure = error === undefined ? undefined : { error };
    },
    setDisconnectFailure(error): void {
      disconnectFailure = error === undefined ? undefined : { error };
    },
  };
}
