import { afterEach, expect, test } from 'vitest';
import type { InjectOptions, InjectPayload } from 'light-my-request';
import type { Logger } from '../../src/application/ports/logger.js';
import type { PublishResult } from '../../src/application/results/publishing.js';
import type { SlotRegistrationResult } from '../../src/application/results/slot.js';
import type { PublishingService } from '../../src/application/publishing/publishing-service.js';
import type { SlotRegistrationService } from '../../src/application/slots/slot-registration.js';
import type { RecordDto } from '../../src/application/publishing/publication-input.js';
import { createApp, type AppDependencies } from '../../src/http/create-app.js';

// This contract test replaces application ports directly; it deliberately does not import KafkaJS or instantiate Kafka clients.
const logger: Logger = {
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function publishApp(result: PublishResult) {
  const calls: Parameters<PublishingService['publish']>[0][] = [];
  const publishing: PublishingService = {
    async publish(input) {
      calls.push(input);
      return result;
    },
  };
  const app = createApp({ publishing, logger });
  apps.push(app);
  return { app, calls };
}

function slotsApp(result: SlotRegistrationResult) {
  const calls: Parameters<SlotRegistrationService['register']>[0][] = [];
  const slots: SlotRegistrationService = {
    async register(input) {
      calls.push(input);
      return result;
    },
  };
  const publishing: PublishingService = {
    publish: async () => ({ kind: 'published', ack: 'broker' }),
  };
  const app = createApp({ publishing, slots, logger });
  apps.push(app);
  return { app, calls };
}

async function inject(app: ReturnType<typeof createApp>, options: string | InjectOptions) {
  await app.ready();
  return app.inject(options);
}

function publication(body: InjectPayload = { value: { type: 'STRING', data: 'ok' } }) {
  return { method: 'POST' as const, url: '/api/v1/topics/orders.results/records', payload: body };
}

function errorBody(response: { json(): unknown }, code: string) {
  expect(response.json()).toMatchObject({ code });
  expect(Object.keys(response.json() as Record<string, unknown>).sort()).toEqual([
    'code',
    'message',
  ]);
}

test.each([
  { result: { kind: 'published', ack: 'broker' } as const, status: 201 },
  { result: { kind: 'accepted', ack: 'none' } as const, status: 202 },
])(
  'maps publication $result.kind to $status with an empty JSON body',
  async ({ result, status }) => {
    const { app } = publishApp(result);
    const response = await inject(app, publication());
    expect(response.statusCode).toBe(status);
    expect(response.body).toBe('{}');
    expect(response.headers['content-type']).toContain('application/json');
  },
);

test('maps publication results to their exact error contracts', async () => {
  const cases: readonly { result: PublishResult; code: string; status: number }[] = [
    { result: { kind: 'topic-not-allowed' }, code: 'TOPIC_NOT_ALLOWED', status: 400 },
    {
      result: { kind: 'invalid-record', reason: 'invalid-record-type' },
      code: 'INVALID_RECORD_TYPE',
      status: 400,
    },
    {
      result: { kind: 'invalid-record', reason: 'invalid-base64' },
      code: 'INVALID_BASE64',
      status: 400,
    },
    {
      result: { kind: 'kafka-unavailable', stage: 'before-acceptance' },
      code: 'KAFKA_UNAVAILABLE',
      status: 503,
    },
  ];
  for (const entry of cases) {
    const { app } = publishApp(entry.result);
    const response = await inject(app, publication());
    expect(response.statusCode).toBe(entry.status);
    errorBody(response, entry.code);
  }
});

test.each([
  { label: 'missing value', body: {} },
  { label: 'unsupported record type', body: { value: { type: 'XML', data: 'x' } } },
  { label: 'extra property', body: { value: { type: 'STRING', data: 'x' }, extra: true } },
])('rejects publication schema error: $label without calling the service', async ({ body }) => {
  const { app, calls } = publishApp({ kind: 'published', ack: 'broker' });
  const response = await inject(app, publication(body));
  expect(response.statusCode).toBe(400);
  errorBody(response, 'INVALID_REQUEST');
  expect(calls).toHaveLength(0);
});

test('rejects malformed JSON without calling the publication service', async () => {
  const { app, calls } = publishApp({ kind: 'published', ack: 'broker' });
  const response = await inject(app, {
    method: 'POST',
    url: '/api/v1/topics/orders.results/records',
    headers: { 'content-type': 'application/json' },
    payload: '{',
  });
  expect(response.statusCode).toBe(400);
  errorBody(response, 'INVALID_REQUEST');
  expect(calls).toHaveLength(0);
});

test.each([
  { suffix: '', ack: 'broker' as const },
  { suffix: '?ack=0', ack: 'none' as const },
  { suffix: '?ack=1', ack: 'broker' as const },
])('passes ack=$ack for $suffix', async ({ suffix, ack }) => {
  const { app, calls } = publishApp({ kind: 'published', ack: 'broker' });
  const response = await inject(app, { ...publication(), url: `${publication().url}${suffix}` });
  expect(response.statusCode).toBe(201);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ topic: 'orders.results', ack });
});

test('rejects an unsupported ack without calling the publication service', async () => {
  const { app, calls } = publishApp({ kind: 'published', ack: 'broker' });
  const response = await inject(app, { ...publication(), url: `${publication().url}?ack=2` });
  expect(response.statusCode).toBe(400);
  errorBody(response, 'INVALID_REQUEST');
  expect(calls).toHaveLength(0);
});

test('returns only the registered slot id', async () => {
  const { app } = slotsApp({ kind: 'registered', slotId: 'slot-1', checkCount: 7 });
  const response = await inject(app, {
    method: 'POST',
    url: '/api/v1/slots',
    payload: { topic: 'orders.results', checks: [{}] },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toEqual({ id: 'slot-1' });
});

test.each([
  { result: { kind: 'invalid-request' } as const, status: 400, code: 'INVALID_REQUEST' },
  { result: { kind: 'kafka-unavailable' } as const, status: 503, code: 'KAFKA_UNAVAILABLE' },
])('maps slot result $result.kind to $status', async ({ result, status, code }) => {
  const { app } = slotsApp(result);
  const response = await inject(app, {
    method: 'POST',
    url: '/api/v1/slots',
    payload: { topic: 'orders.results', checks: [{}] },
  });
  expect(response.statusCode).toBe(status);
  errorBody(response, code);
});

test.each([
  { label: 'missing topic', body: { checks: [{}] } },
  { label: 'empty checks', body: { topic: 'orders.results', checks: [] } },
  {
    label: 'zero expiration',
    body: { topic: 'orders.results', checks: [{}], autoDeleteSeconds: 0 },
  },
  {
    label: 'non-string header value',
    body: {
      topic: 'orders.results',
      checks: [{ headers: [{ name: 'x', value: 1 }] }],
    },
  },
])('rejects registration schema error: $label without calling the service', async ({ body }) => {
  const { app, calls } = slotsApp({ kind: 'registered', slotId: 'slot-1', checkCount: 1 });
  const response = await inject(app, { method: 'POST', url: '/api/v1/slots', payload: body });
  expect(response.statusCode).toBe(400);
  errorBody(response, 'INVALID_REQUEST');
  expect(calls).toHaveLength(0);
});

test('passes registration fields and omits absent autoDeleteSeconds', async () => {
  const { app, calls } = slotsApp({ kind: 'registered', slotId: 'slot-1', checkCount: 1 });
  const body = {
    topic: 'orders.results',
    checks: [{ values: [{ jsonPath: '$.status', value: 'ready' }] }],
  };
  const response = await inject(app, { method: 'POST', url: '/api/v1/slots', payload: body });
  expect(response.statusCode).toBe(201);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject(body);
  expect(calls[0] && 'autoDeleteSeconds' in calls[0]).toBe(false);
});

test('passes autoDeleteSeconds when provided and permits an empty check', async () => {
  const { app, calls } = slotsApp({ kind: 'registered', slotId: 'slot-1', checkCount: 1 });
  const response = await inject(app, {
    method: 'POST',
    url: '/api/v1/slots',
    payload: { topic: 'orders.results', checks: [{}], autoDeleteSeconds: 120 },
  });
  expect(response.statusCode).toBe(201);
  expect(calls[0]).toEqual({ topic: 'orders.results', checks: [{}], autoDeleteSeconds: 120 });
});

// Compile-time architecture guard: controllers are wired to application services, not internal registries.
const invalidDependencies: AppDependencies = {
  publishing: {
    publish: async (_input: { topic: string; record: RecordDto; ack: 'broker' | 'none' }) => ({
      kind: 'published',
      ack: 'broker',
    }),
  },
  // @ts-expect-error AppDependencies intentionally excludes registry dependencies.
  registry: {},
};
void invalidDependencies;
