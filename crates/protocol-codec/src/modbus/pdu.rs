//! Modbus PDU (Protocol Data Unit) decoders.
//!
//! The PDU is the transport-independent payload that follows MBAP (TCP)
//! or `address` (RTU/ASCII). Function-code-specific decoders live here so
//! the same code is reused across all three transports.
//!
//! Coverage in this commit:
//!   - FC 0x03 Read Holding Registers — *response* PDU. The plan
//!     (`docs/plans/sensor-rust-migration/PLAN.md` § Faz 1) names this
//!     as the first decoder because it is the dominant ingestion path
//!     in production sensor traffic.
//!
//! Coverage planned for follow-on commits in this same PR:
//!   - FC 0x03 *request* (`start_addr`, `quantity`)
//!   - FC 0x04 Read Input Registers (response + request)
//!   - FC 0x06 Write Single Register (request + response)
//!   - FC 0x10 Write Multiple Registers (request + response)
//!   - Modbus exception responses (FC | 0x80, exception_code)

use serde::{Deserialize, Serialize};

use crate::error::ParseError;
use crate::modbus::{is_allowed_function_code, ALLOWED_FUNCTION_CODES};

/// Function code for Read Holding Registers.
pub const FC_READ_HOLDING_REGISTERS: u8 = 0x03;

/// Per Modbus Application Protocol §6.3, the response carries at most
/// 125 16-bit registers — i.e. 250 data bytes.
pub const READ_HOLDING_REGISTERS_MAX_BYTES: u8 = 250;

/// Decoded FC 0x03 (Read Holding Registers) response payload.
///
/// `registers` is owned (`Vec<u16>`) rather than borrowed because the
/// caller almost always wants to forward the values to a typed event,
/// not re-parse the raw bytes. Forcing a copy here keeps the caller's
/// downstream code free of lifetime juggling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadHoldingRegistersResponse {
    /// Decoded register values, in the order they appeared on the wire.
    pub registers: Vec<u16>,
}

/// Decode a Read Holding Registers response PDU.
///
/// Wire layout (per MAP §6.3):
///
/// ```text
///   0       1        2 ..       2+byte_count
///   +-------+--------+-----------------------+
///   |  FC   | byte_  |   register values     |
///   | 0x03  | count  |   (u16 BE per reg)    |
///   +-------+--------+-----------------------+
/// ```
///
/// `byte_count` MUST be even (2 bytes per register), in
/// `2..=READ_HOLDING_REGISTERS_MAX_BYTES`, and the body MUST contain
/// exactly that many bytes. Any deviation is a malformed frame and the
/// caller should drop it.
///
/// Errors:
/// - [`ParseError::Truncated`] — PDU shorter than the smallest valid
///   header (`FC` + `byte_count` + at least one register).
/// - [`ParseError::UnsupportedFunctionCode`] — first byte is not 0x03.
/// - [`ParseError::LengthMismatch`] — `byte_count` is zero, odd, or
///   beyond the spec maximum.
pub fn decode_read_holding_registers_response(
    pdu: &[u8],
) -> Result<ReadHoldingRegistersResponse, ParseError> {
    let Some((&fc, after_fc)) = pdu.split_first() else {
        // Smallest valid PDU is FC + byte_count + 2 register bytes = 4.
        return Err(ParseError::Truncated { needed: 4 });
    };
    if fc != FC_READ_HOLDING_REGISTERS {
        return Err(ParseError::UnsupportedFunctionCode(fc));
    }

    let Some((&byte_count, body)) = after_fc.split_first() else {
        return Err(ParseError::Truncated { needed: 3 });
    };

    if byte_count == 0
        || byte_count % 2 != 0
        || byte_count > READ_HOLDING_REGISTERS_MAX_BYTES
    {
        return Err(ParseError::LengthMismatch {
            declared: u16::from(byte_count),
            max: u16::from(READ_HOLDING_REGISTERS_MAX_BYTES),
        });
    }

    let needed = usize::from(byte_count);
    let Some(payload) = body.get(..needed) else {
        return Err(ParseError::Truncated {
            needed: needed.saturating_sub(body.len()),
        });
    };

    let register_count = needed / 2;
    let mut registers = Vec::with_capacity(register_count);
    for chunk in payload.chunks_exact(2) {
        // chunks_exact(2) yields slices of length exactly 2; the
        // pattern match cannot fail. Use the explicit pattern (not
        // .try_into()) so the compiler proves it for clippy.
        let &[hi, lo] = chunk else {
            return Err(ParseError::Malformed(
                "chunks_exact(2) yielded non-pair slice — should be unreachable",
            ));
        };
        registers.push(u16::from_be_bytes([hi, lo]));
    }

    Ok(ReadHoldingRegistersResponse { registers })
}

/// Sanity check: callers should not even attempt to dispatch a
/// non-whitelisted function code. Re-exposes the whitelist with a
/// `pdu`-level shorthand.
#[must_use]
pub fn is_pdu_function_code_allowed(fc: u8) -> bool {
    is_allowed_function_code(fc)
}

#[cfg(test)]
mod tests {
    use super::{
        decode_read_holding_registers_response, is_pdu_function_code_allowed,
        FC_READ_HOLDING_REGISTERS, READ_HOLDING_REGISTERS_MAX_BYTES,
    };
    use crate::error::ParseError;
    use crate::modbus::ALLOWED_FUNCTION_CODES;

    #[test]
    fn happy_single_register() {
        // FC=0x03, byte_count=2, value=0x1234
        let pdu = [0x03_u8, 0x02, 0x12, 0x34];
        let resp = decode_read_holding_registers_response(&pdu).unwrap();
        assert_eq!(resp.registers, vec![0x1234]);
    }

    #[test]
    fn happy_three_registers() {
        // 3 registers: 0x0001, 0x0002, 0x0003
        let pdu = [0x03_u8, 0x06, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03];
        let resp = decode_read_holding_registers_response(&pdu).unwrap();
        assert_eq!(resp.registers, vec![1, 2, 3]);
    }

    #[test]
    fn happy_max_size() {
        // 125 registers — the spec maximum.
        let mut pdu = vec![FC_READ_HOLDING_REGISTERS, READ_HOLDING_REGISTERS_MAX_BYTES];
        for i in 0_u16..125 {
            pdu.extend_from_slice(&i.to_be_bytes());
        }
        let resp = decode_read_holding_registers_response(&pdu).unwrap();
        assert_eq!(resp.registers.len(), 125);
        assert_eq!(resp.registers[0], 0);
        assert_eq!(resp.registers[124], 124);
    }

    #[test]
    fn empty_pdu_truncated() {
        match decode_read_holding_registers_response(&[]) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 4),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn fc_only_truncated() {
        match decode_read_holding_registers_response(&[FC_READ_HOLDING_REGISTERS]) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 3),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn wrong_fc_rejected() {
        // FC 0x04 (Read Input Registers) — would be valid for that
        // decoder but this one rejects it.
        let pdu = [0x04_u8, 0x02, 0x00, 0x00];
        match decode_read_holding_registers_response(&pdu) {
            Err(ParseError::UnsupportedFunctionCode(fc)) => assert_eq!(fc, 0x04),
            other => panic!("expected UnsupportedFunctionCode, got {other:?}"),
        }
    }

    #[test]
    fn diagnostic_fc_rejected() {
        // FC 0x08 (Diagnostics) — security-relevant pivot vector. The
        // module-level whitelist already rejects it; this test covers
        // the PDU decoder's defence-in-depth check.
        let pdu = [0x08_u8, 0x02, 0x00, 0x00];
        match decode_read_holding_registers_response(&pdu) {
            Err(ParseError::UnsupportedFunctionCode(fc)) => assert_eq!(fc, 0x08),
            other => panic!("expected UnsupportedFunctionCode, got {other:?}"),
        }
        assert!(!is_pdu_function_code_allowed(0x08));
    }

    #[test]
    fn byte_count_zero_rejected() {
        let pdu = [0x03_u8, 0x00];
        match decode_read_holding_registers_response(&pdu) {
            Err(ParseError::LengthMismatch { declared, max }) => {
                assert_eq!(declared, 0);
                assert_eq!(max, u16::from(READ_HOLDING_REGISTERS_MAX_BYTES));
            }
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }

    #[test]
    fn byte_count_odd_rejected() {
        // 3 bytes is not a whole number of u16 registers.
        let pdu = [0x03_u8, 0x03, 0x00, 0x00, 0x00];
        match decode_read_holding_registers_response(&pdu) {
            Err(ParseError::LengthMismatch { declared, .. }) => assert_eq!(declared, 3),
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }

    #[test]
    fn byte_count_above_spec_rejected() {
        let pdu = [0x03_u8, 252, 0x00, 0x00];
        match decode_read_holding_registers_response(&pdu) {
            Err(ParseError::LengthMismatch { declared, .. }) => assert_eq!(declared, 252),
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }

    #[test]
    fn body_shorter_than_byte_count() {
        // Declares 4 bytes but only supplies 2.
        let pdu = [0x03_u8, 0x04, 0x12, 0x34];
        match decode_read_holding_registers_response(&pdu) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 2),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn allowed_function_codes_roundtrip() {
        // Every whitelist entry passes the convenience predicate.
        for fc in ALLOWED_FUNCTION_CODES {
            assert!(is_pdu_function_code_allowed(fc), "{fc:#04x} should be allowed");
        }
    }
}
