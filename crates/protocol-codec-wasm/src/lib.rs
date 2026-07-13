//! wasm-bindgen bindings over `protocol-codec`.
//!
//! WHY this crate exists:
//!   `protocol-codec` is the drift-zero Modbus parser SSoT (ADR-026),
//!   already consumed by the edge gateway and the Rust ingestion sidecar.
//!   The NestJS backend and the browser config UI reimplemented pieces of
//!   the same bit-level decoding by hand (CRC-16, MBAP framing), which is
//!   exactly the divergence ADR-026 exists to prevent. This crate compiles
//!   the one Rust parser to WebAssembly so those consumers call the SSoT
//!   instead of a hand-rolled copy. ADR-025 rejected NAPI-RS (a Rust panic
//!   would crash the NestJS process, and the `.node` ABI is fragile); wasm
//!   is the middle path — a memory-isolated sandbox with no shared crash
//!   domain and no native ABI.
//!
//! Serialisation contract:
//!   The structured decoders return a JSON string produced by the SAME
//!   `serde` derives the Rust golden-fixture harness asserts against, so the
//!   wasm output is byte-identical to the native output by construction. The
//!   `parse_*_frame` projections mirror the harness's `dispatch_ok` shape
//!   (`{ address, pdu_hex }`, uppercase hex) so a single fixture set proves
//!   both sides.

#![forbid(unsafe_code)]

use protocol_codec::ParseError;
use protocol_codec::modbus::ascii::parse_ascii_frame;
use protocol_codec::modbus::pdu::{
    decode_exception_response, decode_read_holding_registers_response,
    decode_read_input_registers_response, decode_write_multiple_registers_response,
    decode_write_single_register,
};
use protocol_codec::modbus::rtu::{
    crc16_modbus as crc16, frame_with_crc as rtu_frame_with_crc, parse_rtu_frame,
};
use protocol_codec::modbus::tcp::parse_mbap_header;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

/* ------------------------------------------------------------------ */
/*  Error mapping                                                       */
/* ------------------------------------------------------------------ */

/// Discriminant name of a `ParseError`, matching the golden-fixture
/// harness's `error_discriminant` so `expected_err.kind` comparison works
/// identically across the Rust and TypeScript legs.
fn discriminant(err: &ParseError) -> &'static str {
    match err {
        ParseError::Truncated { .. } => "Truncated",
        ParseError::LengthMismatch { .. } => "LengthMismatch",
        ParseError::BadChecksum { .. } => "BadChecksum",
        ParseError::UnsupportedFunctionCode(_) => "UnsupportedFunctionCode",
        ParseError::InvalidProtocolId(_) => "InvalidProtocolId",
        ParseError::TenantMismatch => "TenantMismatch",
        ParseError::Malformed(_) => "Malformed",
    }
}

/// Convert a `ParseError` into a JS exception whose message is the variant
/// discriminant (so the caller can branch on the error class, not a string).
fn to_js_error(err: &ParseError) -> JsError {
    JsError::new(discriminant(err))
}

/// Uppercase hex, matching the golden harness's `hex_encode`.
fn hex_upper(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/// CRC-16-Modbus (init 0xFFFF, poly 0xA001). Byte-identical to the edge
/// gateway and to the hand-rolled VFD adapter this replaces.
#[wasm_bindgen(js_name = crc16Modbus)]
#[must_use]
pub fn crc16_modbus(data: &[u8]) -> u16 {
    crc16(data)
}

/// Append the little-endian CRC-16-Modbus trailer to a request body,
/// returning the complete RTU frame.
#[wasm_bindgen(js_name = frameWithCrc)]
#[must_use]
pub fn frame_with_crc(data: &[u8]) -> Vec<u8> {
    rtu_frame_with_crc(data)
}

/// Parse a Modbus-TCP MBAP header. Returns `{ transaction_id, unit_id,
/// pdu_length }` as JSON (the tail PDU is the caller's to decode).
#[wasm_bindgen(js_name = parseMbapHeaderJson)]
pub fn parse_mbap_header_json(data: &[u8]) -> Result<String, JsError> {
    let (header, _rest) = parse_mbap_header(data).map_err(|e| to_js_error(&e))?;
    serde_json::to_string(&header).map_err(|e| JsError::new(&e.to_string()))
}

/// Parse a Modbus-RTU frame, returning `{ address, pdu_hex }` (uppercase
/// hex), mirroring the golden-fixture projection.
#[wasm_bindgen(js_name = parseRtuFrameJson)]
pub fn parse_rtu_frame_json(data: &[u8]) -> Result<String, JsError> {
    let frame = parse_rtu_frame(data).map_err(|e| to_js_error(&e))?;
    let value = serde_json::json!({
        "address": frame.address,
        "pdu_hex": hex_upper(frame.pdu),
    });
    serde_json::to_string(&value).map_err(|e| JsError::new(&e.to_string()))
}

/// Parse a Modbus-ASCII frame, returning `{ address, pdu_hex }` (uppercase
/// hex), mirroring the golden-fixture projection.
#[wasm_bindgen(js_name = parseAsciiFrameJson)]
pub fn parse_ascii_frame_json(data: &[u8]) -> Result<String, JsError> {
    let frame = parse_ascii_frame(data).map_err(|e| to_js_error(&e))?;
    let value = serde_json::json!({
        "address": frame.address,
        "pdu_hex": hex_upper(&frame.pdu),
    });
    serde_json::to_string(&value).map_err(|e| JsError::new(&e.to_string()))
}

/// Decode an FC 0x03 Read Holding Registers response PDU. Returns
/// `{ registers: [...] }` as JSON.
#[wasm_bindgen(js_name = decodeReadHoldingRegistersResponseJson)]
pub fn decode_read_holding_registers_response_json(data: &[u8]) -> Result<String, JsError> {
    let resp = decode_read_holding_registers_response(data).map_err(|e| to_js_error(&e))?;
    serde_json::to_string(&resp).map_err(|e| JsError::new(&e.to_string()))
}

/// Decode an FC 0x04 Read Input Registers response PDU. Returns
/// `{ registers: [...] }` as JSON.
#[wasm_bindgen(js_name = decodeReadInputRegistersResponseJson)]
pub fn decode_read_input_registers_response_json(data: &[u8]) -> Result<String, JsError> {
    let resp = decode_read_input_registers_response(data).map_err(|e| to_js_error(&e))?;
    serde_json::to_string(&resp).map_err(|e| JsError::new(&e.to_string()))
}

/// Decode an FC 0x06 Write Single Register request/response PDU. Returns
/// `{ address, value }` as JSON.
#[wasm_bindgen(js_name = decodeWriteSingleRegisterJson)]
pub fn decode_write_single_register_json(data: &[u8]) -> Result<String, JsError> {
    let resp = decode_write_single_register(data).map_err(|e| to_js_error(&e))?;
    serde_json::to_string(&resp).map_err(|e| JsError::new(&e.to_string()))
}

/// Decode an FC 0x10 Write Multiple Registers response PDU. Returns
/// `{ starting_address, quantity }` as JSON.
#[wasm_bindgen(js_name = decodeWriteMultipleRegistersResponseJson)]
pub fn decode_write_multiple_registers_response_json(data: &[u8]) -> Result<String, JsError> {
    let resp = decode_write_multiple_registers_response(data).map_err(|e| to_js_error(&e))?;
    serde_json::to_string(&resp).map_err(|e| JsError::new(&e.to_string()))
}

/// Decode a Modbus exception response PDU. Returns the exception object as
/// JSON, or `null` when the PDU is not an exception.
#[wasm_bindgen(js_name = decodeExceptionResponseJson)]
pub fn decode_exception_response_json(data: &[u8]) -> Result<String, JsError> {
    let resp = decode_exception_response(data).map_err(|e| to_js_error(&e))?;
    serde_json::to_string(&resp).map_err(|e| JsError::new(&e.to_string()))
}
