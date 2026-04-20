//! Error type shared across every codec module.
//!
//! All variants carry enough context (declared lengths, expected vs got
//! byte counts) to triage a parser failure straight from the audit log
//! without re-running the parser. `ParseError` is intentionally
//! `PartialEq + Eq` so callers can match exact variants in tests and
//! property tests can compare expected vs actual errors.

use thiserror::Error;

/// All ways a `protocol-codec` parser can refuse a frame.
///
/// Variants are kept fine-grained (rather than a single
/// `Invalid(String)`) because each one maps to a different operator
/// action: a `BadCrc` is a transport problem, an `UnsupportedFc` is a
/// device-side configuration drift, a `TenantMismatch` is a security
/// event.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum ParseError {
    /// Buffer ran out before the frame was complete.
    /// `needed` is how many additional bytes the parser would need to
    /// continue. Useful for callers that may stitch together partial
    /// reads from a streaming transport.
    #[error("frame truncated: needed {needed} more byte(s)")]
    Truncated {
        /// How many bytes short the buffer was.
        needed: usize,
    },

    /// Length-prefixed field declared a payload size the parser refuses.
    /// Either zero, or larger than the protocol's documented maximum.
    #[error("length field {declared} out of range (allowed 1..={max})")]
    LengthMismatch {
        /// Length value as it appeared on the wire.
        declared: u16,
        /// Largest length value the parser will accept.
        max: u16,
    },

    /// CRC / LRC / MIC verification failed — frame is corrupt or
    /// tampered with. Caller should drop the frame and (for
    /// `TenantMismatch`-class issues) emit an audit event.
    #[error("checksum mismatch: expected {expected:#06x}, got {got:#06x}")]
    BadChecksum {
        /// The checksum the parser computed over the frame body.
        expected: u16,
        /// The checksum that was on the wire.
        got: u16,
    },

    /// Function code is syntactically valid but not in this codec's
    /// allow-list. Modbus carries an explicit whitelist; calling code
    /// can decide whether to log + drop, or to forward (e.g. for a
    /// passive analyser).
    #[error("unsupported function code: {0:#04x}")]
    UnsupportedFunctionCode(u8),

    /// MBAP `protocol_id` field was non-zero. Modbus over TCP requires
    /// `0x0000`; any other value is either a different application
    /// protocol or a malformed frame.
    #[error("invalid Modbus protocol id: {0:#06x}")]
    InvalidProtocolId(u16),

    /// Per ADR-025 § Threat 2, the topic-derived tenant id and the
    /// payload-derived tenant id MUST agree. Any drift is treated as
    /// a security event and dropped.
    #[error("tenant id mismatch between topic and payload")]
    TenantMismatch,

    /// Catch-all for variants that need a structured reason but do not
    /// fit any of the above. Use sparingly; new failure classes should
    /// get their own variant once they appear twice.
    #[error("malformed frame: {0}")]
    Malformed(&'static str),
}

#[cfg(test)]
mod tests {
    use super::ParseError;

    #[test]
    fn display_messages_are_actionable() {
        // Each variant's Display output is what shows up in audit
        // logs; smoke-test that they include the discriminating
        // values rather than an opaque label.
        assert_eq!(
            ParseError::Truncated { needed: 5 }.to_string(),
            "frame truncated: needed 5 more byte(s)",
        );
        assert_eq!(
            ParseError::LengthMismatch {
                declared: 999,
                max: 254
            }
            .to_string(),
            "length field 999 out of range (allowed 1..=254)",
        );
        assert_eq!(
            ParseError::BadChecksum {
                expected: 0x1234,
                got: 0x5678
            }
            .to_string(),
            "checksum mismatch: expected 0x1234, got 0x5678",
        );
        assert_eq!(
            ParseError::UnsupportedFunctionCode(0x5a).to_string(),
            "unsupported function code: 0x5a",
        );
        assert_eq!(
            ParseError::InvalidProtocolId(0xbeef).to_string(),
            "invalid Modbus protocol id: 0xbeef",
        );
        assert_eq!(
            ParseError::TenantMismatch.to_string(),
            "tenant id mismatch between topic and payload",
        );
    }

    #[test]
    fn variants_compare_by_value() {
        assert_eq!(
            ParseError::Truncated { needed: 1 },
            ParseError::Truncated { needed: 1 },
        );
        assert_ne!(
            ParseError::Truncated { needed: 1 },
            ParseError::Truncated { needed: 2 },
        );
    }
}
