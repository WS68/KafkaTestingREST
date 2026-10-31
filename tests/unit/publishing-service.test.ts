import { expect, test } from 'vitest';
import { createPublishingService } from '../../src/application/publishing/publishing-service.js';
import type {
  KafkaPublisher,
  PublicationRecordBytes,
  PublishAckMode,
  PublishAckResult,
} from '../../src/application/ports/kafka-publisher.js';
import type { RecordDto } from '../../src/application/publishing/publication-input.js';
import { createTopicMatcher } from '../../src/infrastructure/config/topic-matcher.js';

type PublishCall = {
  readonly topic: string;
  readonly record: PublicationRecordBytes;
  readonly ackMode: PublishAckMode;
};

function createFakePublisher(result: PublishAckResult): {
  readonly publisher: KafkaPublisher;
  readonly calls: PublishCall[];
} {
  const calls: PublishCall[] = [];
  return {
    calls,
    publisher: {
      async publish(topic, record, ackMode): Promise<PublishAckResult> {
        calls.push({ topic, record, ackMode });
        return result;
      },
      async close(): Promise<void> {
        return undefined;
      },
    },
  };
}

const validRecord: RecordDto = { value: { type: 'STRING', data: 'value' } };

function publishInput(
  topic: string,
  record: RecordDto = validRecord,
  ack: PublishAckMode = 'broker',
) {
  return { topic, record, ack };
}

test('publishes an allowed topic and maps a broker confirmation', async () => {
  const fake = createFakePublisher({ kind: 'confirmed' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => true,
  });

  await expect(service.publish(publishInput('orders.results'))).resolves.toEqual({
    kind: 'published',
    ack: 'broker',
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]).toMatchObject({ topic: 'orders.results', ackMode: 'broker' });
});

test('rejects a disallowed topic without calling Kafka', async () => {
  const fake = createFakePublisher({ kind: 'confirmed' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => false,
  });

  await expect(service.publish(publishInput('orders.results'))).resolves.toEqual({
    kind: 'topic-not-allowed',
  });
  expect(fake.calls).toHaveLength(0);
});

test('uses full matching for topic expressions without accepting partial matches', async () => {
  const fake = createFakePublisher({ kind: 'confirmed' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: createTopicMatcher([/^orders\./]),
  });

  await expect(service.publish(publishInput('orders.results'))).resolves.toEqual({
    kind: 'published',
    ack: 'broker',
  });
  await expect(service.publish(publishInput('xorders.results'))).resolves.toEqual({
    kind: 'topic-not-allowed',
  });
  await expect(service.publish(publishInput('ordersXresults'))).resolves.toEqual({
    kind: 'topic-not-allowed',
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]?.topic).toBe('orders.results');
});

test.each(['orders.results', 'payments.created', 'any-topic'])(
  'allows every topic when the matcher has no expressions: %s',
  async (topic) => {
    const fake = createFakePublisher({ kind: 'confirmed' });
    const service = createPublishingService({
      publisher: fake.publisher,
      isTopicAllowed: createTopicMatcher([]),
    });

    await expect(service.publish(publishInput(topic))).resolves.toEqual({
      kind: 'published',
      ack: 'broker',
    });
    expect(fake.calls).toHaveLength(1);
  },
);

test.each([
  {
    label: 'an unknown type',
    record: { value: { type: 'XML', data: 'value' } } as unknown as RecordDto,
    reason: 'invalid-record-type',
  },
  {
    label: 'invalid binary base64',
    record: { value: { type: 'BINARY', data: 'Zh==' } },
    reason: 'invalid-base64',
  },
  {
    label: 'a STRING object',
    record: { value: { type: 'STRING', data: { nested: true } } } as unknown as RecordDto,
    reason: 'invalid-record-type',
  },
] as const)('rejects $label before calling Kafka', async ({ record, reason }) => {
  const fake = createFakePublisher({ kind: 'confirmed' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => true,
  });

  await expect(service.publish(publishInput('orders.results', record))).resolves.toEqual({
    kind: 'invalid-record',
    reason,
  });
  expect(fake.calls).toHaveLength(0);
});

test('checks the topic before invalid record data', async () => {
  const fake = createFakePublisher({ kind: 'confirmed' });
  const invalidRecord = {
    value: { type: 'BINARY', data: 'Zh==' },
  } as const;
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => false,
  });

  await expect(service.publish(publishInput('orders.forbidden', invalidRecord))).resolves.toEqual({
    kind: 'topic-not-allowed',
  });
  expect(fake.calls).toHaveLength(0);
});

test('maps accepted-without-confirmation for the none acknowledgement mode', async () => {
  const fake = createFakePublisher({ kind: 'accepted-without-confirmation' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => true,
  });

  await expect(
    service.publish(publishInput('orders.results', validRecord, 'none')),
  ).resolves.toEqual({ kind: 'accepted', ack: 'none' });
  expect(fake.calls[0]?.ackMode).toBe('none');
});

test.each([
  { ack: 'broker' as const, stage: 'awaiting-confirmation' as const },
  { ack: 'none' as const, stage: 'before-acceptance' as const },
])('maps a failed transport result for ack=$ack', async ({ ack, stage }) => {
  const fake = createFakePublisher({ kind: 'failed', reason: 'broker' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => true,
  });

  await expect(service.publish(publishInput('orders.results', validRecord, ack))).resolves.toEqual({
    kind: 'kafka-unavailable',
    stage,
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]?.ackMode).toBe(ack);
});

test('passes decoded value bytes and preserves header order and duplicates', async () => {
  const fake = createFakePublisher({ kind: 'confirmed' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => true,
  });
  const record: RecordDto = {
    value: { type: 'BINARY', data: 'AAEC' },
    headers: [
      { name: 'tag', value: 'first' },
      { name: 'tag', value: 'second' },
      { name: 'other', value: 'third' },
    ],
  };

  await expect(service.publish(publishInput('orders.results', record))).resolves.toEqual({
    kind: 'published',
    ack: 'broker',
  });
  const call = fake.calls[0];
  expect(call).toBeDefined();
  expect(Array.from(call?.record.value ?? [])).toEqual([0, 1, 2]);
  expect(Array.from(call?.record.value ?? [])).not.toEqual(
    Array.from(new TextEncoder().encode('AAEC')),
  );
  expect(call?.record.headers.map((header) => Array.from(header.name))).toEqual([
    [116, 97, 103],
    [116, 97, 103],
    [111, 116, 104, 101, 114],
  ]);
  expect(call?.record.headers.map((header) => Array.from(header.value))).toEqual([
    [102, 105, 114, 115, 116],
    [115, 101, 99, 111, 110, 100],
    [116, 104, 105, 114, 100],
  ]);
});

test('does not retry after a failed publish', async () => {
  const fake = createFakePublisher({ kind: 'failed', reason: 'client' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => true,
  });

  await service.publish(publishInput('orders.results'));
  expect(fake.calls).toHaveLength(1);
});

test('is independent from slot and other registries', () => {
  const fake = createFakePublisher({ kind: 'confirmed' });
  const service = createPublishingService({
    publisher: fake.publisher,
    isTopicAllowed: () => true,
  });

  expect(service).toBeDefined();
});
