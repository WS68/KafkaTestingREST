import { expect, test } from 'vitest';
import type {
  KafkaConsumerFactory,
  KafkaGroupAdmin,
  KafkaPublisher,
  PublicationRecordBytes,
} from '../../src/application/ports/index.js';
import type { RecordDto } from '../../src/http/dto/publication.js';

const bytes = (value: number): Uint8Array => new Uint8Array([value]);
const source: PublicationRecordBytes = {
  key: bytes(1),
  value: bytes(2),
  headers: [
    { name: bytes(3), value: bytes(4) },
    { name: bytes(3), value: bytes(5) },
  ],
};
// @ts-expect-error HTTP publication DTO is not prepared binary data.
const invalidRecord: PublicationRecordBytes = {} as RecordDto;
void invalidRecord;

test('in-memory Kafka ports preserve bytes and behavior without a network', async () => {
  const sent: PublicationRecordBytes[] = [];
  const publisher: KafkaPublisher = {
    publish: async (_topic, record, mode) => {
      sent.push(record);
      return mode === 'broker' ? { kind: 'confirmed' } : { kind: 'accepted-without-confirmation' };
    },
    close: async () => undefined,
  };
  expect(await publisher.publish('t', source, 'broker')).toEqual({ kind: 'confirmed' });
  expect(await publisher.publish('t', source, 'none')).toEqual({
    kind: 'accepted-without-confirmation',
  });
  // @ts-expect-error Kafka numeric ack options are outside this port's contract.
  void publisher.publish('t', source, 1);
  expect(sent[0]?.value).toBe(source.value);
  expect(sent[0]?.headers).toEqual(source.headers);

  let handled: Uint8Array | undefined;
  let closes = 0;
  const factory: KafkaConsumerFactory = {
    create: async (_topic, _group, onRecord) => {
      await onRecord({ key: source.key, value: source.value, headers: source.headers });
      let closed = false;
      return {
        close: async () => {
          if (!closed) {
            closed = true;
            closes += 1;
          }
        },
      };
    },
  };
  const ready = await factory.create('t', 'g', async (record) => {
    handled = record.value;
  });
  await ready.close();
  await ready.close();
  expect(closes).toBe(1);
  expect(handled).toBe(source.value);

  let deleted = true;
  const admin: KafkaGroupAdmin = {
    deleteGroup: async () => (deleted ? { kind: 'deleted' } : { kind: 'failed', reason: 'broker' }),
  };
  expect(await admin.deleteGroup('g')).toEqual({ kind: 'deleted' });
  deleted = false;
  expect(await admin.deleteGroup('g')).toEqual({ kind: 'failed', reason: 'broker' });
});
