//! Golden-fixture integration test for `protocol-codec`.
//!
//! Reads every `tests/golden/*.json` fixture, dispatches to the decoder
//! named in the fixture, and asserts byte-equivalent JSON output (or
//! the expected `ParseError` variant) against the fixture spec.
//!
//! ## Why this test exists
//!
//! Per ADR-026, the same fixture set is the **drift CI invariant** —
//! both this Rust integration test AND the TypeScript-side codec
//! adapters in `apps/sensor-service/src/protocol/adapters/__tests__/`
//! consume the SAME files and must produce byte-identical output.
//! Any divergence between the two is, by definition, a parser bug in
//! one of them.
//!
//! ## Adding a fixture
//!
//! Drop a new `*.json` file into `tests/golden/`. Schema:
//!
//! ```json
//! {
//!   "name": "fc03_response_two_registers",
//!   "description": "...",
//!   "decoder": "decode_read_holding_registers_response",
//!   "wire_hex": "030400FA0064",
//!   "expected_ok": { "registers": [250, 100] }
//! }
//! ```
//!
//! Or, for error fixtures, replace `expected_ok` with `expected_err`:
//!
//! ```json
//! {
//!   "name": "tcp_invalid_protocol_id",
//!   "decoder": "parse_mbap_header",
//!   "wire_hex": "0001beef000601",
//!   "expected_err": { "kind": "InvalidProtocolId" }
//! }
//! ```
//!
//! `decoder` MUST match one of the entries in [`dispatch_fixture`].

// Integration tests are separate crates and do not inherit the
// crate-root `cfg_attr(test, allow(...))`. Opt in to the same set used
// by unit tests, plus a few that the test scaffolding needs:
//   - print_stdout: the test prints a "[golden] N fixtures" summary
//   - format_push_string: hex_encode is a tiny helper, write! is overkill
//   - question_mark: explicit let...else gives clearer panic context
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::print_stdout,
    clippy::format_push_string,
    clippy::question_mark
)]

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use protocol_codec::ParseError;
use protocol_codec::modbus::ascii::parse_ascii_frame;
use protocol_codec::modbus::pdu::{
    decode_exception_response, decode_read_holding_registers_response,
    decode_read_input_registers_response, decode_write_multiple_registers_response,
    decode_write_single_register,
};
use protocol_codec::modbus::rtu::parse_rtu_frame;
use protocol_codec::modbus::tcp::parse_mbap_header;

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    description: String,
    decoder: String,
    wire_hex: String,
    #[serde(default)]
    expected_ok: Option<Value>,
    #[serde(default)]
    expected_err: Option<ExpectedErr>,
}

#[derive(Debug, Deserialize)]
struct ExpectedErr {
    /// Discriminant name of the [`ParseError`] variant.
    kind: String,
}

#[test]
fn every_golden_fixture_round_trips() {
    let dir = fixture_dir();
    let mut count = 0_usize;
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    entries.sort();

    assert!(
        !entries.is_empty(),
        "no fixtures found in {} — at least one is required",
        dir.display(),
    );

    for path in entries {
        let raw = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read fixture {}: {e}", path.display()));
        let fixture: Fixture = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("malformed fixture {}: {e}", path.display()));

        run_fixture(&fixture, &path);
        count += 1;
    }

    println!("\n[golden] {count} fixtures asserted");
}

fn run_fixture(fixture: &Fixture, path: &Path) {
    let label = format!("{} ({})", fixture.name, path.display());
    let bytes = decode_hex(&fixture.wire_hex)
        .unwrap_or_else(|| panic!("fixture {label}: invalid hex in wire_hex"));

    match (&fixture.expected_ok, &fixture.expected_err) {
        (Some(expected), None) => {
            let actual = dispatch_ok(&fixture.decoder, &bytes)
                .unwrap_or_else(|e| panic!("fixture {label}: expected ok, got {e:?}"));
            assert_json_equivalent(expected, &actual, &label, &fixture.description);
        }
        (None, Some(expected)) => {
            let err = dispatch_err(&fixture.decoder, &bytes)
                .unwrap_or_else(|| panic!("fixture {label}: expected error, got ok"));
            let actual_kind = error_discriminant(&err);
            assert_eq!(
                expected.kind, actual_kind,
                "fixture {label}: expected error kind '{}' but got '{actual_kind}' ({err:?})\n  desc: {}",
                expected.kind, fixture.description,
            );
        }
        (Some(_), Some(_)) => {
            panic!("fixture {label}: cannot set both expected_ok and expected_err");
        }
        (None, None) => {
            panic!("fixture {label}: must set either expected_ok or expected_err");
        }
    }
}

/// Dispatch table for the success case. Returns the decoder's output
/// re-serialised as `serde_json::Value` so the assertion can be a
/// byte-equivalent JSON comparison.
fn dispatch_ok(decoder: &str, bytes: &[u8]) -> Result<Value, ParseError> {
    match decoder {
        "parse_mbap_header" => {
            let (hdr, _rest) = parse_mbap_header(bytes)?;
            Ok(serde_json::to_value(hdr).unwrap())
        }
        "parse_rtu_frame" => {
            let frame = parse_rtu_frame(bytes)?;
            // RtuFrame is borrow-based and not Serialize; project to a
            // serde-friendly tuple here so the test does not require
            // the production type to grow a serde derive it does not
            // need at runtime.
            Ok(serde_json::json!({
                "address": frame.address,
                "pdu_hex": hex_encode(frame.pdu),
            }))
        }
        "parse_ascii_frame" => {
            let frame = parse_ascii_frame(bytes)?;
            Ok(serde_json::json!({
                "address": frame.address,
                "pdu_hex": hex_encode(&frame.pdu),
            }))
        }
        "decode_read_holding_registers_response" => {
            let resp = decode_read_holding_registers_response(bytes)?;
            Ok(serde_json::to_value(resp).unwrap())
        }
        "decode_read_input_registers_response" => {
            let resp = decode_read_input_registers_response(bytes)?;
            Ok(serde_json::to_value(resp).unwrap())
        }
        "decode_write_single_register" => {
            let resp = decode_write_single_register(bytes)?;
            Ok(serde_json::to_value(resp).unwrap())
        }
        "decode_write_multiple_registers_response" => {
            let resp = decode_write_multiple_registers_response(bytes)?;
            Ok(serde_json::to_value(resp).unwrap())
        }
        "decode_exception_response" => {
            let resp = decode_exception_response(bytes)?;
            Ok(serde_json::to_value(resp).unwrap())
        }
        unknown => panic!("unknown decoder name in fixture: {unknown}"),
    }
}

/// Dispatch table for the error case. Mirror of [`dispatch_ok`] but
/// returns `Option<ParseError>` so the caller can distinguish "decoder
/// returned ok unexpectedly" from "decoder returned the expected
/// error".
fn dispatch_err(decoder: &str, bytes: &[u8]) -> Option<ParseError> {
    match decoder {
        "parse_mbap_header" => parse_mbap_header(bytes).err(),
        "parse_rtu_frame" => parse_rtu_frame(bytes).err(),
        "parse_ascii_frame" => parse_ascii_frame(bytes).err(),
        "decode_read_holding_registers_response" => {
            decode_read_holding_registers_response(bytes).err()
        }
        "decode_read_input_registers_response" => decode_read_input_registers_response(bytes).err(),
        "decode_write_single_register" => decode_write_single_register(bytes).err(),
        "decode_write_multiple_registers_response" => {
            decode_write_multiple_registers_response(bytes).err()
        }
        "decode_exception_response" => decode_exception_response(bytes).err(),
        unknown => panic!("unknown decoder name in fixture: {unknown}"),
    }
}

/// Map a `ParseError` to its variant discriminant name, for fixture
/// `expected_err.kind` comparison.
fn error_discriminant(err: &ParseError) -> &'static str {
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

fn assert_json_equivalent(expected: &Value, actual: &Value, label: &str, description: &str) {
    assert!(
        expected == actual,
        "fixture {label}: JSON mismatch\n  description: {description}\n  expected: {}\n  actual:   {}\n",
        serde_json::to_string_pretty(expected).unwrap(),
        serde_json::to_string_pretty(actual).unwrap(),
    );
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let Some(b) = bytes.get(i..i + 2) else {
            return None;
        };
        let Ok(s) = std::str::from_utf8(b) else {
            return None;
        };
        let Ok(n) = u8::from_str_radix(s, 16) else {
            return None;
        };
        out.push(n);
        i += 2;
    }
    Some(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}
