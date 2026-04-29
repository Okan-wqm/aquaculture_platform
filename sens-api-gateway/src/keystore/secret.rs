//! # KeyMaterial — sealed secret bytes with Zeroize + purpose tag
//!
//! **WHY:** We need a type that carries 32 bytes of secret AND enforces three
//! compile-time properties:
//!
//! 1. **No accidental `Debug` / `Display` of the bytes** — `Debug` prints only
//!    the purpose tag + byte-length, never content.
//! 2. **`ZeroizeOnDrop`** — the secret is scrubbed whenever the value goes out
//!    of scope. Belt-and-braces with `LimitCORE=0` (Batch 4a) and in-process
//!    mlock/prctl (Batch 5) this means the secret never survives a process
//!    exit.
//! 3. **Access requires explicit intent** — `expose_secret()` is the only way
//!    to see the bytes; call sites become greppable.
//!
//! **Architectural positioning:** `secrecy::Secret<T>` (0.8 API; `SecretBox` is
//! a 0.9+ alias) gives us (1) + (3); `zeroize` derive on the inner struct gives
//! us (2). Neither alone is sufficient, so `KeyMaterial` wraps both and adds
//! the `KeyPurpose` tag.

use std::fmt;

use secrecy::{ExposeSecret, Secret};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::purpose::KeyPurpose;

/// The master key is 32 bytes (256-bit HKDF PRK). Separate newtype from
/// [`KeyMaterial`] because the master has STRONGER access rules: only the
/// keystore impl itself may call `expose_secret_crate()`; every consumer must
/// go through `Keystore::derive_key()`.
///
/// **Why not share with KeyMaterial:** if master and derived had the same type,
/// a bug in a consumer could accidentally call HKDF with master-as-both-IKM
/// AND info, producing key leakage. Splitting at the type level makes that
/// bug impossible to write (`MasterKeyMaterial` only exposes bytes to
/// `crate::keystore::...`).
pub struct MasterKeyMaterial {
    inner: Secret<MasterKeyBytes>,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct MasterKeyBytes([u8; 32]);

// secrecy 0.8 API correctness (EDGE-NIT-102 closure):
//   `Secret::new(T)` requires `T: Zeroize` — nothing else. `MasterKeyBytes`
//   derives Zeroize + ZeroizeOnDrop, which satisfies the bound. The
//   `CloneableSecret` trait is ONLY needed if `Secret<T>::clone()` is called;
//   this module never clones the wrapper, so Clone is not derived on the
//   inner byte types (dropping it closes a would-be key-bytes-copy path).
//   `.expose_secret()` returns `&T` (i.e. `&MasterKeyBytes`); the `.0` access
//   reaches the sealed `[u8; 32]` for HKDF derivation inside this crate.

impl fmt::Debug for MasterKeyMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never leak bytes — print only the type tag + length.
        f.debug_struct("MasterKeyMaterial")
            .field("bytes", &"<REDACTED 32 bytes>")
            .finish()
    }
}

impl MasterKeyMaterial {
    /// Construct from a 32-byte array. The input is copied into the internal
    /// `Secret<MasterKeyBytes>` and the caller's array is NOT zeroized —
    /// caller's responsibility to zeroize the source (typically coming from
    /// `Zeroizing<Vec<u8>>` in the TPM unseal path).
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self {
            inner: Secret::new(MasterKeyBytes(bytes)),
        }
    }

    /// Expose the master bytes — CRATE-PRIVATE. Only backends + HKDF derivation
    /// path may call this. Consumers use `Keystore::derive_key()` instead.
    ///
    /// **Grep-auditable:** every call site of `expose_secret_crate` lives in
    /// `src/keystore/*.rs`. A call site elsewhere is a code review flag.
    pub(crate) fn expose_secret_crate(&self) -> &[u8; 32] {
        &self.inner.expose_secret().0
    }
}

/// Derived key material — 32 bytes output of HKDF-Expand, tagged with its
/// [`KeyPurpose`] so the type system can distinguish an audit-HMAC key from
/// a SQLCipher key at compile time.
///
/// **Typestate note:** we carry `purpose` as a field rather than a type
/// parameter to keep ergonomics simple for Batch 4b. A future promotion to
/// `KeyMaterial<const P: KeyPurpose>` awaits const generics with enum
/// parameters. Until then, the field-based tag lets consumers
/// `assert_eq!(key.purpose(), KeyPurpose::AuditHmacChain)` as a runtime
/// check at construction sites.
pub struct KeyMaterial {
    purpose: KeyPurpose,
    inner: Secret<DerivedKeyBytes>,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct DerivedKeyBytes([u8; 32]);

impl fmt::Debug for KeyMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyMaterial")
            .field("purpose", &self.purpose)
            .field("bytes", &"<REDACTED 32 bytes>")
            .finish()
    }
}

impl KeyMaterial {
    /// Construct from a 32-byte HKDF-Expand output, tagged with the purpose
    /// used as the HKDF `info` parameter. Consumers obtain `KeyMaterial` ONLY
    /// via `Keystore::derive_key()`; this ctor is `pub(crate)` for that reason.
    pub(crate) fn from_derived_bytes(purpose: KeyPurpose, bytes: [u8; 32]) -> Self {
        Self {
            purpose,
            inner: Secret::new(DerivedKeyBytes(bytes)),
        }
    }

    /// Declared purpose — consumers assert on this at construction sites.
    pub fn purpose(&self) -> KeyPurpose {
        self.purpose
    }

    /// Expose the 32 secret bytes. Explicit by name ("expose_secret") so that
    /// grep audits can enumerate every consumption site.
    pub fn expose_secret(&self) -> &[u8; 32] {
        &self.inner.expose_secret().0
    }
}

// Serde is deliberately NOT implemented on KeyMaterial — serializing a key
// at a trust boundary is essentially never correct. DEK escrow uses a
// separate wrapped-bytes type (Faz 2 Sprint 6.3 `EscrowedKey`) which carries
// the ciphertext, not the plaintext key.

/// Raw 32-byte structure for wire-level transport (e.g. TPM seal blob load).
/// Implements `Zeroize` + `ZeroizeOnDrop` + `Serialize/Deserialize` for the
/// sealed-blob path only. NOT part of the public API.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(transparent)]
pub(crate) struct RawSecret32 {
    pub bytes: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WHY: Debug MUST NOT leak bytes — FR4 invariant. Redaction text pinned.
    #[test]
    fn master_key_debug_redacts_bytes() {
        let mk = MasterKeyMaterial::from_bytes([0xaa; 32]);
        let debug = format!("{:?}", mk);
        assert!(
            debug.contains("REDACTED"),
            "master debug must redact: {}",
            debug
        );
        assert!(
            !debug.contains("aa"),
            "master debug must not contain byte hex: {}",
            debug
        );
    }

    /// WHY: Derived KeyMaterial Debug — same invariant, with purpose visible.
    #[test]
    fn derived_key_debug_shows_purpose_redacts_bytes() {
        let k = KeyMaterial::from_derived_bytes(KeyPurpose::AuditHmacChain, [0x55; 32]);
        let debug = format!("{:?}", k);
        assert!(debug.contains("AuditHmacChain"));
        assert!(debug.contains("REDACTED"));
        assert!(!debug.contains("55"));
    }

    /// WHY: Purpose tag must survive from ctor to reader without modification.
    #[test]
    fn derived_key_preserves_purpose_tag() {
        let k = KeyMaterial::from_derived_bytes(KeyPurpose::ReplayCache, [0x01; 32]);
        assert_eq!(k.purpose(), KeyPurpose::ReplayCache);
    }

    /// WHY: Compile-time check that ZeroizeOnDrop is implemented on the
    ///      inner byte types. Regression guard for accidental derive removal.
    #[test]
    fn inner_byte_types_implement_zeroize_on_drop() {
        fn assert_zoz<T: ZeroizeOnDrop>() {}
        assert_zoz::<DerivedKeyBytes>();
        assert_zoz::<MasterKeyBytes>();
        assert_zoz::<RawSecret32>();
    }

    /// WHY: Expose-secret must return the exact bytes set by ctor. Smoke test
    ///      for the Secret round-trip.
    #[test]
    fn expose_secret_roundtrips_input_bytes() {
        let bytes = [0x42u8; 32];
        let k = KeyMaterial::from_derived_bytes(KeyPurpose::ConfigVerify, bytes);
        assert_eq!(k.expose_secret(), &bytes);
    }
}
