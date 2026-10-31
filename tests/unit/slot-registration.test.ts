import { expect, test } from 'vitest';
import {
  createSlotRegistrationService,
  type SlotCheckInput,
} from '../../src/application/slots/index.js';
import type {
  ConsumerHandle,
  ConsumerManager,
  IdleCloseOutcome,
  Reservation,
} from '../../src/application/consumers/consumer-manager.js';
import type { ConsumerLifecycleState } from '../../src/domain/consumer.js';
import { createSlotRegistry, type SlotRegistry } from '../../src/domain/slots/index.js';
import type { SlotId } from '../../src/domain/slot.js';
import { ManualClock } from '../support/manual-clock.js';

type SetupOptions = {
  readonly initialTime?: number;
  readonly ids?: readonly SlotId[];
  readonly ensureError?: unknown;
  readonly advanceOnEnsure?: number;
  readonly barrier?: boolean;
};

function checks(count = 1): readonly SlotCheckInput[] {
  return Array.from({ length: count }, () => ({
    values: [{ jsonPath: '$.x', value: 'ok' }],
  }));
}

function setup(options: SetupOptions = {}) {
  const clock = new ManualClock(options.initialTime ?? 0);
  const calls: string[] = [];
  const ids = options.ids ?? ['slot-1'];
  let idCalls = 0;
  let state: ConsumerLifecycleState = options.barrier ? 'closing' : 'creating';
  let resolveEnsure: (() => void) | undefined;
  const ready: ConsumerHandle = {
    topic: 'topic',
    generation: 1,
    readyConsumer: { close: async () => undefined },
  };
  const registry = createSlotRegistry();
  const observedRegistry: SlotRegistry = {
    ...registry,
    register(prepared) {
      calls.push('register');
      return registry.register(prepared);
    },
  };
  const consumers: ConsumerManager = {
    listTopics: () => [],
    getExpiresAt: () => undefined,
    reserve(topic, _autoDeleteSeconds): Reservation {
      calls.push('reserve');
      return { topic, generation: 1 };
    },
    async ensureReady(_reservation): Promise<ConsumerHandle> {
      calls.push('ensureReady');
      if (options.ensureError !== undefined) throw options.ensureError;
      if (options.advanceOnEnsure !== undefined) clock.advance(options.advanceOnEnsure);
      if (options.barrier) {
        await new Promise<void>((resolve) => {
          resolveEnsure = resolve;
        });
      }
      state = 'ready';
      return ready;
    },
    release(_reservation): void {
      calls.push('release');
    },
    extend(_topic, _autoDeleteSeconds): void {
      calls.push('extend');
    },
    hasActiveReservations: () => false,
    getState: (_topic): ConsumerLifecycleState => state,
    tryCloseIdle: async (_topic, _hasActiveSlots): Promise<IdleCloseOutcome> => 'closed',
    close: async (_topic, _reason): Promise<void> => undefined,
    closeAll: async (_reason): Promise<void> => undefined,
  };
  const service = createSlotRegistrationService({
    registry: observedRegistry,
    consumers,
    ids: {
      newSlotId(): SlotId {
        idCalls += 1;
        return ids[idCalls - 1] ?? ids[ids.length - 1] ?? 'slot-fallback';
      },
      newWaitId: () => 'wait-1',
      newRunId: () => 'run-1',
    },
    clock,
    getDefaultAutoDeleteSeconds: () => 60,
  });

  return {
    clock,
    calls,
    registry,
    service,
    idCalls: () => idCalls,
    resolveEnsure: (): void => resolveEnsure?.(),
    consumers,
  };
}

test('uses the requested expiration and keeps it fixed', async () => {
  const state = setup({ initialTime: 1_000 });
  await expect(
    state.service.register({ topic: 'topic', checks: checks(), autoDeleteSeconds: 5 }),
  ).resolves.toEqual({ kind: 'registered', slotId: 'slot-1', checkCount: 1 });

  const expiresAt = state.registry.get('slot-1')?.slot.expiresAt;
  expect(expiresAt).toBe(state.clock.now() + 5_000);
  state.consumers.extend('topic', 60);
  expect(state.registry.get('slot-1')?.slot.expiresAt).toBe(expiresAt);
});

test('uses the default expiration when the request omits it', async () => {
  const state = setup({ initialTime: 1_000 });
  await state.service.register({ topic: 'topic', checks: checks(2) });

  expect(state.registry.get('slot-1')?.slot.expiresAt).toBe(61_000);
  expect(state.registry.get('slot-1')?.slot.expiresAt).toBe(state.clock.now() + 60_000);
  expect(state.registry.get('slot-1')?.slot.checks).toHaveLength(2);
});

test('starts the slot expiration after consumer readiness', async () => {
  const state = setup({ initialTime: 1_000, advanceOnEnsure: 4_000 });
  await state.service.register({ topic: 'topic', checks: checks(), autoDeleteSeconds: 5 });

  expect(state.registry.get('slot-1')?.slot.expiresAt).toBe(5_000 + 5_000);
});

test('does not create a slot when consumer readiness fails', async () => {
  const state = setup({ ensureError: new Error('broker unavailable') });
  await expect(state.service.register({ topic: 'topic', checks: checks() })).resolves.toEqual({
    kind: 'kafka-unavailable',
  });

  expect(state.idCalls()).toBe(0);
  expect(state.registry.get('slot-1')).toBeUndefined();
  expect(state.registry.size()).toBe(0);
  expect(state.calls).toEqual(['reserve', 'ensureReady', 'release']);
});

test('rejects an invalid JSONPath before reserving a consumer', async () => {
  const state = setup();
  await expect(
    state.service.register({
      topic: 'topic',
      checks: [{ values: [{ jsonPath: '$..x', value: 'bad' }] }],
    }),
  ).resolves.toEqual({ kind: 'invalid-request' });

  expect(state.calls).toEqual([]);
});

test.each([0, -1, 1.5, Number.NaN])(
  'rejects invalid expiration %s before reserving',
  async (seconds) => {
    const state = setup();
    await expect(
      state.service.register({ topic: 'topic', checks: checks(), autoDeleteSeconds: seconds }),
    ).resolves.toEqual({ kind: 'invalid-request' });
    expect(state.calls).toEqual([]);
  },
);

test('performs preparation, reservation, registration, extension, and release in order', async () => {
  const state = setup();
  const orderedChecks: readonly SlotCheckInput[] = [
    {
      get values() {
        state.calls.push('prepareCheck');
        return [{ jsonPath: '$.x', value: 'ok' }];
      },
    },
  ];

  await state.service.register({ topic: 'topic', checks: orderedChecks });

  expect(state.calls).toEqual([
    'prepareCheck',
    'reserve',
    'ensureReady',
    'register',
    'extend',
    'release',
  ]);
});

test('registers while the previous consumer is closing', async () => {
  const state = setup({ barrier: true });
  const registration = state.service.register({ topic: 'topic', checks: checks() });
  await Promise.resolve();
  expect(state.registry.size()).toBe(0);

  state.resolveEnsure();
  await expect(registration).resolves.toMatchObject({ kind: 'registered', checkCount: 1 });
  expect(state.calls).toContain('release');
  expect(state.consumers.getState('topic')).toBe('ready');
});

test('does not leave a reservation or slot after a duplicate identifier', async () => {
  const state = setup({ ids: ['same-id', 'same-id'] });
  await expect(state.service.register({ topic: 'topic', checks: checks() })).resolves.toMatchObject(
    {
      kind: 'registered',
    },
  );
  state.calls.length = 0;

  await expect(state.service.register({ topic: 'topic', checks: checks() })).resolves.toEqual({
    kind: 'invalid-request',
  });
  expect(state.registry.size()).toBe(1);
  expect(state.registry.get('same-id')).toBeDefined();
  expect(state.calls).toEqual(['reserve', 'ensureReady', 'register', 'release']);
});
