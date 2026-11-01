import { afterAll, expect, test } from 'vitest';
import type { Logger } from '../../src/application/ports/logger.js';
import type { ReadResult } from '../../src/application/results/reading.js';
import type { CountResult } from '../../src/application/results/slot.js';
import type { WaitResult } from '../../src/application/results/waiting.js';
import type { PublishingService } from '../../src/application/publishing/publishing-service.js';
import type { SlotDeletionService } from '../../src/application/slots/slot-deletion.js';
import type { SlotQueryService } from '../../src/application/slots/slot-queries.js';
import { createApp } from '../../src/http/create-app.js';

const logger: Logger = {
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const apps: ReturnType<typeof createApp>[] = [];
afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createTestApp(
  options: {
    readonly countResult?: CountResult;
    readonly readResult?: ReadResult;
    readonly deleteResults?: readonly ('deleted' | 'not-found')[];
  } = {},
) {
  const countCalls: Parameters<SlotQueryService['count']>[] = [];
  const readCalls: Parameters<SlotQueryService['read']>[] = [];
  const deleteCalls: string[] = [];
  let deleteIndex = 0;
  const queries: SlotQueryService = {
    count: async (...args) => {
      countCalls.push(args);
      return options.countResult ?? { kind: 'counted', count: 0 };
    },
    read: async (...args) => {
      readCalls.push(args);
      return options.readResult ?? { kind: 'records', records: [] };
    },
    wait: async (): Promise<WaitResult> => ({ kind: 'condition-met' }),
    waitWithHandle: () => ({
      waitId: undefined,
      result: Promise.resolve({ kind: 'condition-met' }),
    }),
  };
  const publishing: PublishingService = {
    publish: async () => ({ kind: 'published', ack: 'broker' }),
  };
  const deletion: SlotDeletionService = {
    delete: async (slotId) => {
      deleteCalls.push(slotId);
      const result = options.deleteResults?.[deleteIndex] ?? 'deleted';
      deleteIndex += 1;
      return result === 'deleted' ? { kind: 'deleted' } : { kind: 'not-found' };
    },
  };
  const app = createApp({
    publishing,
    queries,
    defaults: { waitTimeoutMs: 25 },
    deletion,
    logger,
  });
  apps.push(app);
  return { app, countCalls, readCalls, deleteCalls };
}

async function inject(
  app: ReturnType<typeof createApp>,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
) {
  await app.ready();
  return app.inject({ method, url });
}

function expectError(response: { json(): unknown }, code: string): void {
  const body = response.json();
  expect(body).toMatchObject({ code });
  expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['code', 'message']);
  expect(typeof (body as { message: unknown }).message).toBe('string');
}

function expectJson(response: { readonly headers: { readonly 'content-type'?: unknown } }): void {
  expect(response.headers['content-type']).toContain('application/json');
}

test('returns the current count immediately with an exact response body', async () => {
  const { app, countCalls } = createTestApp({ countResult: { kind: 'counted', count: 2 } });
  let completed = false;
  const responsePromise = inject(app, 'GET', '/api/v1/slots/x/checks/0/count').then((response) => {
    completed = true;
    return response;
  });
  const response = await responsePromise;
  expect(completed).toBe(true);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ count: 2 });
  expectJson(response);
  expect(countCalls).toEqual([['x', 0]]);
});

test.each([
  { result: { kind: 'slot-not-found' } as const, code: 'SLOT_NOT_FOUND' },
  { result: { kind: 'check-not-found' } as const, code: 'CHECK_NOT_FOUND' },
])('maps count result $result.kind to its error response', async ({ result, code }) => {
  const { app } = createTestApp({ countResult: result });
  const response = await inject(app, 'GET', '/api/v1/slots/x/checks/0/count');
  expect(response.statusCode).toBe(404);
  expectJson(response);
  expectError(response, code);
});

test.each(['-1', 'abc', '1.5', '01'])(
  'rejects count index %s before calling the service',
  async (index) => {
    const { app, countCalls } = createTestApp();
    const response = await inject(app, 'GET', `/api/v1/slots/x/checks/${index}/count`);
    expect(response.statusCode).toBe(404);
    expectJson(response);
    expectError(response, 'CHECK_NOT_FOUND');
    expect(countCalls).toHaveLength(0);
  },
);

test('returns an empty record page as an empty array', async () => {
  const { app } = createTestApp({ readResult: { kind: 'records', records: [] } });
  const response = await inject(app, 'GET', '/api/v1/slots/x/checks/0');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([]);
  expect(Array.isArray(response.json())).toBe(true);
  expectJson(response);
});

test('represents record pages without exposing internal fields', async () => {
  const { app } = createTestApp({
    readResult: {
      kind: 'records',
      records: [
        {
          headers: [],
          key: Uint8Array.from([1, 2]),
          value: new TextEncoder().encode('{"ok":true}'),
        },
        {
          headers: [
            { name: new TextEncoder().encode('x-test'), value: new TextEncoder().encode('yes') },
          ],
          key: undefined,
          value: new TextEncoder().encode('42'),
        },
      ],
    },
  });
  const response = await inject(app, 'GET', '/api/v1/slots/x/checks/0');
  expect(response.statusCode).toBe(200);
  expectJson(response);
  const records = response.json() as Array<Record<string, unknown>>;
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(Array.isArray(record['headers'])).toBe(true);
    expect((record['value'] as { type: string }).type).toBe('JSON');
    expect(record).not.toHaveProperty('check');
    expect(record).not.toHaveProperty('count');
    expect(record).not.toHaveProperty('expiresAt');
  }
  expect(records[0]).toMatchObject({ key: { type: 'BINARY', data: 'AQI=' } });
  expect(records[1]).toMatchObject({
    headers: [{ name: 'x-test', value: 'yes' }],
    value: { data: 42 },
  });
  expect(records[1]).not.toHaveProperty('key');
});

test('returns a structured 500 error when a page contains an unrepresentable record', async () => {
  const { app } = createTestApp({
    readResult: {
      kind: 'records',
      records: [{ headers: [], key: undefined, value: undefined }],
    },
  });
  const response = await inject(app, 'GET', '/api/v1/slots/x/checks/0');
  expect(response.statusCode).toBe(500);
  expectJson(response);
  expect(Array.isArray(response.json())).toBe(false);
  expectError(response, 'RECORD_NOT_REPRESENTABLE');
});

test.each([
  { result: { kind: 'slot-not-found' } as const, code: 'SLOT_NOT_FOUND' },
  { result: { kind: 'check-not-found' } as const, code: 'CHECK_NOT_FOUND' },
])('maps read result $result.kind to its error response', async ({ result, code }) => {
  const { app } = createTestApp({ readResult: result });
  const response = await inject(app, 'GET', '/api/v1/slots/x/checks/0');
  expect(response.statusCode).toBe(404);
  expectJson(response);
  expectError(response, code);
});

test.each([
  { query: 'offset=-1', code: 'INVALID_REQUEST' },
  { query: 'count=0', code: 'INVALID_REQUEST' },
  { query: 'count=abc', code: 'INVALID_REQUEST' },
])(
  'rejects invalid read pagination $query without calling the service',
  async ({ query, code }) => {
    const { app, readCalls } = createTestApp();
    const response = await inject(app, 'GET', `/api/v1/slots/x/checks/0?${query}`);
    expect(response.statusCode).toBe(400);
    expectJson(response);
    expectError(response, code);
    expect(readCalls).toHaveLength(0);
  },
);

test('passes default pagination and validates the index before pagination', async () => {
  const { app, readCalls } = createTestApp();
  const response = await inject(app, 'GET', '/api/v1/slots/x/checks/0');
  expect(response.statusCode).toBe(200);
  expect(readCalls).toEqual([['x', 0, 0, 20]]);

  const invalid = await inject(app, 'GET', '/api/v1/slots/x/checks/abc?offset=-1');
  expect(invalid.statusCode).toBe(404);
  expectJson(invalid);
  expectError(invalid, 'CHECK_NOT_FOUND');
  expect(readCalls).toHaveLength(1);
});

test.each(['-1', 'abc', '1.5', '01'])('rejects read index %s as CHECK_NOT_FOUND', async (index) => {
  const { app, readCalls } = createTestApp();
  const response = await inject(app, 'GET', `/api/v1/slots/x/checks/${index}`);
  expect(response.statusCode).toBe(404);
  expectJson(response);
  expectError(response, 'CHECK_NOT_FOUND');
  expect(readCalls).toHaveLength(0);
});

test('deletes a slot with an empty response and maps missing slots', async () => {
  const { app, deleteCalls } = createTestApp();
  const response = await inject(app, 'DELETE', '/api/v1/slots/x');
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe('{}');
  expect(response.json()).toEqual({});
  expectJson(response);
  expect(deleteCalls).toEqual(['x']);

  const missing = createTestApp({ deleteResults: ['not-found'] });
  const missingResponse = await inject(missing.app, 'DELETE', '/api/v1/slots/x');
  expect(missingResponse.statusCode).toBe(404);
  expectJson(missingResponse);
  expectError(missingResponse, 'SLOT_NOT_FOUND');
});

test('maps repeated deletion from deleted to not-found', async () => {
  const { app, deleteCalls } = createTestApp({ deleteResults: ['deleted', 'not-found'] });
  const first = await inject(app, 'DELETE', '/api/v1/slots/x');
  const second = await inject(app, 'DELETE', '/api/v1/slots/x');
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({});
  expect(second.statusCode).toBe(404);
  expectJson(first);
  expectJson(second);
  expectError(second, 'SLOT_NOT_FOUND');
  expect(deleteCalls).toEqual(['x', 'x']);
});

test.each(['GET', 'POST'] as const)('does not support %s /api/v1/slots/:id', async (method) => {
  const { app, deleteCalls } = createTestApp();
  const response = await inject(app, method, '/api/v1/slots/x');
  expect(response.statusCode).toBe(404);
  expectJson(response);
  expect(response.json()).toEqual(
    expect.objectContaining({ message: expect.any(String), statusCode: 404 }),
  );
  expect(deleteCalls).toHaveLength(0);
});
