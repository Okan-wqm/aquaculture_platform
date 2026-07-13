/* tslint:disable */
/* eslint-disable */
/**
 * CRC-16-Modbus (init 0xFFFF, poly 0xA001). Byte-identical to the edge
 * gateway and to the hand-rolled VFD adapter this replaces.
 */
export function crc16Modbus(data: Uint8Array): number;
/**
 * Append the little-endian CRC-16-Modbus trailer to a request body,
 * returning the complete RTU frame.
 */
export function frameWithCrc(data: Uint8Array): Uint8Array;
/**
 * Parse a Modbus-TCP MBAP header. Returns `{ transaction_id, unit_id,
 * pdu_length }` as JSON (the tail PDU is the caller's to decode).
 */
export function parseMbapHeaderJson(data: Uint8Array): string;
/**
 * Parse a Modbus-RTU frame, returning `{ address, pdu_hex }` (uppercase
 * hex), mirroring the golden-fixture projection.
 */
export function parseRtuFrameJson(data: Uint8Array): string;
/**
 * Parse a Modbus-ASCII frame, returning `{ address, pdu_hex }` (uppercase
 * hex), mirroring the golden-fixture projection.
 */
export function parseAsciiFrameJson(data: Uint8Array): string;
/**
 * Decode an FC 0x03 Read Holding Registers response PDU. Returns
 * `{ registers: [...] }` as JSON.
 */
export function decodeReadHoldingRegistersResponseJson(data: Uint8Array): string;
/**
 * Decode an FC 0x04 Read Input Registers response PDU. Returns
 * `{ registers: [...] }` as JSON.
 */
export function decodeReadInputRegistersResponseJson(data: Uint8Array): string;
/**
 * Decode an FC 0x06 Write Single Register request/response PDU. Returns
 * `{ address, value }` as JSON.
 */
export function decodeWriteSingleRegisterJson(data: Uint8Array): string;
/**
 * Decode an FC 0x10 Write Multiple Registers response PDU. Returns
 * `{ starting_address, quantity }` as JSON.
 */
export function decodeWriteMultipleRegistersResponseJson(data: Uint8Array): string;
/**
 * Decode a Modbus exception response PDU. Returns the exception object as
 * JSON, or `null` when the PDU is not an exception.
 */
export function decodeExceptionResponseJson(data: Uint8Array): string;
