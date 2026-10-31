import { expect, test } from 'vitest';
import type {
  EmptyResponseDto,
  ReadRecordDto,
  RecordDto,
  SlotRegistrationRequestDto,
} from '../../src/http/dto/index.js';

const publication: RecordDto = {
  headers: [
    { name: 'correlationId', value: 'corr-123' },
    { name: 'payload', type: 'JSON', value: { orderId: '42' } },
  ],
  key: { type: 'BINARY', data: 'b3JkZXItNDI=' },
  value: { type: 'JSON', data: { status: 'COMPLETED' } },
};

const read: ReadRecordDto = {
  headers: [{ name: 'correlationId', value: 'corr-123' }],
  key: { type: 'BINARY', data: 'b3JkZXItNDI=' },
  value: { type: 'JSON', data: { status: 'COMPLETED' } },
};

const registration: SlotRegistrationRequestDto = {
  topic: 'orders.results',
  checks: [
    {
      headers: [{ name: 'correlationId', value: 'corr-123' }],
      values: [{ jsonPath: '$.status', value: 'COMPLETED' }],
    },
  ],
};

const empty: EmptyResponseDto = {};

function acceptsPublication(_: RecordDto): void {}

// @ts-expect-error ReadRecordDto is a read representation, not a publication request.
acceptsPublication(read);

const invalidType: RecordDto = {
  value: {
    // @ts-expect-error XML is not a supported RecordDataType.
    type: 'XML',
    data: 'payload',
  },
};

const notEmpty: EmptyResponseDto = {
  // @ts-expect-error EmptyResponseDto must not contain response fields.
  count: 1,
};

void invalidType;
void notEmpty;

test('transport DTOs preserve publication and read model boundaries', () => {
  expect(publication.value.type).toBe('JSON');
  expect(read.value.type).toBe('JSON');
  expect(registration.checks).toHaveLength(1);
  expect(empty).toEqual({});
});
