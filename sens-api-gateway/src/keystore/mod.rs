// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

//! # Keystore — master-key hierarchy types (ADR-018 §4, §5, §7)
//!
//! Batch 4b — **Pure type definitions**. No runtime behavior here; the TPM FFI,
//! systemd-creds IPC, Argon2id file-backed derivation, mlock/prctl/panic-hook,
//! and rotation scheduler land in Faz 2 Sprint 6.3 (`tpm.rs`, `systemd_creds.rs`,
//! `file_backed.rs`, `hardening.rs`, `rotation.rs`).
//!
//! ## Why the types-first split
//!
//! - Downstream modules (`authz::verify_manifest`, `audit::hmac_chain`,
//!   `offline_queue::open`, `updater::verify`, `license::verify`) reference the
//!   keystore shape BEFORE the keystore runtime exists. Shipping types first
//!   lets those modules compile against a stable signature.
//! - The invariants we want (sealed `KeyMaterial`, typestate `KeyPurpose`,
//!   `FileBackedAcceptance` ctor-gated) are all TYPE invariants — they must
//!   hold at **compile time**, not be retrofitted after the runtime lands.
//!
//! ## Defense-in-depth layering (FR4 Data Confidentiality)
//!
//! | Layer | Mechanism | Scope |
//! |-------|-----------|-------|
//! | 1 | TPM NV seal (`KeyBackend::Tpm`) | Attacker with SD-card extraction cannot read master key |
//! | 2 | systemd-creds (`KeyBackend::SystemdCreds`) | Same-host DAC boundary |
//! | 3 | Argon2id file (`KeyBackend::FileBacked`) | Operator-gated fallback only |
//! | A | `LimitCORE=0` (systemd, Batch 4a) | Key bytes never reach coredump |
//! | B | `prctl(PR_SET_DUMPABLE, 0)` (runtime, Batch 5) | Same, defense-in-depth |
//! | C | `mlock` (runtime, Batch 5) | Key bytes never swap to disk |
//! | D | Panic-hook zeroize + `process::abort()` (Batch 5) | No unwind → no stack key leak |
//! | E | `ZeroizeOnDrop` on `KeyMaterial` (this file) | Key wiped on normal drop |
//! | F | `secrecy::Secret` wrapper (this file) | Prevents accidental `Debug` / `Display` |
//!
//! ## Cross-ADR references
//!
//! - ADR-018 §4 "TPM → systemd-creds → file fallback"
//! - ADR-018 §5 "Argon2id parameters + operator-gated acceptance"
//! - ADR-018 §7 "In-process defense — mlock, prctl, panic hook, zeroize"
//! - ADR-020 §2 "Audit HMAC key derivation path from master"
//! - ADR-019 §3 "Firmware key usage does NOT touch master directly"

pub mod acceptance;
pub mod error;
pub mod purpose;
pub mod secret;
// Batch 82 Sprint 6.3 partial: file-backed Argon2id keystore
// backend. First of the three ADR-018 §4 backends to land
// (TPM + systemd-creds follow in Batches 83 + 84). Unblocks
// Sprint 6.2 Batch 80 master-key-derived audit HMAC.
pub mod file_backed;

pub use acceptance::{AcceptanceToken, FileBackedAcceptance, FileBackedAcceptanceError};
pub use error::{KeyDerivationError, KeystoreError, KeystoreErrorKind};
pub use file_backed::{Argon2idParams, FileBackedKeystore};
pub use purpose::{DerivedKeyId, KeyPurpose};
pub use secret::{KeyMaterial, MasterKeyMaterial};

use async_trait::async_trait;

/// Backend selection — runtime picks the first available in priority order.
///
/// **Why enum (not dyn):** backend choice is monotone — once bound, it must NOT
/// fall back silently mid-session (that would mask a compromise). We keep the
/// enum closed so every consumer exhaustively handles each arm.
///
/// **How to apply:** construction is gated by `KeyBackend::select()` (Batch 5),
/// which probes TPM presence → systemd-creds availability → file-backed (only
/// if `FileBackedAcceptance` succeeds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyBackend {
    /// TPM 2.0 sealed NV index (RPi CM4/5 onboard, or external TPM via I2C/SPI).
    /// PCR[0..7] bound — sealing broken by unsigned firmware, kernel, or initrd.
    Tpm,

    /// systemd-creds — per-unit encrypted credential store, TPM-sealed when
    /// TPM is present but addressed at a different abstraction layer
    /// (inherits systemd's PCR policy, not agent-managed).
    SystemdCreds,

    /// File-backed Argon2id KDF — explicitly operator-gated (ADR-018 §5).
    /// An unsigned `FileBackedAcceptance` is a compile-time construction
    /// error; operator MUST produce a signed acceptance token that expires.
    FileBacked,
}

/// Keystore abstraction — backends implement this, consumers depend on it.
///
/// **Why async:** TPM FFI is blocking (`tss-esapi` wraps `libtpms` which holds a
/// mutex across TPM transactions). Wrapping in `spawn_blocking` inside the trait
/// impl lets consumers stay on the tokio runtime without knowing the backend.
///
/// **Why `&self` (not `&mut self`):** the keystore is shared across tokio tasks
/// via `Arc<dyn Keystore>`. Interior mutability (if any — TPM session state,
/// rotation cache) is the impl's problem, not the contract's.
#[async_trait]
pub trait Keystore: Send + Sync + 'static {
    /// Report which backend is active (for audit + metrics).
    fn backend(&self) -> KeyBackend;

    /// Derive a purpose-scoped key from the master via HKDF-SHA256.
    ///
    /// **Invariant:** identical `(purpose, context)` inputs produce identical
    /// outputs; different purposes produce independent keys (HKDF-info domain
    /// separation). ADR-020 §2 replay cache + offline_queue key + audit HMAC
    /// key are each a separate purpose.
    async fn derive_key(
        &self,
        purpose: KeyPurpose,
        context: &[u8],
    ) -> Result<KeyMaterial, KeyDerivationError>;

    /// Return an opaque handle identifying the derived key (for audit trail).
    /// Implementations compute `SHA-256(purpose || context || 0x01)` and
    /// truncate to 16 bytes — enough to de-dup, not enough to brute-force back
    /// to purpose/context.
    fn derived_key_id(&self, purpose: KeyPurpose, context: &[u8]) -> DerivedKeyId;

    /// Rotate the master key. After this call:
    /// - NEW keys derive from the NEW master;
    /// - OLD derived keys still work for the grace window (see rotation.rs);
    /// - SQLCipher DBs must be re-keyed via `PRAGMA rekey` (Faz 2 Sprint 6.4);
    /// - derivation audit trail captures both pre + post master key IDs.
    ///
    /// **Default grace:** 180 days (ADR-018 §6). Compromise response shortens
    /// to 0 seconds with mandatory offline sync.
    async fn rotate_master(&self) -> Result<(), KeystoreError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WHY: KeyBackend must be `Copy` so consumers can pass it to metrics labels
    ///      and audit events without reference juggling.
    #[test]
    fn key_backend_is_copy() {
        fn takes_copy<T: Copy>() {}
        takes_copy::<KeyBackend>();
    }

    /// WHY: All three variants must be distinguishable at audit-time.
    #[test]
    fn key_backend_variants_distinct() {
        assert_ne!(KeyBackend::Tpm, KeyBackend::SystemdCreds);
        assert_ne!(KeyBackend::Tpm, KeyBackend::FileBacked);
        assert_ne!(KeyBackend::SystemdCreds, KeyBackend::FileBacked);
    }

    /// WHY: Pinned Debug shape — audit metric labels rely on Debug/Display for
    ///      Prometheus cardinality. `{:?}` must emit the canonical variant name.
    #[test]
    fn key_backend_debug_shape_pinned() {
        assert_eq!(format!("{:?}", KeyBackend::Tpm), "Tpm");
        assert_eq!(format!("{:?}", KeyBackend::SystemdCreds), "SystemdCreds");
        assert_eq!(format!("{:?}", KeyBackend::FileBacked), "FileBacked");
    }
}
