/**
 * `@platform/protocol-codec` — typed TypeScript façade over the
 * `protocol-codec` Rust crate compiled to WebAssembly.
 *
 * WHY: the Modbus bit-level decoders (CRC-16, MBAP framing, PDU register
 * decode) are the drift-zero SSoT (ADR-026), already used by the edge gateway
 * and the Rust ingestion sidecar. This façade lets the NestJS backend (and,
 * later, the browser config UI) call that same parser instead of a hand-rolled
 * copy. ADR-025 rejected NAPI-RS; wasm is the middle path (no native ABI, no
 * shared crash domain — a decode failure throws a catchable JS error).
 *
 * The generated bindings under `./generated` are produced by
 * `scripts/build-wasm.sh` (cargo + wasm-bindgen `--target nodejs`), which loads
 * the embedded `.wasm` synchronously via `require`, so every function here is a
 * plain synchronous call with no async init.
 */

import {
  crc16Modbus as wasmCrc16Modbus,
  frameWithCrc as wasmFrameWithCrc,
  parseMbapHeaderJson,
  parseRtuFrameJson,
  parseAsciiFrameJson,
  decodeReadHoldingRegistersResponseJson,
  decodeReadInputRegistersResponseJson,
  decodeWriteSingleRegisterJson,
  decodeWriteMultipleRegistersResponseJson,
  decodeExceptionResponseJson,
} from './generated/protocol_codec_wasm';

/* ------------------------------------------------------------------ */
/*  Decoded shapes (snake_case = the Rust serde SSoT, kept identical    */
/*  so the shared golden fixtures prove both legs byte-for-byte).       */
/* ------------------------------------------------------------------ */

/** Modbus-TCP MBAP header. */
export interface MbapHeader {
  transaction_id: number;
  unit_id: number;
  pdu_length: number;
}

/** Projection of a decoded Modbus-RTU/ASCII frame (uppercase hex PDU). */
export interface FrameProjection {
  address: number;
  pdu_hex: string;
}

/** FC 0x03 / 0x04 register-array response. */
export interface RegisterArrayResponse {
  registers: number[];
}

/** FC 0x06 Write Single Register echo. */
export interface WriteSingleRegister {
  address: number;
  value: number;
}

/** FC 0x10 Write Multiple Registers response. */
export interface WriteMultipleRegistersResponse {
  starting_address: number;
  quantity: number;
}

/** Discriminants of the underlying Rust `ParseError`. */
export type ParseErrorKind =
  | 'Truncated'
  | 'LengthMismatch'
  | 'BadChecksum'
  | 'UnsupportedFunctionCode'
  | 'InvalidProtocolId'
  | 'TenantMismatch'
  | 'Malformed';

/** Typed wrapper over a decode failure raised by the wasm codec. */
export class ProtocolCodecError extends Error {
  /** The Rust `ParseError` discriminant the wasm codec raised. */
  readonly kind: ParseErrorKind;

  constructor(kind: string) {
    super(kind);
    this.name = 'ProtocolCodecError';
    this.kind = kind as ParseErrorKind;
  }
}

/**
 * Run a wasm call that may throw a `JsError` whose message is the Rust
 * `ParseError` discriminant, re-raising it as a typed `ProtocolCodecError`.
 */
function decode<T>(fn: () => string): T {
  let json: string;
  try {
    json = fn();
  } catch (err) {
    throw new ProtocolCodecError((err as Error).message);
  }
  return JSON.parse(json) as T;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/** CRC-16-Modbus (init 0xFFFF, poly 0xA001) over `data`. */
export function crc16Modbus(data: Uint8Array): number {
  return wasmCrc16Modbus(data);
}

/** Append the little-endian CRC-16-Modbus trailer, returning the RTU frame. */
export function frameWithCrc(data: Uint8Array): Uint8Array {
  return wasmFrameWithCrc(data);
}

/** Parse a Modbus-TCP MBAP header (throws `ProtocolCodecError` on a bad frame). */
export function parseMbapHeader(data: Uint8Array): MbapHeader {
  return decode<MbapHeader>(() => parseMbapHeaderJson(data));
}

/** Parse a Modbus-RTU frame (throws `ProtocolCodecError` on a bad CRC/frame). */
export function parseRtuFrame(data: Uint8Array): FrameProjection {
  return decode<FrameProjection>(() => parseRtuFrameJson(data));
}

/** Parse a Modbus-ASCII frame (throws `ProtocolCodecError` on a bad LRC/frame). */
export function parseAsciiFrame(data: Uint8Array): FrameProjection {
  return decode<FrameProjection>(() => parseAsciiFrameJson(data));
}

/** Decode an FC 0x03 Read Holding Registers response PDU. */
export function decodeReadHoldingRegistersResponse(data: Uint8Array): RegisterArrayResponse {
  return decode<RegisterArrayResponse>(() => decodeReadHoldingRegistersResponseJson(data));
}

/** Decode an FC 0x04 Read Input Registers response PDU. */
export function decodeReadInputRegistersResponse(data: Uint8Array): RegisterArrayResponse {
  return decode<RegisterArrayResponse>(() => decodeReadInputRegistersResponseJson(data));
}

/** Decode an FC 0x06 Write Single Register request/response PDU. */
export function decodeWriteSingleRegister(data: Uint8Array): WriteSingleRegister {
  return decode<WriteSingleRegister>(() => decodeWriteSingleRegisterJson(data));
}

/** Decode an FC 0x10 Write Multiple Registers response PDU. */
export function decodeWriteMultipleRegistersResponse(
  data: Uint8Array,
): WriteMultipleRegistersResponse {
  return decode<WriteMultipleRegistersResponse>(() =>
    decodeWriteMultipleRegistersResponseJson(data),
  );
}

/** Decode a Modbus exception response PDU (`null` when not an exception). */
export function decodeExceptionResponse(data: Uint8Array): unknown {
  return decode<unknown>(() => decodeExceptionResponseJson(data));
}
