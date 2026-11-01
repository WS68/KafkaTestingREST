import { expect, test } from 'vitest';
import type { CompiledCheck } from '../../src/domain/check.js';
import {
  createSlotRegistry,
  type PreparedSlot,
  type RegisteredSlot,
} from '../../src/domain/slots/slot-registry.js';

function check(): CompiledCheck {
  return { headers: [], values: [] };
}

function prepared(
  id: string,
  topic: string,
  checks: readonly CompiledCheck[] = [check()],
): PreparedSlot {
  return { id, topic, checks, expiresAt: 1_000 };
}

function registered(
  registry: ReturnType<typeof createSlotRegistry>,
  value: PreparedSlot,
): RegisteredSlot {
  const result = registry.register(value);
  if (result.kind !== 'ok') throw new Error(`Unexpected duplicate id: ${value.id}`);
  return result.slot;
}

test('registers a slot with one accumulator per check and indexes it', () => {
  const registry = createSlotRegistry();
  const checks = [check(), check()];
  const slot = registered(registry, prepared('one', 'topic-a', checks));

  expect(slot.accumulators).toHaveLength(checks.length);
  expect(slot.slot.checks).toBe(checks);
  expect(registry.get('one')).toBe(slot);
  expect(registry.listByTopic('topic-a')).toEqual([slot]);
  expect(registry.listByTopic('unknown')).toEqual([]);
  expect(registry.listAll()).toEqual([slot]);
  expect(registry.size()).toBe(1);
});

test('removes a slot from both indexes without changing an earlier snapshot', () => {
  const registry = createSlotRegistry();
  const first = registered(registry, prepared('first', 'topic'));
  const second = registered(registry, prepared('second', 'topic'));
  registered(registry, prepared('other', 'other-topic'));
  expect(registry.isDeleted('first')).toBe(false);

  const before = registry.listByTopic('topic');
  const removed = registry.remove('first');
  expect(removed).toBe(first);
  expect(before).toHaveLength(2);
  expect(registry.get('first')).toBeUndefined();
  expect(registry.listByTopic('topic')).toEqual([second]);
  expect(registry.listAll()).not.toContain(first);
  expect(registry.size()).toBe(2);
  expect(registry.isDeleted('first')).toBe(true);
  expect(first.slot.deleted).toBe(false);

  const afterFirstRemove = registry.listAll();
  expect(registry.remove('first')).toBeUndefined();
  expect(registry.listAll()).toEqual(afterFirstRemove);
  expect(registry.size()).toBe(2);
});

test('re-registers a removed id and keeps a topic index usable after its last slot is removed', () => {
  const registry = createSlotRegistry();
  registered(registry, prepared('slot', 'topic'));
  expect(registry.remove('slot')).toBeDefined();
  expect(registry.listByTopic('topic')).toEqual([]);
  expect(registry.isDeleted('slot')).toBe(true);

  const replacement = registered(registry, prepared('slot', 'topic'));
  expect(registry.isDeleted('slot')).toBe(false);
  expect(registry.get('slot')).toBe(replacement);
  expect(registry.listByTopic('topic')).toEqual([replacement]);
});

test('rejects duplicate ids without replacing the first slot or changing indexes', () => {
  const registry = createSlotRegistry();
  const first = registered(registry, prepared('duplicate', 'first-topic'));
  const beforeAll = registry.listAll();
  const beforeFirstTopic = registry.listByTopic('first-topic');

  const result = registry.register(prepared('duplicate', 'second-topic', [check(), check()]));
  expect(result).toEqual({ kind: 'duplicate-id' });
  expect(registry.size()).toBe(1);
  expect(registry.get('duplicate')).toBe(first);
  expect(registry.listAll()).toEqual(beforeAll);
  expect(registry.listByTopic('first-topic')).toEqual(beforeFirstTopic);
  expect(registry.listByTopic('second-topic')).toEqual([]);
});
