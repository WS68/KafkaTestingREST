import { request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, beforeAll, expect, test } from 'vitest';
import type { Logger } from '../../src/application/ports/logger.js';
import type { PublishingService } from '../../src/application/publishing/publishing-service.js';
import type { CountResult } from '../../src/application/results/slot.js';
import type { WaitResult } from '../../src/application/results/waiting.js';
import type { SlotDeletionService } from '../../src/application/slots/slot-deletion.js';
import {
  createSlotQueryService,
  type SlotQueryService,
  type SlotWaitHandle,
} from '../../src/application/slots/slot-queries.js';
import type { WaitRegistry } from '../../src/application/waiting/wait-registry.js';
import { createWaitRegistry } from '../../src/application/waiting/wait-registry.js';
import type { WaitOutcome } from '../../src/domain/wait.js';
import { createSlotRegistry } from '../../src/domain/slots/slot-registry.js';
import { createApp } from '../../src/http/create-app.js';
import { ManualClock } from '../support/manual-clock.js';

const logger: Logger = {
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const apps: ReturnType<typeof createApp>[] = [];
const waitUrl = '/api/v1/slots/x/checks/0/wait';

// Первое `ready()` в воркере вычисляет граф модулей Fastify, @fastify/swagger и
// @fastify/swagger-ui и регистрирует плагины. На холодном кеше и при конкуренции
// за ЦП эта разовая работа занимает больше бюджета отдельного теста (5000 мс), но
// укладывается в бюджет хука (10000 мс). Прогреваем граф хуком, чтобы цена первого
// `ready()` не попадала в первый тест файла.
beforeAll(async () => {
  const warmup = createApp({
    publishing: { publish: async () => ({ kind: 'published', ack: 'broker' }) },
    logger,
  });
  await warmup.ready();
  await warmup.close();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function handle(result: WaitResult | Promise<WaitResult>, waitId = 'wait-1'): SlotWaitHandle {
  return { waitId, result: Promise.resolve(result) };
}

function createTestApp(
  waitHandle: SlotWaitHandle,
  countResult: CountResult = { kind: 'counted', count: 0 },
) {
  const calls: Parameters<SlotQueryService['waitWithHandle']>[2][] = [];
  const deletionCalls: string[] = [];
  const queries: SlotQueryService = {
    count: async () => countResult,
    read: async () => ({ kind: 'records', records: [] }),
    wait: async () => waitHandle.result,
    waitWithHandle: (_slotId, _checkIndex, request) => {
      calls.push(request);
      return waitHandle;
    },
  };
  const publishing: PublishingService = {
    publish: async () => ({ kind: 'published', ack: 'broker' }),
  };
  const deletion: SlotDeletionService = {
    delete: async (slotId) => {
      deletionCalls.push(slotId);
      return { kind: 'deleted' };
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
  return { app, calls, deletionCalls };
}

async function inject(app: ReturnType<typeof createApp>, url: string) {
  await app.ready();
  return app.inject({ method: 'POST', url });
}

function expectError(response: { json(): unknown }, code: string): void {
  expect(response.json()).toMatchObject({ code });
}

test('returns 200 and an empty object for an immediate condition', async () => {
  const { app } = createTestApp(handle({ kind: 'condition-met' }));
  const response = await inject(app, waitUrl);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({});
  expect(response.body).toBe('{}');
});

test('keeps an injected request pending until the deferred result is resolved', async () => {
  const result = deferred<WaitResult>();
  const { app } = createTestApp(handle(result.promise));
  let completed = false;
  const responsePromise = inject(app, waitUrl).then((response) => {
    completed = true;
    return response;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).toBe(false);
  result.resolve({ kind: 'condition-met' });
  const response = await responsePromise;
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({});
});

test.each([
  { result: { kind: 'timeout' } as const, status: 504, code: undefined },
  { result: { kind: 'slot-deleted' } as const, status: 409, code: 'SLOT_DELETED' },
  { result: { kind: 'slot-not-found' } as const, status: 404, code: 'SLOT_NOT_FOUND' },
  { result: { kind: 'check-not-found' } as const, status: 404, code: 'CHECK_NOT_FOUND' },
  { result: { kind: 'service-stopping' } as const, status: 503, code: 'SERVICE_STOPPING' },
])('maps $result.kind to its HTTP response', async ({ result, status, code }) => {
  const { app } = createTestApp(handle(result));
  const response = await inject(app, waitUrl);
  expect(response.statusCode).toBe(status);
  if (code === undefined) expect(response.json()).toEqual({});
  else expectError(response, code);
});

test.each(['index=-1', 'index=abc', 'index=1.5', 'n=0', 'timeoutMs=0', 'n=abc'])(
  'rejects %s without calling the wait service',
  async (parameter) => {
    const { app, calls } = createTestApp(handle({ kind: 'condition-met' }));
    const url = parameter.startsWith('index=')
      ? `/api/v1/slots/x/checks/${parameter.slice('index='.length)}/wait`
      : `${waitUrl}?${parameter}`;
    const response = await inject(app, url);
    expect(response.statusCode).toBe(400);
    expectError(response, 'INVALID_REQUEST');
    expect(calls).toHaveLength(0);
  },
);

test('validates the index before n', async () => {
  const { app, calls } = createTestApp(handle({ kind: 'condition-met' }));
  const response = await inject(app, '/api/v1/slots/x/checks/-1/wait?n=0');
  expect(response.statusCode).toBe(400);
  expectError(response, 'INVALID_REQUEST');
  expect(calls).toHaveLength(0);
});

test('passes default n and timeoutMs to the wait service', async () => {
  const { app, calls } = createTestApp(handle({ kind: 'condition-met' }));
  const response = await inject(app, waitUrl);
  expect(response.statusCode).toBe(200);
  expect(calls).toEqual([{ n: 1, timeoutMs: 25 }]);
});

function createCancellationWaits(
  onCancel: (waitId: string) => void,
  onSettlement: () => void,
): WaitRegistry {
  return {
    registerWithHandle: () => ({
      waitId: 'unused',
      result: Promise.resolve<WaitOutcome>('timeout'),
    }),
    register: async () => 'timeout',
    notifyAccumulated: () => undefined,
    settleSlot: onSettlement,
    settleAll: onSettlement,
    cancel: (waitId) => {
      onCancel(waitId);
      return true;
    },
    pendingCount: () => 0,
    pending: () => [],
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function requestJson(
  port: number,
  method: 'GET' | 'POST',
  path: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, method, path }, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('cancels the disconnected wait once and serves another connection', async () => {
  const result = deferred<WaitResult>();
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const cancelIds: string[] = [];
  const settlementCalls: string[] = [];
  const waits = createCancellationWaits(
    (waitId) => {
      cancelIds.push(waitId);
      result.resolve({ kind: 'condition-met' });
      cancelled.resolve();
    },
    () => settlementCalls.push('settled'),
  );
  const deletionCalls: string[] = [];
  const queries: SlotQueryService = {
    count: async () => ({ kind: 'counted', count: 3 }),
    read: async () => ({ kind: 'records', records: [] }),
    wait: async () => result.promise,
    waitWithHandle: () => {
      started.resolve();
      return handle(result.promise, 'wait-real');
    },
  };
  const errors: string[] = [];
  const testLogger: Logger = {
    ...logger,
    error: (event) => errors.push(event),
  };
  const app = createApp({
    publishing: { publish: async () => ({ kind: 'published', ack: 'broker' }) },
    queries,
    waits,
    defaults: { waitTimeoutMs: 25 },
    deletion: {
      delete: async (slotId) => {
        deletionCalls.push(slotId);
        return { kind: 'deleted' };
      },
    },
    logger: testLogger,
  });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');

  let client: ClientRequest | undefined;
  let destroyed = false;
  const disconnected = new Promise<void>((resolve, reject) => {
    client = httpRequest(
      { hostname: '127.0.0.1', port: address.port, method: 'POST', path: waitUrl },
      (response) => {
        response.resume();
        reject(new Error('The disconnected request received a response'));
      },
    );
    client.on('error', (error: Error) => {
      if (destroyed) resolve();
      else reject(error);
    });
    client.end();
  });

  try {
    await withTimeout(started.promise, 1000);
    await expect(
      requestJson(address.port, 'GET', '/api/v1/slots/x/checks/0/count'),
    ).resolves.toEqual({
      status: 200,
      body: '{"count":3}',
    });
    if (client === undefined) throw new Error('Expected a client request');
    destroyed = true;
    client.destroy();
    await withTimeout(cancelled.promise, 1000);
    expect(cancelIds).toEqual(['wait-real']);
    expect(settlementCalls).toHaveLength(0);
    expect(deletionCalls).toHaveLength(0);
    expect(errors).not.toContain('FST_ERR_REP_ALREADY_SENT');
    await withTimeout(disconnected, 1000);
  } finally {
    destroyed = true;
    client?.destroy();
    result.resolve({ kind: 'condition-met' });
  }
});

test('continues accumulating records after a timeout', async () => {
  const clock = new ManualClock();
  const registry = createSlotRegistry();
  expect(
    registry.register({
      id: 'slot',
      topic: 'topic',
      checks: [{ headers: [], values: [] }],
      expiresAt: 10_000,
    }).kind,
  ).toBe('ok');
  const waits = createWaitRegistry({
    ids: { newSlotId: () => 'slot', newWaitId: () => 'wait', newRunId: () => 'run' },
    clock,
  });
  const queries = createSlotQueryService({ registry, waits });
  const waiting = queries.wait('slot', 0, { n: 1, timeoutMs: 10 });
  clock.advance(10);
  await expect(waiting).resolves.toEqual({ kind: 'timeout' });
  expect(
    registry.appendToCheck('slot', 0, {
      headers: [],
      key: undefined,
      value: new TextEncoder().encode('{}'),
    }),
  ).toEqual({ kind: 'ok', count: 1 });
  await expect(queries.count('slot', 0)).resolves.toEqual({ kind: 'counted', count: 1 });
});
