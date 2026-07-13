/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const crc16Modbus: (a: number, b: number) => number;
export const frameWithCrc: (a: number, b: number) => [number, number];
export const parseMbapHeaderJson: (a: number, b: number) => [number, number, number, number];
export const parseRtuFrameJson: (a: number, b: number) => [number, number, number, number];
export const parseAsciiFrameJson: (a: number, b: number) => [number, number, number, number];
export const decodeReadHoldingRegistersResponseJson: (a: number, b: number) => [number, number, number, number];
export const decodeReadInputRegistersResponseJson: (a: number, b: number) => [number, number, number, number];
export const decodeWriteSingleRegisterJson: (a: number, b: number) => [number, number, number, number];
export const decodeWriteMultipleRegistersResponseJson: (a: number, b: number) => [number, number, number, number];
export const decodeExceptionResponseJson: (a: number, b: number) => [number, number, number, number];
export const __wbindgen_export_0: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
