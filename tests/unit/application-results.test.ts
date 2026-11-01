import { expect, test } from 'vitest';
import type {
  CountResult,
  LatePublishFailure,
  PublishResult,
  ReadResult,
  SlotDeletionResult,
  SlotRegistrationResult,
  WaitResult,
} from '../../src/application/results/index.js';
import type { SourceRecord } from '../../src/domain/record.js';

const sourceRecord: SourceRecord = { headers: [], key: undefined, value: undefined };

const publishResults: readonly PublishResult[] = [
  { kind: 'published', ack: 'broker' },
  { kind: 'accepted', ack: 'none' },
  { kind: 'topic-not-allowed' },
  { kind: 'invalid-record', reason: 'invalid-record-type' },
  { kind: 'invalid-record', reason: 'invalid-base64' },
  { kind: 'kafka-unavailable', stage: 'before-acceptance' },
  { kind: 'kafka-unavailable', stage: 'awaiting-confirmation' },
];
const lateFailure: LatePublishFailure = { topic: 'orders', reason: 'kafka-unavailable' };
const slotResults: readonly SlotRegistrationResult[] = [
  { kind: 'registered', slotId: 'slot-1', checkCount: 2 },
  { kind: 'invalid-request' },
  { kind: 'kafka-unavailable' },
];
const deletionResults: readonly SlotDeletionResult[] = [{ kind: 'deleted' }, { kind: 'not-found' }];
const countResults: readonly CountResult[] = [
  { kind: 'counted', count: 2 },
  { kind: 'slot-not-found' },
  { kind: 'check-not-found' },
];
const readResults: readonly ReadResult[] = [
  { kind: 'records', records: [sourceRecord] },
  { kind: 'slot-not-found' },
  { kind: 'check-not-found' },
  { kind: 'invalid-pagination' },
  { kind: 'not-representable' },
];
const waitResults: readonly WaitResult[] = [
  { kind: 'condition-met' },
  { kind: 'timeout' },
  { kind: 'slot-deleted' },
  { kind: 'service-stopping' },
  { kind: 'slot-not-found' },
  { kind: 'check-not-found' },
  { kind: 'invalid-request' },
];

function describePublish(result: PublishResult): string {
  switch (result.kind) {
    case 'published':
      return result.ack;
    case 'accepted':
      return result.ack;
    case 'topic-not-allowed':
      return result.kind;
    case 'invalid-record':
      return result.reason;
    case 'kafka-unavailable':
      return result.stage;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function describeRead(result: ReadResult): string {
  switch (result.kind) {
    case 'records':
      return String(result.records.length);
    case 'slot-not-found':
    case 'check-not-found':
    case 'invalid-pagination':
    case 'not-representable':
      return result.kind;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function describeWait(result: WaitResult): string {
  switch (result.kind) {
    case 'condition-met':
    case 'timeout':
    case 'slot-deleted':
    case 'service-stopping':
    case 'slot-not-found':
    case 'check-not-found':
    case 'invalid-request':
      return result.kind;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

// @ts-expect-error HTTP status codes are outside the application result model.
const invalidHttpResult: PublishResult = { kind: 'published', ack: 'broker', statusCode: 201 };
// @ts-expect-error Result kinds are a closed discriminated union.
const invalidKind: ReadResult = { kind: 'unknown' };
// @ts-expect-error The published variant requires an acknowledgement mode.
const missingRequiredField: PublishResult = { kind: 'published' };
const fastifyLike = { listen: () => Promise.resolve() };
// @ts-expect-error Application results do not contain framework instances.
const invalidFrameworkResult: ReadResult = fastifyLike;

void invalidHttpResult;
void invalidKind;
void missingRequiredField;
void invalidFrameworkResult;

test('application results expose every agreed outcome', () => {
  expect(publishResults.map(describePublish)).toHaveLength(7);
  expect(lateFailure.reason).toBe('kafka-unavailable');
  expect(slotResults).toHaveLength(3);
  expect(deletionResults).toHaveLength(2);
  expect(countResults).toHaveLength(3);
  expect(readResults.map(describeRead)).toEqual([
    '1',
    'slot-not-found',
    'check-not-found',
    'invalid-pagination',
    'not-representable',
  ]);
  expect(waitResults.map(describeWait)).toHaveLength(7);
});
