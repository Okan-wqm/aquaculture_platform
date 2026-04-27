//! Fuzz target: `protocol_codec::modbus::rtu::parse_rtu_frame`.
//!
//! Stresses the CRC-16-Modbus pipeline plus the address / PDU split.
//! Invariant: no panic, no UB on any byte sequence.

#![no_main]

use libfuzzer_sys::fuzz_target;
use protocol_codec::modbus::rtu::parse_rtu_frame;

fuzz_target!(|data: &[u8]| {
    let _ = parse_rtu_frame(data);
});
