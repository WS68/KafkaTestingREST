import { expect, test } from 'vitest';
import type {
  LogFields,
  Logger,
  PublicationRecordBytes,
} from '../../src/application/ports/index.js';
import { createNativeProducer } from '../../src/infrastructure/kafka/kafka-producer-lifecycle.js';
import { createNativeKafkaPublisher } from '../../src/infrastructure/kafka/native-publisher.js';
import { createFakeProducer } from '../support/fake-producer.js';

type Event = { readonly event: string; readonly fields: LogFields | undefined };

function loggerSpy(): { readonly logger: Logger; readonly events: Event[] } {
  const events: Event[] = [];
  const record = (_level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: LogFields) =>
    events.push({ event, fields });
  return {
    events,
    logger: {
      log: record,
      debug: (event, fields) => record('debug', event, fields),
      info: (event, fields) => record('info', event, fields),
      warn: (event, fields) => record('warn', event, fields),
      error: (event, fields) => record('error', event, fields),
    },
  };
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const record = (
  value: Uint8Array,
  key: Uint8Array | undefined = undefined,
): PublicationRecordBytes => ({
  key,
  value,
  headers: [],
});
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};
function publisherFor(fake: ReturnType<typeof createFakeProducer>, logger: Logger) {
  return createNativeKafkaPublisher({
    producer: createNativeProducer({
      cluster: { host: 'localhost', port: 9092 },
      createProducer: () => fake,
    }),
    logger,
  });
}

test('passes source bytes, empty or absent key, duplicate headers, and no base64 text', async () => {
  const fake = createFakeProducer();
  const { logger } = loggerSpy();
  const publisher = publisherFor(fake, logger);
  const value = bytes(0, 255, 1);
  await publisher.publish(
    'topic',
    {
      key: undefined,
      value,
      headers: [
        { name: bytes(100, 117, 112), value: bytes(1) },
        { name: bytes(100, 117, 112), value: bytes(2) },
      ],
    },
    'broker',
  );
  const sent = fake.sendArguments[0];
  expect(sent?.messages[0]).toMatchObject({ value: Buffer.from(value) });
  expect(sent?.messages[0]).not.toHaveProperty('key');
  expect(sent?.messages[0]?.headers).toEqual({ dup: [Buffer.from([1]), Buffer.from([2])] });
  expect(Buffer.from(value)).not.toEqual(new TextEncoder().encode('Zm9vYmFy'));
  await publisher.publish('topic', record(bytes(3), bytes()), 'broker');
  expect(fake.sendArguments[1]?.messages[0]?.key).toEqual(Buffer.alloc(0));
});

test('uses broker acknowledgements and maps client and broker failures', async () => {
  const client = createFakeProducer();
  client.setNextSend({ kind: 'reject', error: { code: 'ERR_INVALID_ARG_TYPE' } });
  const clientPublisher = publisherFor(client, loggerSpy().logger);
  expect(await clientPublisher.publish('t', record(bytes(1)), 'broker')).toEqual({
    kind: 'failed',
    reason: 'client',
  });
  expect(client.sendArguments[0]?.acks).toBe(-1);
  expect(client.sendCalls).toBe(1);

  const broker = createFakeProducer();
  broker.setNextSend({ kind: 'reject', error: { code: 'ECONNREFUSED' } });
  const brokerPublisher = publisherFor(broker, loggerSpy().logger);
  expect(await brokerPublisher.publish('t', record(bytes(1)), 'broker')).toEqual({
    kind: 'failed',
    reason: 'broker',
  });
});

test('accepts none mode only after send resolves and maps an early refusal', async () => {
  const fake = createFakeProducer();
  const publisher = publisherFor(fake, loggerSpy().logger);
  expect(await publisher.publish('t', record(bytes(1)), 'none')).toEqual({
    kind: 'accepted-without-confirmation',
  });
  expect(fake.sendArguments[0]?.acks).toBe(0);
  fake.setNextSend({ kind: 'reject', error: { code: 'ECONNREFUSED' } });
  expect(await publisher.publish('t', record(bytes(1)), 'none')).toEqual({
    kind: 'failed',
    reason: 'broker',
  });
});

test('logs a late none-mode failure without changing the accepted result or retrying', async () => {
  const fake = createFakeProducer();
  const spy = loggerSpy();
  const publisher = publisherFor(fake, spy.logger);
  const result = await publisher.publish('late-topic', record(bytes(1)), 'none');
  expect(() => fake.emitLateFailure(new Error('connection reset'))).not.toThrow();
  expect(result).toEqual({ kind: 'accepted-without-confirmation' });
  expect(fake.sendCalls).toBe(1);
  expect(spy.events).toContainEqual({
    event: 'kafka-publish-late-failure',
    fields: { topic: 'late-topic', reason: 'kafka-unavailable' },
  });
});

test('turns a late failure before acceptance into a broker failure', async () => {
  const fake = createFakeProducer();
  fake.setNextSend({ kind: 'deferred' });
  const publisher = publisherFor(fake, loggerSpy().logger);
  const pending = publisher.publish('t', record(bytes(1)), 'none');
  await settle();
  fake.emitLateFailure(new Error('connection reset'));
  expect(await pending).toEqual({ kind: 'failed', reason: 'broker' });
  expect(fake.sendCalls).toBe(1);
  fake.resolvePendingSend();
});

test('does not subscribe to late failures in broker mode', async () => {
  const fake = createFakeProducer();
  const spy = loggerSpy();
  const publisher = publisherFor(fake, spy.logger);
  await publisher.publish('t', record(bytes(1)), 'broker');
  expect(fake.lateFailureListenerCount).toBe(0);
  fake.emitLateFailure(new Error('ignored'));
  expect(spy.events).not.toContainEqual(
    expect.objectContaining({ event: 'kafka-publish-late-failure' }),
  );
});

test('connects once, reports connection failure, and closes idempotently', async () => {
  const fake = createFakeProducer();
  const publisher = publisherFor(fake, loggerSpy().logger);
  await publisher.publish('t', record(bytes(1)), 'broker');
  await publisher.publish('t', record(bytes(2)), 'broker');
  expect(fake.connectCalls).toBe(1);
  await publisher.close();
  await publisher.close();
  expect(fake.disconnectCalls).toBe(1);
  expect(await publisher.publish('t', record(bytes(3)), 'broker')).toEqual({
    kind: 'failed',
    reason: 'client',
  });

  const failed = createFakeProducer();
  failed.setConnectFailure({ code: 'ECONNREFUSED' });
  const failedPublisher = publisherFor(failed, loggerSpy().logger);
  expect(await failedPublisher.publish('t', record(bytes(1)), 'broker')).toEqual({
    kind: 'failed',
    reason: 'broker',
  });
  expect(failed.sendCalls).toBe(0);
});

test('tracks in-flight sends and drains them', async () => {
  const fake = createFakeProducer();
  fake.setNextSend({ kind: 'deferred' });
  const publisher = publisherFor(fake, loggerSpy().logger);
  const pending = publisher.publish('t', record(bytes(1)), 'broker');
  await settle();
  expect(publisher.inFlightCount).toBe(1);
  expect(await publisher.drain(0)).toBe(false);
  fake.resolvePendingSend();
  expect(await pending).toEqual({ kind: 'confirmed' });
  expect(publisher.inFlightCount).toBe(0);
  expect(await publisher.drain(1000)).toBe(true);
});

test('rejects invalid UTF-8 header names before sending', async () => {
  const fake = createFakeProducer();
  const publisher = publisherFor(fake, loggerSpy().logger);
  expect(
    await publisher.publish(
      't',
      {
        key: undefined,
        value: bytes(1),
        headers: [{ name: bytes(0xff), value: bytes(2) }],
      },
      'broker',
    ),
  ).toEqual({ kind: 'failed', reason: 'client' });
  expect(fake.sendCalls).toBe(0);
});
