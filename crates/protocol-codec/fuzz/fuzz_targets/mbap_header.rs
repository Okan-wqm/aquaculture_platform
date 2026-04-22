//! Fuzz target: `protocol_codec::modbus::tcp::parse_mbap_header`.
//!
//! Invariant: the parser MUST NOT panic, abort, or invoke UB on any
//! arbitrary byte sequence — including empty input, truncated frames,
//! and non-Modbus traffic that happens to land on the same socket.
//! Returning a `ParseError` is acceptable; crashing is not.

#![no_main]

use libfuzzer_sys::fuzz_target;
use protocol_codec::modbus::tcp::parse_mbap_header;

fuzz_target!(|data: &[u8]| {
    // Drop the result — we are only checking that the parser does not
    // crash. Returning `Err(...)` for malformed input is the expected
    // happy path of fuzzing.
    let _ = parse_mbap_header(data);
});
