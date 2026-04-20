//! Fuzz target:
//! `protocol_codec::modbus::pdu::decode_read_holding_registers_response`.
//!
//! Exercises the FC + byte_count + register-array decoder path that
//! also backs FC 0x04 (the two share `decode_register_array_response`).
//! Invariant: no panic, no UB, no unbounded allocation; in particular
//! the `Vec<u16>` capacity allocation MUST NOT exceed the byte_count
//! pre-validation bound (250 / 2 = 125 entries).

#![no_main]

use libfuzzer_sys::fuzz_target;
use protocol_codec::modbus::pdu::decode_read_holding_registers_response;

fuzz_target!(|data: &[u8]| {
    let _ = decode_read_holding_registers_response(data);
});
