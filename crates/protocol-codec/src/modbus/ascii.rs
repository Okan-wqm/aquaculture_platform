//! Modbus ASCII transport — LRC framing.
//!
//! ASCII framing (per MODBUS over Serial Line V1.02 §2.5.2):
//!
//! ```text
//!   +---+----+----+--------+----+------+
//!   | : | aa | ff |  data  | LL | CRLF |
//!   +---+----+----+--------+----+------+
//!     1   2    2    2*N      2     2    chars
//! ```
//!
//! - `:` (`0x3A`) frame start.
//! - `aa` — slave address as TWO ASCII hex digits (uppercase or lower
//!   accepted by this decoder; spec mandates uppercase but devices
//!   lie).
//! - `ff` — function code, two ASCII hex digits.
//! - `data` — variable, two ASCII hex digits per data byte.
//! - `LL` — Longitudinal Redundancy Check, two ASCII hex digits.
//! - `CRLF` — `\r\n`, frame terminator.
//!
//! LRC = `(-(sum of body bytes)) mod 256`. The check is computed over
//! the BINARY decoded body (address + FC + data), not over the ASCII
//! representation.
//!
//! The decoder allocates a single `Vec<u8>` for the decoded body. In
//! contrast to RTU, the decoded view cannot borrow into the input
//! because it is the result of a hex-pair-to-byte translation.

use serde::{Deserialize, Serialize};

use crate::error::ParseError;

/// Frame start delimiter — colon.
pub const ASCII_START: u8 = b':';

/// Frame terminator — CRLF.
pub const ASCII_END: &[u8; 2] = b"\r\n";

/// Smallest legal ASCII frame: `:` + addr (2) + FC (2) + LRC (2) + CRLF (2) = 9 bytes.
pub const ASCII_MIN_FRAME_LEN: usize = 9;

/// Owned decoded ASCII frame. PDU is owned (`Vec<u8>`) because the
/// hex-decoded bytes do not exist anywhere in the input buffer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsciiFrame {
    /// Slave / unit address. 0 = broadcast.
    pub address: u8,
    /// Function code + data, no LRC. Length is in `1..=252`.
    pub pdu: Vec<u8>,
}

/// Compute the Longitudinal Redundancy Check over the binary `body`
/// (address + FC + data — i.e. everything except the LRC itself).
///
/// `LRC = (-(sum of bytes)) mod 256`, expressed in two's-complement
/// arithmetic via `wrapping_neg`. Equivalent to `256 - (sum mod 256)`.
#[must_use]
pub fn lrc(body: &[u8]) -> u8 {
    body.iter()
        .fold(0_u8, |acc, &b| acc.wrapping_add(b))
        .wrapping_neg()
}

/// Decode a single ASCII frame and verify its LRC.
///
/// Errors:
/// - [`ParseError::Malformed`] — missing `:`, missing CRLF, odd hex
///   digit count, or non-hex character in the body.
/// - [`ParseError::Truncated`] — fewer than [`ASCII_MIN_FRAME_LEN`] bytes.
/// - [`ParseError::BadChecksum`] — LRC on the wire does not match the
///   LRC computed over `address || pdu`.
///
/// Hex decoding accepts both upper- and lower-case digits.
pub fn parse_ascii_frame(input: &[u8]) -> Result<AsciiFrame, ParseError> {
    if input.len() < ASCII_MIN_FRAME_LEN {
        return Err(ParseError::Truncated {
            needed: ASCII_MIN_FRAME_LEN.saturating_sub(input.len()),
        });
    }
    let Some((&first, rest)) = input.split_first() else {
        return Err(ParseError::Truncated { needed: ASCII_MIN_FRAME_LEN });
    };
    if first != ASCII_START {
        return Err(ParseError::Malformed("ASCII frame must start with ':'"));
    }
    let Some(hex_body) = rest.strip_suffix(ASCII_END.as_slice()) else {
        return Err(ParseError::Malformed("ASCII frame must end with CRLF"));
    };
    if hex_body.is_empty() || hex_body.len() % 2 != 0 {
        return Err(ParseError::Malformed(
            "ASCII frame body must be a non-empty even-length hex string",
        ));
    }

    // Hex-decode into `decoded` (address + FC + data + LRC).
    let byte_count = hex_body.len() / 2;
    let mut decoded = Vec::with_capacity(byte_count);
    for chunk in hex_body.chunks_exact(2) {
        let &[hi, lo] = chunk else {
            return Err(ParseError::Malformed(
                "chunks_exact(2) yielded non-pair slice — should be unreachable",
            ));
        };
        let high_nibble = hex_digit_value(hi)
            .ok_or(ParseError::Malformed("non-hex digit in ASCII frame"))?;
        let low_nibble = hex_digit_value(lo)
            .ok_or(ParseError::Malformed("non-hex digit in ASCII frame"))?;
        decoded.push((high_nibble << 4) | low_nibble);
    }

    // body || LRC
    let Some((&lrc_on_wire, body_slice)) = decoded.split_last() else {
        // Unreachable: byte_count >= ASCII_MIN_FRAME_LEN-3 / 2 = 3.
        return Err(ParseError::Truncated { needed: 1 });
    };
    if body_slice.len() < 2 {
        // address + at least 1-byte FC required.
        return Err(ParseError::Truncated {
            needed: 2_usize.saturating_sub(body_slice.len()),
        });
    }
    let lrc_computed = lrc(body_slice);
    if lrc_computed != lrc_on_wire {
        return Err(ParseError::BadChecksum {
            expected: u16::from(lrc_computed),
            got: u16::from(lrc_on_wire),
        });
    }

    let Some((&address, pdu_slice)) = body_slice.split_first() else {
        return Err(ParseError::Truncated { needed: 1 });
    };
    Ok(AsciiFrame {
        address,
        pdu: pdu_slice.to_vec(),
    })
}

/// Convenience: build a wire-ready ASCII frame from a binary `body`
/// (address + FC + data). Computes the LRC and wraps with `:` + CRLF.
///
/// Output uses uppercase hex per the spec.
#[must_use]
pub fn frame_with_lrc(body: &[u8]) -> Vec<u8> {
    let lrc_byte = lrc(body);
    // body bytes + lrc byte -> hex: 2 chars each. Plus ':' + CRLF.
    let mut out = Vec::with_capacity(1 + (body.len() + 1) * 2 + 2);
    out.push(ASCII_START);
    for &b in body {
        out.push(hex_digit_char(b >> 4));
        out.push(hex_digit_char(b & 0x0F));
    }
    out.push(hex_digit_char(lrc_byte >> 4));
    out.push(hex_digit_char(lrc_byte & 0x0F));
    out.extend_from_slice(ASCII_END);
    out
}

const fn hex_digit_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'A'..=b'F' => Some(c - b'A' + 10),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

const fn hex_digit_char(nibble: u8) -> u8 {
    // `nibble` is in 0..=15; values above are masked off by the
    // caller (`b & 0x0F`). This is a const fn so the lookup table
    // gets inlined.
    match nibble {
        0..=9 => b'0' + nibble,
        10..=15 => b'A' + (nibble - 10),
        // Unreachable in practice — caller masks to 4 bits.
        _ => b'?',
    }
}

#[cfg(test)]
mod tests {
    use super::{
        frame_with_lrc, hex_digit_char, hex_digit_value, lrc, parse_ascii_frame, AsciiFrame,
        ASCII_MIN_FRAME_LEN,
    };
    use crate::error::ParseError;

    // --- LRC reference vectors ---------------------------------------

    #[test]
    fn lrc_empty_input_is_zero() {
        // sum = 0; -0 mod 256 = 0.
        assert_eq!(lrc(&[]), 0);
    }

    #[test]
    fn lrc_master_request_matches_canonical_value() {
        // address=01, FC=03, start=0x0000, count=0x000A
        // sum = 1 + 3 + 0 + 0 + 0 + 10 = 14 = 0x0E
        // LRC = (-0x0E) mod 256 = 0xF2
        let body = [0x01_u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        assert_eq!(lrc(&body), 0xF2);
    }

    // --- Hex digit helpers ------------------------------------------

    #[test]
    fn hex_digit_value_handles_all_cases() {
        assert_eq!(hex_digit_value(b'0'), Some(0));
        assert_eq!(hex_digit_value(b'9'), Some(9));
        assert_eq!(hex_digit_value(b'A'), Some(10));
        assert_eq!(hex_digit_value(b'F'), Some(15));
        assert_eq!(hex_digit_value(b'a'), Some(10));
        assert_eq!(hex_digit_value(b'f'), Some(15));
        assert_eq!(hex_digit_value(b'g'), None);
        assert_eq!(hex_digit_value(b' '), None);
    }

    #[test]
    fn hex_digit_char_roundtrips() {
        for n in 0_u8..=15 {
            let c = hex_digit_char(n);
            assert_eq!(hex_digit_value(c), Some(n));
        }
    }

    // --- Roundtrip via frame_with_lrc + parse_ascii_frame -----------

    #[test]
    fn roundtrip_master_request_uppercase_wire() {
        let body = [0x01_u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        let wire = frame_with_lrc(&body);
        // Expected: ":01030000000AF2\r\n" (15 bytes including CRLF)
        assert_eq!(wire.as_slice(), b":01030000000AF2\r\n");

        let parsed = parse_ascii_frame(&wire).unwrap();
        assert_eq!(parsed.address, 0x01);
        assert_eq!(parsed.pdu, vec![0x03, 0x00, 0x00, 0x00, 0x0A]);
    }

    #[test]
    fn lowercase_hex_is_accepted() {
        // Spec says uppercase; reality says devices send mixed case.
        // Accept both; emit uppercase.
        let parsed = parse_ascii_frame(b":01030000000af2\r\n").unwrap();
        assert_eq!(parsed.address, 0x01);
        assert_eq!(parsed.pdu, vec![0x03, 0x00, 0x00, 0x00, 0x0A]);
    }

    #[test]
    fn roundtrip_response_with_two_registers() {
        // FC 0x03 response, byte_count=4, registers=[0x0064, 0x012C]
        let body = [0x01_u8, 0x03, 0x04, 0x00, 0x64, 0x01, 0x2C];
        let wire = frame_with_lrc(&body);
        let parsed = parse_ascii_frame(&wire).unwrap();
        assert_eq!(
            parsed,
            AsciiFrame {
                address: 0x01,
                pdu: vec![0x03, 0x04, 0x00, 0x64, 0x01, 0x2C],
            }
        );
    }

    // --- Failure paths -----------------------------------------------

    #[test]
    fn missing_start_delimiter() {
        // Frame without leading ':' — but with the right length so we
        // exercise the start-byte check rather than length check.
        let wire = b"01030000000AF2\r\n";
        match parse_ascii_frame(wire) {
            Err(ParseError::Malformed(msg)) => {
                assert!(msg.contains(":"), "{msg}");
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn missing_crlf() {
        let wire = b":01030000000AF2";
        match parse_ascii_frame(wire) {
            Err(ParseError::Malformed(msg)) => {
                assert!(msg.contains("CRLF"), "{msg}");
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn odd_hex_count() {
        // Drop one hex char so the body length is odd.
        let wire = b":1030000000AF2\r\n";
        match parse_ascii_frame(wire) {
            Err(ParseError::Malformed(msg)) => {
                assert!(msg.contains("even-length"), "{msg}");
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn non_hex_char_rejected() {
        // 'G' is not a hex digit. Frame is otherwise valid length.
        let wire = b":01030000000AGZ\r\n";
        match parse_ascii_frame(wire) {
            Err(ParseError::Malformed(msg)) => {
                assert!(msg.contains("non-hex"), "{msg}");
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn truncated_below_minimum() {
        match parse_ascii_frame(b":01\r\n") {
            Err(ParseError::Truncated { .. }) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn bad_lrc_detected() {
        // Compute valid frame, then corrupt the LRC nibble.
        let body = [0x01_u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        let mut wire = frame_with_lrc(&body);
        // The LRC sits at positions wire.len()-4 .. wire.len()-2 (just
        // before CRLF). Flip one of them.
        let target = wire.len() - 3;
        wire[target] = if wire[target] == b'F' { b'0' } else { b'F' };
        match parse_ascii_frame(&wire) {
            Err(ParseError::BadChecksum { expected, got }) => {
                assert_ne!(expected, got);
            }
            other => panic!("expected BadChecksum, got {other:?}"),
        }
    }

    #[test]
    fn min_frame_len_constant_matches_assertion() {
        assert_eq!(ASCII_MIN_FRAME_LEN, 9);
    }
}
