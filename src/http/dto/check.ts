import type { CheckOperation } from '../../domain/check.js';

export type ExpectedHeaderDto = {
  name: string;
  value: string;
  operation?: CheckOperation;
  ignoreCase?: boolean;
};

export type ExpectedValueDto = {
  jsonPath: string;
  value: string;
  operation?: CheckOperation;
  ignoreCase?: boolean;
};

export type SlotCheckDto = {
  headers?: readonly ExpectedHeaderDto[];
  values?: readonly ExpectedValueDto[];
};
