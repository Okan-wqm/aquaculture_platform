//! D-3 v2 keystore-derived SQLCipher key shim
//! (Batch #332).
//!
//! ## Why this module exists
//!
//! The v2 SQLCipher key derivation is structurally
//! `keystore.derive_key(KeyPurpose, &context_bytes)` —
//! a single call to the existing `Keystore` trait. So
//! why introduce a wrapper at all?
//!
//! **Architectural intent visibility.** The migration
//! tool's import graph should make the v1↔v2 symmetry
//! obvious: one call to `db_migration::v1_legacy_key`
//! computes the v1 key, one call to
//! `db_migration::v2_keystore_key` computes the v2 key,
//! and the rekey orchestration sits between them. A
//! direct call to `keystore.derive_key` from the
//! migration code would obscure the v1↔v2 framing — an
//! operator reading the rekey path would see "HMAC stuff
//! over here, generic keystore call over there" rather
//! than "v1 path / v2 path / rekey".
//!
//! **Wrong-purpose runtime guard.** `Keystore::derive_key`
//! accepts any `KeyPurpose` — an audit-HMAC variant
//! would compile + return 32 bytes that are CRYPTO-
//! GRAPHICALLY VALID but semantically WRONG for use as
//! a SQLCipher key. The shim rejects non-SqlCipher
//! purposes with a structured error so a refactor
//! mistake is caught at the migration boundary, not
//! discovered when the rekey'd DB silently fails to
//! open at next boot.
//!
//! **Future-proof isolation.** If the keystore trait
//! evolves (e.g., gains a fourth derivation parameter
//! for rotation-version, or splits derive_key into
//! synchronous / async variants), the migration tool's
//! call site is one shim — not N consumer call sites.
//!
//! ## Why NOT hard-code the consumer-purpose mapping here
//!
//! Each SQLCipher consumer's `KeyPurpose` + `context`
//! choice is defined by that consumer (per the
//! `KeyPurpose` enum's per-variant doc comments — e.g.,
//! `SqlCipherOfflineQueue` uses deployment-instance
//! UUID context, `SqlCipherRetainPersistence` uses
//! program-artifact-SHA256 context). The shim takes
//! `(purpose, context)` as caller-supplied inputs so
//! the consumer-migration arc (future batches) drives
//! the per-consumer choice at THAT consumer's call
//! site, which is where the deployment UUID / program
//! SHA is actually known.
//!
//! ## Output format
//!
//! Returns the raw 32 bytes (NOT the SQLCipher hex
//! string). Callers use `format_sqlcipher_pragma_key_hex`
//! from `v1_legacy_key.rs` to render the PRAGMA-key
//! string. The byte/hex split keeps the shim pure-bytes
//! (composable with future consumers that don't need
//! hex encoding).
//!
//! ## Scope of THIS batch
//!
//! Async shim + wrong-purpose guard + 3 unit tests
//! using a stub `Keystore` impl. The actual rekey
//! orchestration lands when the db-migrate-cli binary
//! lands in PR-195.

use async_trait::async_trait;

use super::v1_legacy_key::format_sqlcipher_pragma_key_hex;
use crate::keystore::error::KeyDerivationError;
use crate::keystore::purpose::KeyPurpose;
use crate::keystore::secret::KeyMaterial;
use crate::keystore::Keystore;

/// Shim error type. Wraps `KeyDerivationError` for the
/// keystore-side failures + adds a `WrongPurpose` variant
/// for the runtime guard documented in the module header.
#[derive(Debug)]
pub enum V2DerivationError {
    /// Caller passed a `KeyPurpose` that is NOT a
    /// SqlCipher* variant. The migration tool would
    /// silently rekey a SQLCipher DB with non-SQLCipher
    /// derivation bytes — the next DB open would fail
    /// with `database is encrypted or is not a database`.
    /// Fail-closed at the boundary.
    WrongPurpose { got: KeyPurpose },
    /// Underlying keystore reported a derivation failure.
    Keystore(KeyDerivationError),
}

impl std::fmt::Display for V2DerivationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongPurpose { got } => write!(
                f,
                "v2_derivation_wrong_purpose: expected SqlCipher* variant, got {got:?}"
            ),
            Self::Keystore(e) => {
                write!(f, "v2_derivation_keystore_error: {e}")
            }
        }
    }
}

impl std::error::Error for V2DerivationError {}

impl From<KeyDerivationError> for V2DerivationError {
    fn from(e: KeyDerivationError) -> Self {
        Self::Keystore(e)
    }
}

/// True iff the purpose is a SqlCipher* variant (i.e.,
/// usable for SQLCipher key derivation). Today this is
/// `SqlCipherOfflineQueue` + `SqlCipherRetainPersistence`;
/// a future v3 may add `SqlCipherLicenseCache` etc.
/// Centralizing the predicate here means the future v3
/// addition is a one-line change at this function plus
/// any new ADR-derived KeyPurpose variant.
fn is_sqlcipher_purpose(purpose: KeyPurpose) -> bool {
    matches!(
        purpose,
        KeyPurpose::SqlCipherOfflineQueue
            | KeyPurpose::SqlCipherRetainPersistence
    )
}

/// Derive the v2 SQLCipher key from a `Keystore` for the
/// given `(purpose, context)`. Returns raw 32 bytes.
///
/// **Wrong-purpose guard:** rejects non-SqlCipher
/// purposes with `V2DerivationError::WrongPurpose`. See
/// the module-level doc for the architectural rationale.
///
/// **Async:** mirrors the underlying
/// `Keystore::derive_key` async signature — TPM-backed
/// keystore needs to await TPM responses; file-backed
/// is `async` too for trait-object uniformity.
pub async fn derive_v2_sqlcipher_key(
    keystore: &dyn Keystore,
    purpose: KeyPurpose,
    context: &[u8],
) -> Result<[u8; 32], V2DerivationError> {
    if !is_sqlcipher_purpose(purpose) {
        return Err(V2DerivationError::WrongPurpose { got: purpose });
    }
    let material: KeyMaterial =
        keystore.derive_key(purpose, context).await?;
    // expose_secret() returns &[u8; 32]; we copy the
    // bytes into an owned array so the KeyMaterial's
    // ZeroizeOnDrop wrapper can free the underlying
    // memory when this function returns. The 32 bytes
    // we return are the caller's to own + the caller is
    // responsible for any subsequent zeroization.
    Ok(*material.expose_secret())
}

/// Convenience wrapper that returns the SQLCipher
/// PRAGMA-key hex string instead of raw bytes. Most
/// migration call sites need the hex form; offering it
/// directly avoids per-call-site formatting.
pub async fn derive_v2_sqlcipher_pragma_key_hex(
    keystore: &dyn Keystore,
    purpose: KeyPurpose,
    context: &[u8],
) -> Result<String, V2DerivationError> {
    let bytes =
        derive_v2_sqlcipher_key(keystore, purpose, context).await?;
    Ok(format_sqlcipher_pragma_key_hex(&bytes))
}

/// Stub keystore for unit testing the shim's
/// wrong-purpose guard + happy-path forwarding without
/// pulling in TPM / file-backed setup. The stub
/// implements only the trait methods the shim calls.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::error::{KeystoreError, KeystoreErrorKind};
    use crate::keystore::purpose::DerivedKeyId;
    use crate::keystore::{KeyBackend, RotationSource};

    /// Stub keystore. Returns a deterministic byte
    /// pattern based on the purpose so tests can verify
    /// the shim forwarded the right purpose without
    /// caring about real HKDF output.
    struct StubKeystore;

    #[async_trait]
    impl Keystore for StubKeystore {
        fn backend(&self) -> KeyBackend {
            KeyBackend::FileBacked
        }

        async fn derive_key(
            &self,
            purpose: KeyPurpose,
            _context: &[u8],
        ) -> Result<KeyMaterial, KeyDerivationError> {
            // Deterministic per-purpose pattern. We use
            // `from_derived_bytes` — this is `pub(crate)`
            // so we can call it from this in-crate test
            // module.
            let mut bytes = [0u8; 32];
            bytes[0] = match purpose {
                KeyPurpose::SqlCipherOfflineQueue => 0xa1,
                KeyPurpose::SqlCipherRetainPersistence => 0xa2,
                KeyPurpose::AuditHmacChain => 0xb1,
                KeyPurpose::ReplayCache => 0xb2,
                KeyPurpose::DekEscrow => 0xc1,
                KeyPurpose::ConfigVerify => 0xc2,
            };
            Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(
            &self,
            _purpose: KeyPurpose,
            _context: &[u8],
        ) -> DerivedKeyId {
            DerivedKeyId([0u8; 16])
        }

        async fn rotate_master(&self) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }

        async fn rotate_master_with_source(
            &self,
            _source: RotationSource<'_>,
        ) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }
    }

    /// Happy path: SqlCipherOfflineQueue purpose returns
    /// the stub's deterministic 0xa1-prefixed bytes.
    /// Pins the forwarding semantic.
    #[tokio::test]
    async fn shim_forwards_sqlcipher_offline_queue_purpose() {
        let stub = StubKeystore;
        let bytes = derive_v2_sqlcipher_key(
            &stub,
            KeyPurpose::SqlCipherOfflineQueue,
            b"some-context",
        )
        .await
        .expect("derive ok");
        assert_eq!(bytes[0], 0xa1);
    }

    /// SqlCipherRetainPersistence is also accepted —
    /// pins that the SqlCipher-purpose set is the union
    /// of all SqlCipher* variants, not just OfflineQueue.
    #[tokio::test]
    async fn shim_forwards_sqlcipher_retain_persistence_purpose() {
        let stub = StubKeystore;
        let bytes = derive_v2_sqlcipher_key(
            &stub,
            KeyPurpose::SqlCipherRetainPersistence,
            b"program-sha256-here",
        )
        .await
        .expect("derive ok");
        assert_eq!(bytes[0], 0xa2);
    }

    /// Wrong-purpose guard: AuditHmacChain rejects with
    /// `WrongPurpose`. Pins the architectural fail-closed
    /// against accidental purpose substitution.
    #[tokio::test]
    async fn shim_rejects_non_sqlcipher_purpose() {
        let stub = StubKeystore;
        let err = derive_v2_sqlcipher_key(
            &stub,
            KeyPurpose::AuditHmacChain,
            b"context",
        )
        .await
        .expect_err("non-sqlcipher purpose must error");
        match err {
            V2DerivationError::WrongPurpose { got } => {
                assert_eq!(got, KeyPurpose::AuditHmacChain);
            }
            other => panic!("expected WrongPurpose, got {:?}", other),
        }
    }

    /// All non-SqlCipher purposes rejected. Pins that
    /// adding a new KeyPurpose variant later won't
    /// silently slip through the guard — the
    /// `is_sqlcipher_purpose` predicate's match arm
    /// must explicitly include any new SqlCipher*
    /// variant + reject all non-SqlCipher* variants.
    #[tokio::test]
    async fn shim_rejects_all_non_sqlcipher_purposes() {
        let stub = StubKeystore;
        for purpose in [
            KeyPurpose::AuditHmacChain,
            KeyPurpose::ReplayCache,
            KeyPurpose::DekEscrow,
            KeyPurpose::ConfigVerify,
        ] {
            let err = derive_v2_sqlcipher_key(
                &stub,
                purpose,
                b"context",
            )
            .await
            .expect_err("non-sqlcipher purpose must error");
            assert!(matches!(
                err,
                V2DerivationError::WrongPurpose { .. }
            ));
        }
    }

    /// `derive_v2_sqlcipher_pragma_key_hex` returns 64
    /// lower-hex chars (the format expected by SQLCipher
    /// `PRAGMA key = "x'...'"`).
    #[tokio::test]
    async fn pragma_hex_wrapper_returns_64_char_lower_hex() {
        let stub = StubKeystore;
        let hex = derive_v2_sqlcipher_pragma_key_hex(
            &stub,
            KeyPurpose::SqlCipherOfflineQueue,
            b"ctx",
        )
        .await
        .expect("derive hex ok");
        assert_eq!(hex.len(), 64);
        assert!(hex.starts_with("a1"));
        assert!(hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    }

    /// Display string for `WrongPurpose` carries the
    /// canonical `v2_derivation_wrong_purpose` prefix
    /// for log aggregator search. Pins the operator-
    /// visible error surface.
    #[test]
    fn wrong_purpose_display_string_pinned() {
        let err = V2DerivationError::WrongPurpose {
            got: KeyPurpose::AuditHmacChain,
        };
        let s = format!("{err}");
        assert!(s.contains("v2_derivation_wrong_purpose"));
    }

    /// `From<KeyDerivationError>` implemented so the `?`
    /// operator works in caller paths.
    #[test]
    fn from_key_derivation_error_implemented() {
        let inner = KeyDerivationError::ContextRequired;
        let outer: V2DerivationError = inner.into();
        assert!(matches!(outer, V2DerivationError::Keystore(_)));
    }
}
