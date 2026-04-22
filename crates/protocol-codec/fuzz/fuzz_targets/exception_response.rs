//! Fuzz target: `protocol_codec::modbus::pdu::decode_exception_response`.
//!
//! Tiny decoder (2 bytes) but covers the FC | 0x80 dispatch branch and
//! the `ModbusException::Other(byte)` catch-all. Invariant: no panic,
//! no UB.

#![no_main]

use libfuzzer_sys::fuzz_target;
use protocol_codec::modbus::pdu::decode_exception_response;

fuzz_target!(|data: &[u8]| {
    let _ = decode_exception_response(data);
});
