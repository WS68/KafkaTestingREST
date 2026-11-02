import { expect, test } from 'vitest';
import type {
  CompiledCheck,
  ConsumerGeneration,
  Slot,
  SourceRecord,
  WaitHandle,
} from '../../src/domain/index.js';

const firstName = new Uint8Array([1]);
const secondName = new Uint8Array([2]);
const source: SourceRecord = {
  headers: [
    { name: secondName, value: undefined },
    { name: firstName, value: new Uint8Array([3]) },
    { name: secondName, value: new Uint8Array([4]) },
  ],
  key: undefined,
  value: new Uint8Array(),
};

const check: CompiledCheck = {
  headers: [{ name: 'correlationId', value: 'corr-123', operation: 'EQUALS', ignoreCase: false }],
  values: [
    {
      jsonPath: [{ kind: 'root' }, { kind: 'property', name: 'status' }],
      value: 'COMPLETED',
      operation: 'EQUALS',
      ignoreCase: false,
    },
  ],
};

const slot: Slot = {
  id: 'slot-1',
  topic: 'orders.results',
  checks: [check],
  expiresAt: 1_800_000_000_000,
  deleted: false,
};

const wait: WaitHandle = {
  id: 'wait-1',
  request: { slotId: slot.id, checkIndex: 0, requiredCount: 1, timeoutMs: 1_000 },
  outcome: undefined,
  cancelTimeout: undefined,
};

const generation: ConsumerGeneration = {
  generation: 1,
  state: 'ready',
  expiresAt: slot.expiresAt,
};

// @ts-expect-error Kafka absence is represented by undefined, not null.
const invalidSource: SourceRecord = { headers: [], key: undefined, value: null };
// @ts-expect-error Lifecycle states are explicit machine values, not arbitrary strings.
const invalidState: ConsumerGeneration = { ...generation, state: 'running' };

void source;
void check;
void wait;
void invalidSource;
void invalidState;

test('domain types preserve source header order and duplicate names', () => {
  expect(source.headers).toHaveLength(3);
  expect(source.headers[0]?.name).toBe(secondName);
  expect(source.headers[1]?.name).toBe(firstName);
  expect(source.headers[2]?.name).toBe(secondName);
  expect(slot.checks).toHaveLength(1);
  expect(wait.outcome).toBeUndefined();
  expect(generation.state).toBe('ready');
});
