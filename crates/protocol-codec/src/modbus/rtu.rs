//! Modbus RTU transport — CRC-16-Modbus framing.
//!
//! RTU framing (per MODBUS over Serial Line V1.02 §2.5.1):
//!
//! ```text
//!   +---------+--------------+---------+
//!   | address |     PDU      |  CRC-16 |
//!   |   u8    |  1..253 bytes|  u16 LE |
//!   +---------+--------------+---------+
//!     1 byte    1..253 bytes   2 bytes
//! ```
//!
//! - `address` 0 is broadcast; 1..=247 are unit ids; 248..=255 are
//!   reserved. This decoder accepts the full byte range — it is the
//!   caller's job to enforce site-specific addressing rules.
//! - The CRC field is little-endian on the wire (low byte first), in
//!   contrast to every multi-byte field inside the PDU which is
//!   big-endian. Mixing this up is a perennial bug, so the decoder
//!   tests exercise both orientations explicitly.
//!
//! Unlike [`super::tcp::parse_mbap_header`], the RTU frame is not
//! length-prefixed — RTU framing relies on inter-character silence on
//! the serial line. Callers must therefore present exactly one frame
//! per call; the parser does not return a tail.

use serde::{Deserialize, Serialize};

use crate::error::ParseError;

/// Smallest legal RTU frame: address (1) + at least 1-byte PDU + CRC (2).
pub const RTU_MIN_FRAME_LEN: usize = 4;

/// Largest legal RTU frame: address (1) + max PDU (253) + CRC (2).
pub const RTU_MAX_FRAME_LEN: usize = 256;

/// One decoded RTU frame, borrowing the PDU bytes from the caller's
/// buffer. The PDU is what callers feed to [`super::pdu`] decoders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RtuFrame<'a> {
    /// Slave / unit address. 0 = broadcast.
    pub address: u8,
    /// Function code + data, no CRC. Length is in `1..=253`.
    pub pdu: &'a [u8],
}

/// Compute CRC-16-Modbus over `buf`.
///
/// Polynomial `0x8005` reflected as `0xA001`, init `0xFFFF`, xor-out
/// `0x0000`, input + output reflected. Result is the value the
/// transmitter writes to the wire (low byte first — see
/// [`parse_rtu_frame`]).
///
/// This is the classic bit-by-bit reference implementation; a
/// table-driven version may replace it once the call rate justifies
/// the extra 512-byte table footprint, but this version is small,
/// constant-time, and easy to audit.
#[must_use]
pub fn crc16_modbus(buf: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &byte in buf {
        crc ^= u16::from(byte);
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

/// Decode a single RTU frame and verify its CRC.
///
/// Errors:
/// - [`ParseError::Truncated`] — fewer than [`RTU_MIN_FRAME_LEN`] (4)
///   bytes, or a 4-byte buffer where the address/CRC layout cannot be
///   satisfied.
/// - [`ParseError::BadChecksum`] — CRC on the wire does not match the
///   CRC the parser computed over `address || pdu`.
///
/// On success returns an [`RtuFrame`] borrowing into `input`.
pub fn parse_rtu_frame(input: &[u8]) -> Result<RtuFrame<'_>, ParseError> {
    let Some((body, &crc_bytes)) = input.split_last_chunk::<2>() else {
        return Err(ParseError::Truncated {
            needed: 2_usize.saturating_sub(input.len()),
        });
    };
    let Some((&address, pdu)) = body.split_first() else {
        return Err(ParseError::Truncated { needed: 1 });
    };
    if pdu.is_empty() {
        return Err(ParseError::Truncated { needed: 1 });
    }

    let crc_on_wire = u16::from_le_bytes(crc_bytes);
    let crc_computed = crc16_modbus(body);
    if crc_computed != crc_on_wire {
        return Err(ParseError::BadChecksum {
            expected: crc_computed,
            got: crc_on_wire,
        });
    }
    Ok(RtuFrame { address, pdu })
}

/// Convenience: append a fresh CRC-16-Modbus to `body`. The caller
/// owns frame assembly; this helper is here purely to keep test
/// fixtures honest (compute, never hand-write CRCs).
///
/// Wire byte order: low byte first, then high byte.
#[must_use]
pub fn frame_with_crc(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 2);
    out.extend_from_slice(body);
    let crc = crc16_modbus(body);
    out.extend_from_slice(&crc.to_le_bytes());
    out
}

/// Newtype wrapper used by the upcoming golden-fixture test set so a
/// fixture file declares its transport unambiguously.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RtuGoldenSpec {
    /// Hex-encoded full RTU frame including CRC.
    pub frame_hex: String,
    /// Expected `address` byte after parse.
    pub expected_address: u8,
    /// Expected PDU bytes (hex) after parse.
    pub expected_pdu_hex: String,
}

#[cfg(test)]
mod tests {
    use super::{
        crc16_modbus, frame_with_crc, parse_rtu_frame, RtuFrame, RTU_MIN_FRAME_LEN,
    };
    use crate::error::ParseError;

    // --- CRC reference vectors ---------------------------------------

    #[test]
    fn crc_empty_input_is_seed() {
        // CRC-16-Modbus seed is 0xFFFF; with no input the seed is
        // returned unchanged.
        assert_eq!(crc16_modbus(&[]), 0xFFFF);
    }

    #[test]
    fn crc_check_string_matches_canonical_value() {
        // The canonical CRC-16-Modbus check string is "123456789",
        // documented in CRC catalogues to produce 0x4B37.
        assert_eq!(crc16_modbus(b"123456789"), 0x4B37);
    }

    #[test]
    fn crc_classic_read_holding_request() {
        // Master asking unit 1 for 10 holding registers starting at
        // address 0x0000 — every Modbus tutorial uses this frame.
        // Expected CRC: 0xCDC5 (high byte 0xCD, low byte 0xC5).
        let body = [0x01_u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        assert_eq!(crc16_modbus(&body), 0xCDC5);
    }

    // --- Roundtrip via frame_with_crc + parse_rtu_frame -------------

    #[test]
    fn roundtrip_master_request() {
        let body = [0x01_u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        let wire = frame_with_crc(&body);
        // Wire order: body || CRC LO || CRC HI = 01 03 00 00 00 0A C5 CD
        assert_eq!(wire.as_slice(), &[0x01, 0x03, 0x00, 0x00, 0x00, 0x0A, 0xC5, 0xCD]);

        let parsed = parse_rtu_frame(&wire).unwrap();
        assert_eq!(
            parsed,
            RtuFrame {
                address: 0x01,
                pdu: &[0x03, 0x00, 0x00, 0x00, 0x0A],
            }
        );
    }

    #[test]
    fn roundtrip_response_with_two_registers() {
        // FC 0x03 response, byte_count=4, registers=[0x0064, 0x012C]
        // (two registers — a temperature + a humidity reading, say).
        let body = [0x01_u8, 0x03, 0x04, 0x00, 0x64, 0x01, 0x2C];
        let wire = frame_with_crc(&body);
        let parsed = parse_rtu_frame(&wire).unwrap();
        assert_eq!(parsed.address, 0x01);
        assert_eq!(parsed.pdu, &[0x03, 0x04, 0x00, 0x64, 0x01, 0x2C]);
    }

    // --- Failure paths -----------------------------------------------

    #[test]
    fn truncated_below_minimum() {
        // 3 bytes — even after the 2-byte CRC split there is no PDU.
        let wire = [0x01_u8, 0x03, 0x00];
        match parse_rtu_frame(&wire) {
            Err(ParseError::Truncated { needed }) => {
                // We do not assert an exact `needed` value here because
                // the parser surfaces the deficit at the layer where it
                // first ran out of bytes; just confirm it is non-zero.
                assert!(needed >= 1, "needed should be at least 1, got {needed}");
            }
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn truncated_two_bytes_total() {
        // Only the CRC bytes — no body whatsoever.
        let wire = [0x12_u8, 0x34];
        match parse_rtu_frame(&wire) {
            Err(ParseError::Truncated { needed }) => assert!(needed >= 1),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn truncated_zero_bytes() {
        match parse_rtu_frame(&[]) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 2),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn bad_crc_detected() {
        // Tamper one byte of the data after computing the CRC.
        let body = [0x01_u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        let mut wire = frame_with_crc(&body);
        // Flip a payload byte.
        wire[3] ^= 0xFF;
        match parse_rtu_frame(&wire) {
            Err(ParseError::BadChecksum { expected, got }) => {
                assert_ne!(expected, got, "CRC mismatch must report distinct values");
                // We computed expected over the (tampered) body and
                // got the original CRC from the wire.
                assert_eq!(got, u16::from_le_bytes([0xC5, 0xCD]));
            }
            other => panic!("expected BadChecksum, got {other:?}"),
        }
    }

    #[test]
    fn crc_byte_swap_detected() {
        // Swap CRC LO/HI on the wire — every byte on the wire is
        // legal, only the order is wrong.
        let body = [0x01_u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        let mut wire = frame_with_crc(&body);
        let len = wire.len();
        wire.swap(len - 2, len - 1);
        match parse_rtu_frame(&wire) {
            Err(ParseError::BadChecksum { .. }) => {}
            other => panic!("expected BadChecksum from byte-swap, got {other:?}"),
        }
    }

    #[test]
    fn min_frame_len_constant_matches_assertion() {
        // Sanity check — if anyone bumps the constant, this test makes
        // them re-justify it against the smallest legal frame.
        assert_eq!(RTU_MIN_FRAME_LEN, 4);
    }
}
