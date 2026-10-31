export type ReadHeaderDto = {
  name: string;
  value: string;
};

export type ReadKeyDto = {
  type: 'BINARY';
  data: string;
};

export type ReadValueDto = {
  type: 'JSON';
  data: unknown;
};

export type RepresentableRecord = {
  headers: readonly ReadHeaderDto[];
  key?: ReadKeyDto;
  value: ReadValueDto;
};

export type ReadRecordDto = RepresentableRecord;
