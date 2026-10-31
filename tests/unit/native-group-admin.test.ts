import { expect, test } from 'vitest';
import type { LogFields, Logger } from '../../src/application/ports/index.js';
import { createNativeGroupAdmin } from '../../src/infrastructure/kafka/native-group-admin.js';
import { createFakeAdminClient } from '../support/fake-consumer.js';

function loggerSpy(): {
  readonly logger: Logger;
  readonly events: { event: string; fields: LogFields | undefined }[];
} {
  const events: { event: string; fields: LogFields | undefined }[] = [];
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

function setup() {
  const client = createFakeAdminClient();
  const logger = loggerSpy();
  const admin = createNativeGroupAdmin({
    createAdminClient: () => client,
    logger: logger.logger,
  });
  return { client, logger, admin };
}

test('deletes exactly the requested group', async () => {
  const state = setup();
  expect(await state.admin.deleteGroup('g-1')).toEqual({ kind: 'deleted' });
  expect(state.client.deleteGroupsArguments).toEqual([{ groupIds: ['g-1'] }]);
  expect(state.client.deleteGroupsCalls).toBe(1);
});

test('maps network and argument failures, logs them, and does not retry', async () => {
  const broker = setup();
  broker.client.setDeleteGroupsFailure({ code: 'ECONNRESET' });
  expect(await broker.admin.deleteGroup('g-1')).toEqual({ kind: 'failed', reason: 'broker' });
  expect(broker.logger.events).toContainEqual({
    event: 'kafka-group-deletion-failed',
    fields: { groupId: 'g-1', reason: 'broker' },
  });
  expect(broker.client.deleteGroupsCalls).toBe(1);

  const client = setup();
  client.client.setDeleteGroupsFailure({ code: 'ERR_INVALID_ARG_TYPE' });
  expect(await client.admin.deleteGroup('g-1')).toEqual({ kind: 'failed', reason: 'client' });
  expect(client.logger.events).toContainEqual({
    event: 'kafka-group-deletion-failed',
    fields: { groupId: 'g-1', reason: 'client' },
  });
  expect(client.client.deleteGroupsCalls).toBe(1);
});

test('closes idempotently and suppresses disconnect failure', async () => {
  const state = setup();
  state.client.setDisconnectFailure(new Error('disconnect'));
  const first = state.admin.close();
  expect(state.admin.close()).toBe(first);
  await first;
  expect(state.client.disconnectCalls).toBe(1);
});
