export type ExpectedHeaderDto = {
  name: string;
  value: string;
};

export type ExpectedValueDto = {
  jsonPath: string;
  value: string;
};

export type SlotCheckDto = {
  headers?: readonly ExpectedHeaderDto[];
  values?: readonly ExpectedValueDto[];
};
