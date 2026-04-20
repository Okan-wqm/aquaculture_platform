//! Modbus PDU (Protocol Data Unit) decoders.
//!
//! The PDU is the transport-independent payload that follows MBAP (TCP)
//! or `address` (RTU/ASCII). Function-code-specific decoders live here so
//! the same code is reused across all three transports.
//!
//! Coverage:
//!   - FC 0x03 Read Holding Registers — response PDU.
//!   - FC 0x04 Read Input Registers — response PDU (identical wire shape
//!     to FC 0x03; shares the byte-array-to-Vec<u16> helper).
//!   - FC 0x06 Write Single Register — request / response (the two are
//!     wire-identical: server echoes the request).
//!   - FC 0x10 Write Multiple Registers — response only (request adds a
//!     trailing data block; ingestion path receives responses).
//!   - Modbus exception responses (FC | 0x80, exception_code).
//!
//! Read-holding / read-input *request* PDUs (FC + start_addr + quantity)
//! are intentionally NOT decoded here — they originate from the gateway
//! / control-plane, not from sensors. If a future control-plane Rust
//! component needs them, the encoder side belongs in this module too.

use serde::{Deserialize, Serialize};

use crate::error::ParseError;
use crate::modbus::is_allowed_function_code;

/// Function code for Read Holding Registers.
pub const FC_READ_HOLDING_REGISTERS: u8 = 0x03;

/// Function code for Read Input Registers.
pub const FC_READ_INPUT_REGISTERS: u8 = 0x04;

/// Function code for Write Single Register (request + response are
/// wire-identical — the server echoes the request).
pub const FC_WRITE_SINGLE_REGISTER: u8 = 0x06;

/// Function code for Write Multiple Registers.
pub const FC_WRITE_MULTIPLE_REGISTERS: u8 = 0x10;

/// Top bit set on the function-code byte signals a Modbus exception
/// response. The original FC is recovered as `byte & 0x7F`.
pub const FC_EXCEPTION_BIT: u8 = 0x80;

/// Per Modbus Application Protocol §6.3 / §6.4, both Read Holding and
/// Read Input responses carry at most 125 16-bit registers — i.e. 250
/// data bytes.
pub const READ_REGISTERS_MAX_BYTES: u8 = 250;

/// Backwards-compatibility alias for the original FC-0x03-specific name.
/// Newer code should use [`READ_REGISTERS_MAX_BYTES`].
pub const READ_HOLDING_REGISTERS_MAX_BYTES: u8 = READ_REGISTERS_MAX_BYTES;

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
    decode_register_array_response(pdu, FC_READ_HOLDING_REGISTERS)
        .map(|registers| ReadHoldingRegistersResponse { registers })
}

// -------------------------------------------------------------------
// FC 0x04 Read Input Registers — response
// -------------------------------------------------------------------

/// Decoded FC 0x04 (Read Input Registers) response payload.
///
/// Wire shape is identical to FC 0x03; the type is kept distinct so a
/// caller cannot accidentally route input-register data into a
/// holding-register storage path (and vice versa).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadInputRegistersResponse {
    /// Decoded register values, in wire order.
    pub registers: Vec<u16>,
}

/// Decode a Read Input Registers response PDU. See
/// [`decode_read_holding_registers_response`] — wire layout is identical,
/// only the function code byte differs (0x04 instead of 0x03).
pub fn decode_read_input_registers_response(
    pdu: &[u8],
) -> Result<ReadInputRegistersResponse, ParseError> {
    decode_register_array_response(pdu, FC_READ_INPUT_REGISTERS)
        .map(|registers| ReadInputRegistersResponse { registers })
}

// -------------------------------------------------------------------
// FC 0x06 Write Single Register — request / response (wire-identical)
// -------------------------------------------------------------------

/// Decoded FC 0x06 (Write Single Register). Request and response carry
/// the same five bytes: the server echoes the request verbatim, so a
/// passive analyser cannot tell which it just saw without checking the
/// transport direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteSingleRegister {
    /// Target register address.
    pub address: u16,
    /// Value written (or echoed).
    pub value: u16,
}

/// Decode a Write Single Register PDU.
///
/// Wire layout (per MAP §6.6):
///
/// ```text
///   0       1     2     3     4
///   +-------+-----+-----+-----+-----+
///   |  FC   |  addr     |  value    |
///   | 0x06  |  u16 BE   |  u16 BE   |
///   +-------+-----+-----+-----+-----+
/// ```
///
/// Errors:
/// - [`ParseError::Truncated`] — fewer than 5 bytes.
/// - [`ParseError::UnsupportedFunctionCode`] — first byte is not 0x06.
pub fn decode_write_single_register(pdu: &[u8]) -> Result<WriteSingleRegister, ParseError> {
    let Some((header, _)) = pdu.split_first_chunk::<5>() else {
        return Err(ParseError::Truncated {
            needed: 5_usize.saturating_sub(pdu.len()),
        });
    };
    let [fc, a0, a1, v0, v1] = *header;
    if fc != FC_WRITE_SINGLE_REGISTER {
        return Err(ParseError::UnsupportedFunctionCode(fc));
    }
    Ok(WriteSingleRegister {
        address: u16::from_be_bytes([a0, a1]),
        value: u16::from_be_bytes([v0, v1]),
    })
}

// -------------------------------------------------------------------
// FC 0x10 Write Multiple Registers — response
// -------------------------------------------------------------------

/// Decoded FC 0x10 (Write Multiple Registers) response. Carries only
/// the starting address and the count of registers written; the values
/// are not echoed (would defeat the purpose of compressing many writes
/// into one frame).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteMultipleRegistersResponse {
    /// First register address that was written.
    pub starting_address: u16,
    /// How many registers the server confirmed it wrote.
    pub quantity: u16,
}

/// Decode a Write Multiple Registers response PDU.
///
/// Wire layout (per MAP §6.12 response):
///
/// ```text
///   0       1     2     3     4
///   +-------+-----+-----+-----+-----+
///   |  FC   | starting  | quantity  |
///   | 0x10  | addr u16  | u16 BE    |
///   +-------+-----+-----+-----+-----+
/// ```
///
/// `quantity` MUST be in `1..=123` (per MAP — single PDU upper bound).
///
/// Errors:
/// - [`ParseError::Truncated`] — fewer than 5 bytes.
/// - [`ParseError::UnsupportedFunctionCode`] — first byte is not 0x10.
/// - [`ParseError::LengthMismatch`] — quantity outside `1..=123`.
pub fn decode_write_multiple_registers_response(
    pdu: &[u8],
) -> Result<WriteMultipleRegistersResponse, ParseError> {
    let Some((header, _)) = pdu.split_first_chunk::<5>() else {
        return Err(ParseError::Truncated {
            needed: 5_usize.saturating_sub(pdu.len()),
        });
    };
    let [fc, s0, s1, q0, q1] = *header;
    if fc != FC_WRITE_MULTIPLE_REGISTERS {
        return Err(ParseError::UnsupportedFunctionCode(fc));
    }
    let quantity = u16::from_be_bytes([q0, q1]);
    if !(1..=123).contains(&quantity) {
        return Err(ParseError::LengthMismatch {
            declared: quantity,
            max: 123,
        });
    }
    Ok(WriteMultipleRegistersResponse {
        starting_address: u16::from_be_bytes([s0, s1]),
        quantity,
    })
}

// -------------------------------------------------------------------
// Modbus exception responses (FC | 0x80)
// -------------------------------------------------------------------

/// Modbus exception codes (subset that surfaces on real devices). The
/// numeric value is the on-the-wire byte; unknown codes are wrapped in
/// [`ModbusException::Other`] rather than silently coerced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModbusException {
    /// 0x01 — function code not supported by the slave.
    IllegalFunction,
    /// 0x02 — start address + quantity walks past the slave's register map.
    IllegalDataAddress,
    /// 0x03 — value outside permitted range, or quantity is bogus.
    IllegalDataValue,
    /// 0x04 — slave hardware fault.
    ServerDeviceFailure,
    /// 0x05 — request accepted, server will take longer to respond.
    Acknowledge,
    /// 0x06 — slave busy, retry later.
    ServerDeviceBusy,
    /// 0x08 — non-volatile memory parity error.
    MemoryParityError,
    /// 0x0A — gateway misconfigured (target path unavailable).
    GatewayPathUnavailable,
    /// 0x0B — gateway target device failed to respond.
    GatewayTargetNoResponse,
    /// Anything else — surfaced verbatim so the caller can audit.
    Other(u8),
}

impl ModbusException {
    /// Decode a single exception-code byte.
    #[must_use]
    pub const fn from_byte(b: u8) -> Self {
        match b {
            0x01 => Self::IllegalFunction,
            0x02 => Self::IllegalDataAddress,
            0x03 => Self::IllegalDataValue,
            0x04 => Self::ServerDeviceFailure,
            0x05 => Self::Acknowledge,
            0x06 => Self::ServerDeviceBusy,
            0x08 => Self::MemoryParityError,
            0x0A => Self::GatewayPathUnavailable,
            0x0B => Self::GatewayTargetNoResponse,
            other => Self::Other(other),
        }
    }
}

/// Decoded Modbus exception response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExceptionResponse {
    /// Original function code (low 7 bits of the on-the-wire FC byte).
    pub original_function_code: u8,
    /// Exception code reported by the slave.
    pub exception: ModbusException,
}

/// Decode a Modbus exception response PDU.
///
/// Wire layout (per MAP §7):
///
/// ```text
///   0           1
///   +-----------+----------+
///   | FC | 0x80 | exc_code |
///   +-----------+----------+
/// ```
///
/// Returns `None` if the first byte does NOT have the exception bit
/// (`0x80`) set — caller can then dispatch to a normal-response decoder.
/// Returns `Some(Err(...))` only on truncation; an unknown exception
/// code is wrapped in [`ModbusException::Other`] rather than refused so
/// the caller can audit it.
pub fn decode_exception_response(pdu: &[u8]) -> Result<Option<ExceptionResponse>, ParseError> {
    let Some((&fc_byte, after_fc)) = pdu.split_first() else {
        return Err(ParseError::Truncated { needed: 2 });
    };
    if fc_byte & FC_EXCEPTION_BIT == 0 {
        return Ok(None);
    }
    let Some((&exc_byte, _)) = after_fc.split_first() else {
        return Err(ParseError::Truncated { needed: 1 });
    };
    Ok(Some(ExceptionResponse {
        original_function_code: fc_byte & 0x7F,
        exception: ModbusException::from_byte(exc_byte),
    }))
}

// -------------------------------------------------------------------
// Shared register-array helper (FC 0x03 + FC 0x04)
// -------------------------------------------------------------------

/// Decode a `FC || byte_count || u16_BE * N` PDU. Used by both
/// [`decode_read_holding_registers_response`] and
/// [`decode_read_input_registers_response`] — wire shape is identical.
fn decode_register_array_response(pdu: &[u8], expected_fc: u8) -> Result<Vec<u16>, ParseError> {
    let Some((&fc, after_fc)) = pdu.split_first() else {
        // Smallest valid PDU is FC + byte_count + 2 register bytes = 4.
        return Err(ParseError::Truncated { needed: 4 });
    };
    if fc != expected_fc {
        return Err(ParseError::UnsupportedFunctionCode(fc));
    }
    let Some((&byte_count, body)) = after_fc.split_first() else {
        return Err(ParseError::Truncated { needed: 3 });
    };
    if byte_count == 0 || byte_count % 2 != 0 || byte_count > READ_REGISTERS_MAX_BYTES {
        return Err(ParseError::LengthMismatch {
            declared: u16::from(byte_count),
            max: u16::from(READ_REGISTERS_MAX_BYTES),
        });
    }
    let needed = usize::from(byte_count);
    let Some(payload) = body.get(..needed) else {
        return Err(ParseError::Truncated {
            needed: needed.saturating_sub(body.len()),
        });
    };
    let mut registers = Vec::with_capacity(needed / 2);
    for chunk in payload.chunks_exact(2) {
        let &[hi, lo] = chunk else {
            return Err(ParseError::Malformed(
                "chunks_exact(2) yielded non-pair slice — should be unreachable",
            ));
        };
        registers.push(u16::from_be_bytes([hi, lo]));
    }
    Ok(registers)
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
        FC_READ_HOLDING_REGISTERS, READ_HOLDING_REGISTERS_MAX_BYTES,
        decode_read_holding_registers_response, is_pdu_function_code_allowed,
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
            assert!(
                is_pdu_function_code_allowed(fc),
                "{fc:#04x} should be allowed"
            );
        }
    }

    // -----------------------------------------------------------------
    // FC 0x04 Read Input Registers
    // -----------------------------------------------------------------

    #[test]
    fn fc04_happy_two_registers() {
        // FC=0x04, byte_count=4, registers=[0x00FA, 0x0064]
        let pdu = [0x04_u8, 0x04, 0x00, 0xFA, 0x00, 0x64];
        let resp = super::decode_read_input_registers_response(&pdu).unwrap();
        assert_eq!(resp.registers, vec![0x00FA, 0x0064]);
    }

    #[test]
    fn fc04_rejects_fc03_byte() {
        // Caller mistakenly hands us a holding-register response.
        let pdu = [0x03_u8, 0x02, 0x00, 0x00];
        match super::decode_read_input_registers_response(&pdu) {
            Err(ParseError::UnsupportedFunctionCode(fc)) => assert_eq!(fc, 0x03),
            other => panic!("expected UnsupportedFunctionCode, got {other:?}"),
        }
    }

    #[test]
    fn fc04_byte_count_odd_rejected() {
        let pdu = [0x04_u8, 0x03, 0x00, 0x00, 0x00];
        match super::decode_read_input_registers_response(&pdu) {
            Err(ParseError::LengthMismatch { declared, .. }) => assert_eq!(declared, 3),
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // FC 0x06 Write Single Register
    // -----------------------------------------------------------------

    #[test]
    fn fc06_happy() {
        // FC=0x06, addr=0x0010, value=0xABCD
        let pdu = [0x06_u8, 0x00, 0x10, 0xAB, 0xCD];
        let parsed = super::decode_write_single_register(&pdu).unwrap();
        assert_eq!(parsed.address, 0x0010);
        assert_eq!(parsed.value, 0xABCD);
    }

    #[test]
    fn fc06_truncated() {
        // 4 bytes — one short.
        let pdu = [0x06_u8, 0x00, 0x10, 0xAB];
        match super::decode_write_single_register(&pdu) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 1),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn fc06_wrong_fc() {
        let pdu = [0x10_u8, 0x00, 0x10, 0xAB, 0xCD];
        match super::decode_write_single_register(&pdu) {
            Err(ParseError::UnsupportedFunctionCode(fc)) => assert_eq!(fc, 0x10),
            other => panic!("expected UnsupportedFunctionCode, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // FC 0x10 Write Multiple Registers (response)
    // -----------------------------------------------------------------

    #[test]
    fn fc10_response_happy() {
        // FC=0x10, start=0x0001, qty=0x0002
        let pdu = [0x10_u8, 0x00, 0x01, 0x00, 0x02];
        let parsed = super::decode_write_multiple_registers_response(&pdu).unwrap();
        assert_eq!(parsed.starting_address, 0x0001);
        assert_eq!(parsed.quantity, 0x0002);
    }

    #[test]
    fn fc10_zero_quantity_rejected() {
        let pdu = [0x10_u8, 0x00, 0x01, 0x00, 0x00];
        match super::decode_write_multiple_registers_response(&pdu) {
            Err(ParseError::LengthMismatch { declared, max }) => {
                assert_eq!(declared, 0);
                assert_eq!(max, 123);
            }
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }

    #[test]
    fn fc10_above_spec_max_rejected() {
        // 124 > 123 (single-PDU upper bound)
        let pdu = [0x10_u8, 0x00, 0x01, 0x00, 0x7C];
        match super::decode_write_multiple_registers_response(&pdu) {
            Err(ParseError::LengthMismatch { declared, max }) => {
                assert_eq!(declared, 124);
                assert_eq!(max, 123);
            }
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // Exception responses
    // -----------------------------------------------------------------

    #[test]
    fn exception_for_fc03_illegal_data_address() {
        // FC | 0x80 = 0x83 (exception to FC 0x03), exception_code=0x02
        let pdu = [0x83_u8, 0x02];
        let exc = super::decode_exception_response(&pdu).unwrap().unwrap();
        assert_eq!(exc.original_function_code, 0x03);
        assert_eq!(exc.exception, super::ModbusException::IllegalDataAddress);
    }

    #[test]
    fn exception_unknown_code_preserved_verbatim() {
        // exception_code=0x42 — not in the well-known set; surfaced as Other.
        let pdu = [0x86_u8, 0x42];
        let exc = super::decode_exception_response(&pdu).unwrap().unwrap();
        assert_eq!(exc.original_function_code, 0x06);
        assert_eq!(exc.exception, super::ModbusException::Other(0x42));
    }

    #[test]
    fn non_exception_pdu_returns_none() {
        // Top bit clear => not an exception. Caller should dispatch elsewhere.
        let pdu = [0x03_u8, 0x02, 0x00, 0x00];
        assert_eq!(super::decode_exception_response(&pdu).unwrap(), None);
    }

    #[test]
    fn exception_truncated_one_byte() {
        // Just the exception FC, no exception_code byte.
        let pdu = [0x83_u8];
        match super::decode_exception_response(&pdu) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 1),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn exception_empty_pdu_truncated() {
        match super::decode_exception_response(&[]) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 2),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn modbus_exception_from_byte_known_codes() {
        use super::ModbusException::{
            Acknowledge, GatewayPathUnavailable, GatewayTargetNoResponse, IllegalDataAddress,
            IllegalDataValue, IllegalFunction, MemoryParityError, ServerDeviceBusy,
            ServerDeviceFailure,
        };
        assert_eq!(super::ModbusException::from_byte(0x01), IllegalFunction);
        assert_eq!(super::ModbusException::from_byte(0x02), IllegalDataAddress);
        assert_eq!(super::ModbusException::from_byte(0x03), IllegalDataValue);
        assert_eq!(super::ModbusException::from_byte(0x04), ServerDeviceFailure);
        assert_eq!(super::ModbusException::from_byte(0x05), Acknowledge);
        assert_eq!(super::ModbusException::from_byte(0x06), ServerDeviceBusy);
        assert_eq!(super::ModbusException::from_byte(0x08), MemoryParityError);
        assert_eq!(
            super::ModbusException::from_byte(0x0A),
            GatewayPathUnavailable
        );
        assert_eq!(
            super::ModbusException::from_byte(0x0B),
            GatewayTargetNoResponse
        );
    }
}
