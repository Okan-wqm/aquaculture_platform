//! Modbus codec — TCP, RTU, and ASCII transports.
//!
//! Faz 1 stage 1 (this commit) ships the `tcp` submodule end of the MBAP
//! header decode. RTU + ASCII land in follow-on commits of the same PR
//! (per the Faz 1 deliverable in `docs/plans/sensor-rust-migration/PLAN.md`).
//!
//! Public surface notes:
//!   - Every parser is a `fn(&[u8]) -> Result<(T, &[u8]), ParseError>`
//!     so callers can consume bytes off the front of a streaming buffer
//!     without re-allocating.
//!   - No transport I/O, no logging — pure decode. The caller decides
//!     whether to retry, drop, or audit.

pub mod ascii;
pub mod pdu;
pub mod rtu;
pub mod tcp;

/// Modbus function codes the gateway + sidecar both accept.
///
/// Whitelist matches `sens-api-gateway/src/modbus.rs` (referenced, not
/// copied — paralel agent ownership) and the broader Modbus security
/// posture (no diagnostics, no programming, no file record access).
pub const ALLOWED_FUNCTION_CODES: [u8; 8] = [
    0x01, // Read Coils
    0x02, // Read Discrete Inputs
    0x03, // Read Holding Registers
    0x04, // Read Input Registers
    0x05, // Write Single Coil
    0x06, // Write Single Register
    0x0f, // Write Multiple Coils
    0x10, // Write Multiple Registers
];

/// Returns `true` if `fc` is in the whitelist above.
#[must_use]
pub fn is_allowed_function_code(fc: u8) -> bool {
    ALLOWED_FUNCTION_CODES.contains(&fc)
}

#[cfg(test)]
mod tests {
    use super::{ALLOWED_FUNCTION_CODES, is_allowed_function_code};

    #[test]
    fn whitelist_size_matches_documented_eight() {
        assert_eq!(ALLOWED_FUNCTION_CODES.len(), 8);
    }

    #[test]
    fn diagnostics_codes_are_rejected() {
        // FC 0x07 (Read Exception Status), 0x08 (Diagnostics), 0x11
        // (Report Slave ID), 0x14/0x15 (File Record), 0x16
        // (Mask Write Register), 0x17 (Read/Write Multiple Registers),
        // 0x18 (Read FIFO Queue), 0x2b (Encapsulated Interface) all
        // sit outside the whitelist and are how an attacker would
        // pivot to device introspection.
        for fc in [0x07_u8, 0x08, 0x11, 0x14, 0x15, 0x16, 0x17, 0x18, 0x2b] {
            assert!(
                !is_allowed_function_code(fc),
                "FC {fc:#04x} must be rejected"
            );
        }
    }

    #[test]
    fn whitelist_codes_are_accepted() {
        for fc in ALLOWED_FUNCTION_CODES {
            assert!(is_allowed_function_code(fc));
        }
    }
}
