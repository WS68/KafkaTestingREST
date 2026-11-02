import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Logger } from '../../src/application/ports/logger.js';
import type { PublishResult } from '../../src/application/results/publishing.js';
import type { ReadResult } from '../../src/application/results/reading.js';
import type {
  CountResult,
  SlotDeletionResult,
  SlotRegistrationResult,
} from '../../src/application/results/slot.js';
import type { WaitResult } from '../../src/application/results/waiting.js';
import type { PublishingService } from '../../src/application/publishing/publishing-service.js';
import type { SlotQueryService, SlotWaitHandle } from '../../src/application/slots/slot-queries.js';
import type { SlotDeletionService } from '../../src/application/slots/slot-deletion.js';
import type { SlotRegistrationService } from '../../src/application/slots/slot-registration.js';
import { createApp } from '../../src/http/create-app.js';

type OpenApiSchema = {
  readonly type?: string;
  readonly description?: string;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly items?: OpenApiSchema;
  readonly default?: unknown;
};

type OpenApiResponse = {
  readonly content?: Readonly<Record<string, { readonly schema?: OpenApiSchema }>>;
};

type OpenApiParameter = {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required?: boolean;
  readonly description?: string;
  readonly schema?: OpenApiSchema;
};

type OpenApiOperation = {
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: Readonly<Record<string, { readonly schema?: OpenApiSchema }>>;
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
};

type OpenApiDocument = {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
};

const logger: Logger = {
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const publishing: PublishingService = {
  publish: async (): Promise<PublishResult> => ({ kind: 'published', ack: 'broker' }),
};

const slots: SlotRegistrationService = {
  register: async (): Promise<SlotRegistrationResult> => ({
    kind: 'registered',
    slotId: 'slot-1',
    checkCount: 1,
  }),
};

const queries: SlotQueryService = {
  count: async (): Promise<CountResult> => ({ kind: 'counted', count: 0 }),
  read: async (): Promise<ReadResult> => ({ kind: 'records', records: [] }),
  wait: async (): Promise<WaitResult> => ({ kind: 'condition-met' }),
  waitWithHandle: (): SlotWaitHandle => ({
    waitId: undefined,
    result: Promise.resolve({ kind: 'condition-met' }),
  }),
};

const deletion: SlotDeletionService = {
  delete: async (): Promise<SlotDeletionResult> => ({ kind: 'deleted' }),
};

const app = createApp({
  publishing,
  slots,
  queries,
  deletion,
  defaults: { waitTimeoutMs: 1_000 },
  logger,
});

let specification: OpenApiDocument;

beforeAll(async () => {
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api-docs' });
  expect(response.statusCode).toBe(200);
  specification = JSON.parse(response.body) as OpenApiDocument;
});

afterAll(async () => {
  await app.close();
});

const paths = {
  publish: '/api/v1/topics/{name}/records',
  register: '/api/v1/slots',
  wait: '/api/v1/slots/{id}/checks/{index}/wait',
  count: '/api/v1/slots/{id}/checks/{index}/count',
  read: '/api/v1/slots/{id}/checks/{index}',
  delete: '/api/v1/slots/{id}',
} as const;

function operation(path: string, method: 'get' | 'post' | 'delete'): OpenApiOperation {
  const pathItem = specification.paths[path];
  expect(pathItem).toBeDefined();
  if (pathItem === undefined) throw new Error(`Missing OpenAPI path: ${path}`);
  const result = pathItem[method];
  expect(result).toBeDefined();
  return result as OpenApiOperation;
}

function responseSchema(operationToCheck: OpenApiOperation, status: number): OpenApiSchema {
  const response = operationToCheck.responses[String(status)];
  expect(response).toBeDefined();
  const schema = response?.content?.['application/json']?.schema;
  expect(schema).toBeDefined();
  return schema as OpenApiSchema;
}

function expectStatuses(operationToCheck: OpenApiOperation, statuses: readonly number[]): void {
  expect(Object.keys(operationToCheck.responses).sort()).toEqual(statuses.map(String).sort());
}

function expectEmptyObjectSchema(schema: OpenApiSchema): void {
  expect(schema.type).toBe('object');
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties === undefined || Object.keys(schema.properties).length === 0).toBe(true);
}

function expectErrorSchema(schema: OpenApiSchema): void {
  expect(schema.type).toBe('object');
  expect(schema.required).toEqual(['code', 'message']);
}

function expectPathParameters(operationToCheck: OpenApiOperation, names: readonly string[]): void {
  const parameters = operationToCheck.parameters ?? [];
  for (const name of names) {
    const parameter = parameters.find(
      (candidate) => candidate.in === 'path' && candidate.name === name,
    );
    expect(parameter?.required).toBe(true);
  }
}

function expectQueryParameters(operationToCheck: OpenApiOperation, names: readonly string[]): void {
  const parameters = operationToCheck.parameters ?? [];
  for (const name of names) {
    const parameter = parameters.find(
      (candidate) => candidate.in === 'query' && candidate.name === name,
    );
    expect(parameter).toBeDefined();
    const description = parameter?.description ?? parameter?.schema?.description;
    expect(description).toContain('по умолчанию');
    expect(description).not.toContain('undefined');
  }
}

describe('OpenAPI contract', () => {
  test('publishes a valid document with exactly six application paths', () => {
    expect(specification.openapi.startsWith('3.0')).toBe(true);
    expect(specification.info.title).not.toBe('');
    expect(specification.info.version).not.toBe('');
    expect(Object.keys(specification.paths).sort()).toEqual(Object.values(paths).sort());
    expect(specification.paths['/api-docs']).toBeUndefined();
    expect(specification.paths['/api-docs/swagger-ui']).toBeUndefined();
  });

  test('declares methods, statuses, tags, summaries, and response schemas', () => {
    const publish = operation(paths.publish, 'post');
    const register = operation(paths.register, 'post');
    const wait = operation(paths.wait, 'post');
    const count = operation(paths.count, 'get');
    const read = operation(paths.read, 'get');
    const remove = operation(paths.delete, 'delete');

    expectStatuses(publish, [201, 202, 400, 503]);
    expectStatuses(register, [201, 400, 503]);
    expectStatuses(wait, [200, 400, 404, 409, 503, 504]);
    expectStatuses(count, [200, 404]);
    expectStatuses(read, [200, 400, 404, 500]);
    expectStatuses(remove, [200, 404]);

    for (const current of [publish, register, wait, count, read, remove]) {
      expect(current.tags?.length).toBeGreaterThan(0);
      expect(current.summary).not.toBe('');
    }

    for (const status of [201, 202]) expectEmptyObjectSchema(responseSchema(publish, status));
    expectEmptyObjectSchema(responseSchema(wait, 200));
    expectEmptyObjectSchema(responseSchema(wait, 504));
    expectEmptyObjectSchema(responseSchema(remove, 200));

    for (const current of [
      responseSchema(publish, 400),
      responseSchema(publish, 503),
      responseSchema(register, 400),
      responseSchema(register, 503),
      responseSchema(wait, 400),
      responseSchema(wait, 404),
      responseSchema(wait, 409),
      responseSchema(wait, 503),
      responseSchema(read, 400),
      responseSchema(read, 404),
      responseSchema(read, 500),
      responseSchema(remove, 404),
    ]) {
      expectErrorSchema(current);
    }

    const waitTimeout = responseSchema(wait, 504);
    expect(waitTimeout.type).toBe('object');
    expect(waitTimeout.additionalProperties).toBe(false);
    expect(waitTimeout.properties).toBeUndefined();

    const readSuccess = responseSchema(read, 200);
    expect(readSuccess.type).toBe('array');
    expect(readSuccess.items?.required).toEqual(['headers', 'value']);

    const countSuccess = responseSchema(count, 200);
    expect(countSuccess.required).toEqual(['count']);
    expect(countSuccess.properties?.['count']?.type).toBe('integer');

    expect(responseSchema(register, 201).required).toEqual(['id']);
  });

  test('describes request bodies and path/query parameters without OpenAPI defaults', () => {
    const publish = operation(paths.publish, 'post');
    const wait = operation(paths.wait, 'post');
    const read = operation(paths.read, 'get');
    const count = operation(paths.count, 'get');
    const remove = operation(paths.delete, 'delete');

    expect(publish.requestBody?.required).toBe(true);
    expect(publish.requestBody?.content?.['application/json']?.schema?.required).toEqual(['value']);

    expectPathParameters(publish, ['name']);
    expectPathParameters(wait, ['id', 'index']);
    expectPathParameters(count, ['id', 'index']);
    expectPathParameters(read, ['id', 'index']);
    expectPathParameters(remove, ['id']);

    expectQueryParameters(publish, ['ack']);
    expectQueryParameters(wait, ['n', 'timeoutMs']);
    expectQueryParameters(read, ['offset', 'count']);

    for (const current of [publish, wait, read]) {
      for (const parameter of current.parameters ?? []) {
        expect(parameter).not.toHaveProperty('default');
        expect(parameter.schema).not.toHaveProperty('default');
      }
    }
  });

  test('publishes registration condition fields with their exact OpenAPI constraints', () => {
    const register = operation(paths.register, 'post');
    const requestSchema = register.requestBody?.content?.['application/json']?.schema;
    expect(requestSchema).toBeDefined();

    const checksSchema = requestSchema?.properties?.['checks'];
    expect(checksSchema?.type).toBe('array');
    const checkSchema = checksSchema?.items;
    expect(checkSchema?.type).toBe('object');

    const headersSchema = checkSchema?.properties?.['headers'];
    const valuesSchema = checkSchema?.properties?.['values'];
    expect(headersSchema?.type).toBe('array');
    expect(valuesSchema?.type).toBe('array');

    const headersItem = headersSchema?.items;
    const valuesItem = valuesSchema?.items;
    expect(headersItem?.required).toEqual(['name', 'value']);
    expect(valuesItem?.required).toEqual(['jsonPath', 'value']);

    for (const item of [headersItem, valuesItem]) {
      const operationSchema = item?.properties?.['operation'];
      const ignoreCaseSchema = item?.properties?.['ignoreCase'];

      expect(operationSchema?.type).toBe('string');
      expect(operationSchema?.enum).toEqual(['EQUALS', 'CONTAINS']);
      expect(ignoreCaseSchema?.type).toBe('boolean');
      expect(item?.required ?? []).not.toContain('operation');
      expect(item?.required ?? []).not.toContain('ignoreCase');
      expect(operationSchema).not.toHaveProperty('default');
      expect(ignoreCaseSchema).not.toHaveProperty('default');
    }
  });

  test('serves the specification and Swagger UI from their public routes', async () => {
    const specificationResponse = await app.inject({ method: 'GET', url: '/api-docs' });
    expect(specificationResponse.statusCode).toBe(200);
    expect(specificationResponse.headers['content-type']).toContain('json');
    expect(JSON.parse(specificationResponse.body)).toMatchObject({ openapi: '3.0.3' });

    const swaggerResponse = await app.inject({ method: 'GET', url: '/api-docs/swagger-ui' });
    expect([200, 301, 302]).toContain(swaggerResponse.statusCode);
    expect(swaggerResponse.headers['content-type']).toContain('html');

    const initializerResponse = await app.inject({
      method: 'GET',
      url: '/api-docs/swagger-ui/static/swagger-initializer.js',
    });
    expect(initializerResponse.statusCode).toBe(200);
    expect(initializerResponse.body).toContain('"url":"/api-docs"');

    const internalJsonResponse = await app.inject({
      method: 'GET',
      url: '/api-docs/swagger-ui/json',
    });
    expect(internalJsonResponse.statusCode).toBe(404);

    const internalJsonWithQueryResponse = await app.inject({
      method: 'GET',
      url: '/api-docs/swagger-ui/json?format=full',
    });
    expect(internalJsonWithQueryResponse.statusCode).toBe(404);
  });

  test('documents the actual invalid registration response status', async () => {
    const response = await app.inject({
      method: 'POST',
      url: paths.register,
      payload: { topic: 'orders.results' },
    });

    expect(response.statusCode).toBe(400);
    expect(Object.keys(operation(paths.register, 'post').responses)).toContain('400');
  });
});
