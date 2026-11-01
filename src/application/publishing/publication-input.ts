export type RecordDataType = 'STRING' | 'BINARY' | 'JSON';

export type JsonData =
  null | boolean | number | string | readonly JsonData[] | { readonly [key: string]: JsonData };

export type PublicationHeaderDto =
  | { name: string; type?: 'STRING'; value: string }
  | { name: string; type?: 'BINARY'; value: string }
  | { name: string; type: 'JSON'; value: JsonData };

export type PublicationKeyDto =
  | { type?: 'STRING'; data: string }
  | { type?: 'BINARY'; data: string }
  | { type: 'JSON'; data: JsonData };

export type PublicationValueDto =
  | { type?: 'STRING'; data: string }
  | { type?: 'BINARY'; data: string }
  | { type: 'JSON'; data: JsonData };

export type RecordDto = {
  headers?: Array<PublicationHeaderDto>;
  key?: PublicationKeyDto;
  value: PublicationValueDto;
};
