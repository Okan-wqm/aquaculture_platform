//! Modbus TCP frame decode (MBAP header + PDU dispatch).
//!
//! Frame on the wire:
//!
//! ```text
//!   0       1       2       3       4       5       6        7   ...
//!   +-------+-------+-------+-------+-------+-------+-------+--------+
//!   | transaction id| protocol id   | length        | unit  | PDU... |
//!   |     u16 BE    |     u16 BE    |     u16 BE    |  u8   |        |
//!   +-------+-------+-------+-------+-------+-------+-------+--------+
//!     0x0000 always for Modbus     length covers unit_id + PDU
//! ```
//!
//! `length` in the MBAP header is the count of bytes that FOLLOW it,
//! INCLUDING the unit id. The maximum legal Modbus PDU is 253 bytes
//! (MODBUS Application Protocol Specification V1.1b3 §4.1), so
//! `length` is bounded to `1..=254`.
//!
//! The decoder is intentionally lenient about EXTRA bytes after the
//! declared frame — streaming callers commonly pass a buffer that
//! contains the start of the next frame too, and the parser returns
//! the unconsumed tail in the second tuple slot.

use serde::{Deserialize, Serialize};

use crate::error::ParseError;

/// MBAP header is fixed-size: 7 bytes.
pub const MBAP_HEADER_LEN: usize = 7;

/// Per Modbus Application Protocol §4.1, the PDU is at most 253 bytes.
pub const MODBUS_PDU_MAX: u16 = 253;

/// Largest legal value of the MBAP `length` field — PDU max plus the
/// 1-byte unit id that the field also covers.
pub const MBAP_LENGTH_MAX: u16 = MODBUS_PDU_MAX + 1;

/// Decoded MBAP header — pure data, no references, cheap to clone.
///
/// `pdu_length` is derived from MBAP `length`: the wire field counts
/// the unit id plus the PDU together, so we subtract one to give
/// callers the PDU byte count directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MbapHeader {
    /// Transaction id, set by the requester, echoed by the responder.
    pub transaction_id: u16,
    /// Slave / unit id. `0xff` is the "any" unit per the spec.
    pub unit_id: u8,
    /// Number of bytes the PDU occupies, after the MBAP header.
    pub pdu_length: u16,
}

/// Decode the 7-byte MBAP header from `input` and return both the
/// header and the unconsumed tail (`input[7..]`).
///
/// Errors:
/// - [`ParseError::Truncated`] — `input.len() < 7`.
/// - [`ParseError::InvalidProtocolId`] — protocol id was not zero.
/// - [`ParseError::LengthMismatch`] — declared length was outside
///   `1..=MBAP_LENGTH_MAX`.
///
/// # Examples
///
/// ```
/// # // Doc-tests are a separate compilation unit and do not inherit the
/// # // crate's `#![cfg_attr(test, allow(...))]`; opt in inline so the
/// # // unwrap below does not trip clippy::unwrap_used (workspace deny).
/// # #![allow(clippy::unwrap_used)]
/// use protocol_codec::modbus::tcp::{parse_mbap_header, MbapHeader};
///
/// // Valid header for a Read Holding Registers request: txn=1, unit=1,
/// // length=6 (unit + 5-byte PDU).
/// let bytes = [0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x03, 0x00, 0x00, 0x00, 0x0a];
/// let (hdr, rest) = parse_mbap_header(&bytes).unwrap();
/// assert_eq!(
///     hdr,
///     MbapHeader { transaction_id: 1, unit_id: 1, pdu_length: 5 }
/// );
/// assert_eq!(rest, &[0x03, 0x00, 0x00, 0x00, 0x0a]);
/// ```
pub fn parse_mbap_header(input: &[u8]) -> Result<(MbapHeader, &[u8]), ParseError> {
    let Some((header, rest)) = input.split_first_chunk::<MBAP_HEADER_LEN>() else {
        // saturating_sub guards against the (impossible at this branch)
        // case where input.len() > MBAP_HEADER_LEN — clippy is happy,
        // arithmetic is panic-free.
        return Err(ParseError::Truncated {
            needed: MBAP_HEADER_LEN.saturating_sub(input.len()),
        });
    };
    let [t0, t1, p0, p1, l0, l1, unit_id] = *header;

    let protocol_id = u16::from_be_bytes([p0, p1]);
    if protocol_id != 0 {
        return Err(ParseError::InvalidProtocolId(protocol_id));
    }

    let length = u16::from_be_bytes([l0, l1]);
    if !(1..=MBAP_LENGTH_MAX).contains(&length) {
        return Err(ParseError::LengthMismatch {
            declared: length,
            max: MBAP_LENGTH_MAX,
        });
    }

    let transaction_id = u16::from_be_bytes([t0, t1]);
    // length covers the unit id + PDU. PDU length = length - 1, and
    // length >= 1 was just enforced above, so the subtraction cannot
    // underflow.
    let pdu_length = length - 1;

    Ok((
        MbapHeader {
            transaction_id,
            unit_id,
            pdu_length,
        },
        rest,
    ))
}

#[cfg(test)]
mod tests {
    use super::{MBAP_HEADER_LEN, MBAP_LENGTH_MAX, MbapHeader, parse_mbap_header};
    use crate::error::ParseError;

    fn build_header(txn: u16, length: u16, unit: u8) -> [u8; MBAP_HEADER_LEN] {
        let mut buf = [0u8; MBAP_HEADER_LEN];
        let txn_b = txn.to_be_bytes();
        let len_b = length.to_be_bytes();
        // protocol_id is zero by default.
        buf[0] = txn_b[0];
        buf[1] = txn_b[1];
        buf[4] = len_b[0];
        buf[5] = len_b[1];
        buf[6] = unit;
        buf
    }

    #[test]
    fn happy_path_minimum_length() {
        let bytes = build_header(0x1234, 1, 0xff);
        let (hdr, rest) = parse_mbap_header(&bytes).unwrap();
        assert_eq!(
            hdr,
            MbapHeader {
                transaction_id: 0x1234,
                unit_id: 0xff,
                pdu_length: 0
            }
        );
        assert!(rest.is_empty());
    }

    #[test]
    fn happy_path_maximum_length_with_pdu_tail() {
        let mut bytes = build_header(0x0001, MBAP_LENGTH_MAX, 0x01).to_vec();
        // PDU is 253 bytes; we put any payload — parser does not look
        // at it.
        bytes.extend(std::iter::repeat_n(0xaau8, 253));
        let (hdr, rest) = parse_mbap_header(&bytes).unwrap();
        assert_eq!(hdr.pdu_length, 253);
        assert_eq!(rest.len(), 253);
    }

    #[test]
    fn truncated_input_reports_byte_deficit() {
        let bytes = [0x00, 0x01, 0x00, 0x00]; // only 4 of the 7 needed
        match parse_mbap_header(&bytes) {
            Err(ParseError::Truncated { needed }) => assert_eq!(needed, 3),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn nonzero_protocol_id_is_rejected() {
        // protocol id field at offsets 2..4
        let bytes = [0x00, 0x01, 0xbe, 0xef, 0x00, 0x06, 0x01];
        match parse_mbap_header(&bytes) {
            Err(ParseError::InvalidProtocolId(id)) => assert_eq!(id, 0xbeef),
            other => panic!("expected InvalidProtocolId, got {other:?}"),
        }
    }

    #[test]
    fn length_zero_is_rejected() {
        let bytes = build_header(0x0001, 0, 0x01);
        match parse_mbap_header(&bytes) {
            Err(ParseError::LengthMismatch { declared, max }) => {
                assert_eq!(declared, 0);
                assert_eq!(max, MBAP_LENGTH_MAX);
            }
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }

    #[test]
    fn length_above_spec_max_is_rejected() {
        let bytes = build_header(0x0001, MBAP_LENGTH_MAX + 1, 0x01);
        match parse_mbap_header(&bytes) {
            Err(ParseError::LengthMismatch { declared, .. }) => {
                assert_eq!(declared, MBAP_LENGTH_MAX + 1);
            }
            other => panic!("expected LengthMismatch, got {other:?}"),
        }
    }
}
