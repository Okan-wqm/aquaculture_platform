//! Panic-safe binary protocol reader primitives.
//!
//! 2026-05-01: External PLC, Modbus, LoRa, mTLS, audit and persistence payloads
//! must be decoded through checked cursors instead of unchecked indexing because
//! the edge agent is built with `panic = "abort"`.

use std::convert::TryFrom;
use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolReadError {
    UnexpectedEof {
        context: &'static str,
        needed: usize,
        remaining: usize,
        offset: usize,
    },
    InvalidLength {
        context: &'static str,
        len: usize,
    },
    InvalidDiscriminator {
        context: &'static str,
        value: u64,
    },
}

impl Display for ProtocolReadError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEof {
                context,
                needed,
                remaining,
                offset,
            } => write!(
                f,
                "{context}: unexpected end of input at offset {offset}; needed {needed} bytes, remaining {remaining}"
            ),
            Self::InvalidLength { context, len } => {
                write!(f, "{context}: invalid length {len}")
            }
            Self::InvalidDiscriminator { context, value } => {
                write!(f, "{context}: invalid discriminator {value}")
            }
        }
    }
}

impl Error for ProtocolReadError {}

pub type ProtocolReadResult<T> = Result<T, ProtocolReadError>;

#[derive(Debug, Clone, Copy)]
pub struct ProtocolReader<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> ProtocolReader<'a> {
    pub const fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    pub const fn position(&self) -> usize {
        self.offset
    }

    pub fn remaining(&self) -> usize {
        self.input.len().saturating_sub(self.offset)
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    // 2026-05-02: Protocol parsers need a safe view of unread bytes when delegating
    // nested structures to another decoder without reopening unchecked slices.
    pub fn remaining_slice(&self) -> &'a [u8] {
        self.input.get(self.offset..).unwrap_or(&[])
    }

    // 2026-05-02: Header parsers often contain reserved fields; skipping through the
    // same checked cursor keeps those fields bounded and auditable.
    pub fn skip(&mut self, len: usize, context: &'static str) -> ProtocolReadResult<()> {
        self.take(len, context).map(|_| ())
    }

    pub fn read_u8(&mut self, context: &'static str) -> ProtocolReadResult<u8> {
        let bytes = self.take_array::<1>(context)?;
        Ok(u8::from_le_bytes(bytes))
    }

    // 2026-05-02: Wire booleans are represented as u8 in OPC UA/S7-adjacent payloads;
    // this keeps the semantic conversion centralized instead of repeated ad hoc checks.
    pub fn read_bool_u8(&mut self, context: &'static str) -> ProtocolReadResult<bool> {
        Ok(self.read_u8(context)? != 0)
    }

    pub fn read_i8(&mut self, context: &'static str) -> ProtocolReadResult<i8> {
        let bytes = self.take_array::<1>(context)?;
        Ok(i8::from_le_bytes(bytes))
    }

    pub fn read_u16_le(&mut self, context: &'static str) -> ProtocolReadResult<u16> {
        Ok(u16::from_le_bytes(self.take_array::<2>(context)?))
    }

    pub fn read_u16_be(&mut self, context: &'static str) -> ProtocolReadResult<u16> {
        Ok(u16::from_be_bytes(self.take_array::<2>(context)?))
    }

    pub fn read_i16_le(&mut self, context: &'static str) -> ProtocolReadResult<i16> {
        Ok(i16::from_le_bytes(self.take_array::<2>(context)?))
    }

    pub fn read_i16_be(&mut self, context: &'static str) -> ProtocolReadResult<i16> {
        Ok(i16::from_be_bytes(self.take_array::<2>(context)?))
    }

    pub fn read_u32_le(&mut self, context: &'static str) -> ProtocolReadResult<u32> {
        Ok(u32::from_le_bytes(self.take_array::<4>(context)?))
    }

    pub fn read_u32_be(&mut self, context: &'static str) -> ProtocolReadResult<u32> {
        Ok(u32::from_be_bytes(self.take_array::<4>(context)?))
    }

    pub fn read_i32_le(&mut self, context: &'static str) -> ProtocolReadResult<i32> {
        Ok(i32::from_le_bytes(self.take_array::<4>(context)?))
    }

    pub fn read_i32_be(&mut self, context: &'static str) -> ProtocolReadResult<i32> {
        Ok(i32::from_be_bytes(self.take_array::<4>(context)?))
    }

    pub fn read_u64_le(&mut self, context: &'static str) -> ProtocolReadResult<u64> {
        Ok(u64::from_le_bytes(self.take_array::<8>(context)?))
    }

    pub fn read_u64_be(&mut self, context: &'static str) -> ProtocolReadResult<u64> {
        Ok(u64::from_be_bytes(self.take_array::<8>(context)?))
    }

    pub fn read_i64_le(&mut self, context: &'static str) -> ProtocolReadResult<i64> {
        Ok(i64::from_le_bytes(self.take_array::<8>(context)?))
    }

    pub fn read_i64_be(&mut self, context: &'static str) -> ProtocolReadResult<i64> {
        Ok(i64::from_be_bytes(self.take_array::<8>(context)?))
    }

    pub fn read_f32_le(&mut self, context: &'static str) -> ProtocolReadResult<f32> {
        Ok(f32::from_le_bytes(self.take_array::<4>(context)?))
    }

    pub fn read_f32_be(&mut self, context: &'static str) -> ProtocolReadResult<f32> {
        Ok(f32::from_be_bytes(self.take_array::<4>(context)?))
    }

    pub fn read_f64_le(&mut self, context: &'static str) -> ProtocolReadResult<f64> {
        Ok(f64::from_le_bytes(self.take_array::<8>(context)?))
    }

    pub fn read_f64_be(&mut self, context: &'static str) -> ProtocolReadResult<f64> {
        Ok(f64::from_be_bytes(self.take_array::<8>(context)?))
    }

    pub fn take(
        &mut self,
        len: usize,
        context: &'static str,
    ) -> ProtocolReadResult<&'a [u8]> {
        let end = self.offset.checked_add(len).ok_or(ProtocolReadError::InvalidLength {
            context,
            len,
        })?;
        let slice = self
            .input
            .get(self.offset..end)
            .ok_or_else(|| ProtocolReadError::UnexpectedEof {
                context,
                needed: len,
                remaining: self.remaining(),
                offset: self.offset,
            })?;
        self.offset = end;
        Ok(slice)
    }

    pub fn take_array<const N: usize>(
        &mut self,
        context: &'static str,
    ) -> ProtocolReadResult<[u8; N]> {
        let slice = self.take(N, context)?;
        <[u8; N]>::try_from(slice).map_err(|_| ProtocolReadError::InvalidLength {
            context,
            len: slice.len(),
        })
    }

    // 2026-05-02: OPC UA nullable ByteString/String fields use 0xFFFF_FFFF as null;
    // this helper makes null vs empty vs truncated fields explicit at the boundary.
    pub fn read_nullable_bytes_u32_le(
        &mut self,
        context: &'static str,
    ) -> ProtocolReadResult<Option<&'a [u8]>> {
        let len = self.read_u32_le(context)?;
        if len == u32::MAX {
            return Ok(None);
        }
        Ok(Some(self.take(len as usize, context)?))
    }

    // 2026-05-02: OPC UA String decoding belongs in the checked reader so every
    // service parser gets the same UTF-8-lossy, bounds-checked behavior.
    pub fn read_nullable_string_u32_le(
        &mut self,
        context: &'static str,
    ) -> ProtocolReadResult<Option<String>> {
        Ok(self
            .read_nullable_bytes_u32_le(context)?
            .map(|bytes| String::from_utf8_lossy(bytes).to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_exact_advances_cursor() {
        let mut reader = ProtocolReader::new(&[0x34, 0x12, 0xAA]);
        assert_eq!(reader.read_u16_le("u16").unwrap(), 0x1234);
        assert_eq!(reader.position(), 2);
        assert_eq!(reader.read_u8("tail").unwrap(), 0xAA);
        assert!(reader.is_empty());
    }

    #[test]
    fn truncated_read_returns_typed_error() {
        let mut reader = ProtocolReader::new(&[0x01]);
        let err = reader.read_u32_le("frame.len").unwrap_err();
        assert_eq!(
            err,
            ProtocolReadError::UnexpectedEof {
                context: "frame.len",
                needed: 4,
                remaining: 1,
                offset: 0,
            }
        );
    }
}
