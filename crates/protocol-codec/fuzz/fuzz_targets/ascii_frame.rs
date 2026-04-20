//! Fuzz target: `protocol_codec::modbus::ascii::parse_ascii_frame`.
//!
//! Highest-allocation decoder in the codec (hex-decode is allocation-
//! per-frame), so this target also serves as an OOM-trip wire. Invariant:
//! no panic, no UB, no unbounded allocation.

#![no_main]

use libfuzzer_sys::fuzz_target;
use protocol_codec::modbus::ascii::parse_ascii_frame;

fuzz_target!(|data: &[u8]| {
    let _ = parse_ascii_frame(data);
});
