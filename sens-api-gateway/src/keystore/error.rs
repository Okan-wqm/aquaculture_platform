//! # Keystore error taxonomy
//!
//! **WHY structured errors:** keystore failures are life-cycle-critical — a
//! missed `TpmUnavailable` should degrade cleanly to `SystemdCreds`, not crash
//! the agent; a `MasterMissing` on boot should trigger provisioning, not panic.
//! The error taxonomy is part of the type-level control flow.
//!
//! **Tier hierarchy applied:**
//! - Tier-1 (`make-it-impossible`) — taxonomy lives in an enum, not in ad-hoc
//!   `anyhow::bail!` strings; exhaustive match prevents "forgot to handle
//!   `TpmSessionExpired`" silent drop.
//! - Tier-3 (`make-it-detectable`) — each variant carries context so audit
//!   trail can discriminate "TPM unresponsive" from "sealed blob tampered".
//!
//! **No `thiserror::Error` derive here** — Batch 4b types do not yet depend on
//! the `thiserror` crate to keep the dep graph minimal; manual `Display`/`Error`
//! impl is mechanical and matches the project's `security.rs` convention.

use std::fmt;

/// Top-level keystore errors — presented to consumers calling the
/// [`super::Keystore`] trait.
#[derive(Debug)]
pub struct KeystoreError {
    pub kind: KeystoreErrorKind,
    pub context: String,
}

impl KeystoreError {
    pub fn new(kind: KeystoreErrorKind, context: impl Into<String>) -> Self {
        Self { kind, context: context.into() }
    }
}

impl fmt::Display for KeystoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "keystore: {}: {}", self.kind, self.context)
    }
}

impl std::error::Error for KeystoreError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeystoreErrorKind {
    /// Master key not found (first-boot provisioning required).
    MasterMissing,

    /// Master found but unseal/decrypt failed — indicates tamper or
    /// PCR-policy drift (TPM re-seal needed).
    MasterUnsealFailed,

    /// TPM device absent or unresponsive at backend-select time.
    TpmUnavailable,

    /// TPM session expired mid-operation (transient; retry with re-auth).
    TpmSessionExpired,

    /// systemd-creds namespace not present / not readable.
    SystemdCredsUnavailable,

    /// File-backed path exists but acceptance token missing/expired/invalid.
    FileBackedAcceptanceMissing,

    /// Rotation failed partway — audit log has partial state; operator
    /// intervention required via compromise-response runbook.
    RotationFailed,

    /// Keystore is ready (happy path) — used only as a placeholder variant
    /// for consumers that need a "none" marker; normal Ok-path returns Ok(()).
    Unspecified,
}

impl fmt::Display for KeystoreErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::MasterMissing => "master_missing",
            Self::MasterUnsealFailed => "master_unseal_failed",
            Self::TpmUnavailable => "tpm_unavailable",
            Self::TpmSessionExpired => "tpm_session_expired",
            Self::SystemdCredsUnavailable => "systemd_creds_unavailable",
            Self::FileBackedAcceptanceMissing => "file_backed_acceptance_missing",
            Self::RotationFailed => "rotation_failed",
            Self::Unspecified => "unspecified",
        };
        f.write_str(s)
    }
}

/// Errors specific to the HKDF derivation path. Kept separate from
/// [`KeystoreError`] because derivation failures indicate BUGS (wrong info
/// length, caller passed empty context where required, HKDF library internal
/// error) — not operational state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyDerivationError {
    /// HKDF-Expand output length mismatch (library invariant breach).
    InvalidOutputLength { expected: usize, got: usize },

    /// Context bytes empty for a purpose that requires context (e.g.
    /// `SqlCipherOfflineQueue` requires deployment-instance UUID).
    ContextRequired,

    /// Context bytes exceed HKDF-Expand max length (255 * HashLen).
    ContextTooLarge { max: usize, got: usize },

    /// Master keystore returned an error while requesting the raw bytes.
    MasterAccessFailed,
}

impl fmt::Display for KeyDerivationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidOutputLength { expected, got } => {
                write!(f, "hkdf output length mismatch: expected {}, got {}", expected, got)
            }
            Self::ContextRequired => {
                f.write_str("hkdf context bytes required for this purpose")
            }
            Self::ContextTooLarge { max, got } => {
                write!(f, "hkdf context too large: max {} bytes, got {}", max, got)
            }
            Self::MasterAccessFailed => {
                f.write_str("master key access failed during derivation")
            }
        }
    }
}

impl std::error::Error for KeyDerivationError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// WHY: Display format is audit-surface; pin the string form.
    #[test]
    fn keystore_error_kind_display_snake_case() {
        assert_eq!(format!("{}", KeystoreErrorKind::MasterMissing), "master_missing");
        assert_eq!(
            format!("{}", KeystoreErrorKind::FileBackedAcceptanceMissing),
            "file_backed_acceptance_missing"
        );
    }

    /// WHY: KeystoreError formats consistently for log grep patterns.
    #[test]
    fn keystore_error_display_includes_kind_and_context() {
        let e = KeystoreError::new(KeystoreErrorKind::TpmUnavailable, "probe failed @ boot");
        let s = format!("{}", e);
        assert!(s.contains("tpm_unavailable"));
        assert!(s.contains("probe failed @ boot"));
        assert!(s.starts_with("keystore:"));
    }

    /// WHY: Both errors implement std::error::Error for `?` interop.
    #[test]
    fn errors_implement_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<KeystoreError>();
        assert_err::<KeyDerivationError>();
    }

    /// WHY: KeyDerivationError variants discriminate correctly.
    #[test]
    fn key_derivation_error_variants_distinct() {
        let a = KeyDerivationError::InvalidOutputLength { expected: 32, got: 31 };
        let b = KeyDerivationError::ContextRequired;
        assert_ne!(a, b);
        assert!(format!("{}", a).contains("expected 32"));
    }
}
