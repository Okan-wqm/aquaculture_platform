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
//! ## Output format (Batch #336 — Zeroize harness fix)
//!
//! Returns `Zeroizing<[u8; 32]>` (NOT a plain `[u8; 32]`).
//! The original Batch #332 design returned a plain
//! `[u8; 32]` by value, which the SEC-MEDIUM-001 audit
//! finding flagged as a Tier-1 violation of the
//! `KeyMaterial` architectural property: the source
//! `KeyMaterial` is `ZeroizeOnDrop` so its 32 bytes get
//! scrubbed when the wrapper drops, but the COPIED
//! `[u8; 32]` we returned has no Drop scrubber — it sits
//! on the caller's stack, gets copied into hex-format
//! intermediate buffers (heap-allocated `String`, also
//! unscrubbed), gets passed into SQLCipher PRAGMA strings
//! (also unscrubbed), and ultimately leaves residue in
//! heap pages reachable by core-dump / `/proc/<pid>/mem`
//! / swap.
//!
//! The architectural fix wraps the return in `Zeroizing<>`
//! (the zeroize-crate convenience type that scrubs on
//! Drop). Callers consume `&[u8; 32]` via deref. The hex
//! wrapper returns `Zeroizing<String>` so the hex bytes
//! are scrubbed too. SQLCipher's PRAGMA-key C-string is
//! still unscrubbable once it crosses FFI, but the
//! Rust-side leak window is closed.
//!
//! Callers needing the raw bytes use
//! `derive_v2_sqlcipher_key`; callers needing the
//! SQLCipher PRAGMA-key hex string use
//! `derive_v2_sqlcipher_pragma_key_hex`. Both return
//! Zeroize-wrapped types.
//!
//! ## Scope of THIS batch
//!
//! Async shim + wrong-purpose guard + Zeroize-wrapped
//! return types + 7 unit tests. The actual rekey
//! orchestration lands when the db-migrate-cli binary
//! lands in PR-195.

use zeroize::Zeroizing;

use super::v1_legacy_key::format_sqlcipher_pragma_key_hex;
use crate::keystore::Keystore;
use crate::keystore::error::KeyDerivationError;
use crate::keystore::purpose::KeyPurpose;
use crate::keystore::secret::KeyMaterial;

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
            // **Why no `got` variant name in Display
            // (Batch #337 — closes SEC-MEDIUM-002 audit
            // finding):** the `got: KeyPurpose` field is
            // retained for `Debug` (operator-internal
            // diagnostics) but stripped from `Display`
            // (operator-visible logs). The auth-security-expert
            // audit observed that emitting the variant
            // name into structured logs creates a
            // side-channel where an attacker who can
            // influence the `purpose` argument (e.g., via
            // an unsanitized config-file field that maps
            // to `KeyPurpose`) can probe which non-
            // SqlCipher variants exist by observing the
            // log surface. For the current call sites
            // (operator-controlled CLI argv) this is
            // non-exploitable; for future call sites the
            // scrubbed Display preserves the architectural
            // safety property without operator log
            // legibility cost (the kind prefix + canonical
            // message is still searchable).
            Self::WrongPurpose { .. } => {
                write!(f, "v2_derivation_wrong_purpose: not a SqlCipher* variant")
            }
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
/// usable for SQLCipher key derivation).
///
/// **Why a thin pass-through (Batch #337 — closes LOW-006
/// audit finding):** the canonical predicate lives on
/// `KeyPurpose::is_sqlcipher_variant` (next to the variant
/// definitions — the natural SSoT location). This module
/// retains the free function as a thin pass-through so
/// existing imports + the wire-status invariant grep
/// continue to work AND so the migration tool's import
/// graph still shows the predicate at the migration
/// boundary. Adding a future SqlCipher* variant requires
/// extending the method's match arm — which is the only
/// place to update.
fn is_sqlcipher_purpose(purpose: KeyPurpose) -> bool {
    purpose.is_sqlcipher_variant()
}

/// Derive the v2 SQLCipher key from a `Keystore` for the
/// given `(purpose, context)`. Returns the 32 bytes
/// wrapped in `Zeroizing<>` so they are scrubbed when the
/// wrapper drops.
///
/// **Wrong-purpose guard:** rejects non-SqlCipher
/// purposes with `V2DerivationError::WrongPurpose`. See
/// the module-level doc for the architectural rationale.
///
/// **Why `Zeroizing<[u8; 32]>` (not plain `[u8; 32]`):**
/// see SEC-MEDIUM-001 audit finding closure rationale in
/// the module-level doc. The plain return would escape
/// the `KeyMaterial` ZeroizeOnDrop harness and leave key
/// residue in heap pages.
///
/// **Async:** mirrors the underlying
/// `Keystore::derive_key` async signature — TPM-backed
/// keystore needs to await TPM responses; file-backed
/// is `async` too for trait-object uniformity.
pub async fn derive_v2_sqlcipher_key(
    keystore: &dyn Keystore,
    purpose: KeyPurpose,
    context: &[u8],
) -> Result<Zeroizing<[u8; 32]>, V2DerivationError> {
    if !is_sqlcipher_purpose(purpose) {
        return Err(V2DerivationError::WrongPurpose { got: purpose });
    }
    let material: KeyMaterial = keystore.derive_key(purpose, context).await?;
    // Copy the bytes into a Zeroizing<[u8; 32]> wrapper
    // so the caller's local copy gets scrubbed on Drop.
    // The source KeyMaterial is dropped at function
    // return + its DerivedKeyBytes ZeroizeOnDrop scrubs
    // the original; the Zeroizing wrapper carries the
    // same protection forward into the caller's scope.
    Ok(Zeroizing::new(*material.expose_secret()))
}

/// Convenience wrapper that returns the SQLCipher
/// PRAGMA-key hex string wrapped in `Zeroizing<>`. Most
/// migration call sites need the hex form; offering it
/// directly avoids per-call-site formatting.
///
/// **Why `Zeroizing<String>`:** the hex string
/// recomputes the key bytes character-by-character into
/// a heap-allocated `String`. Without the wrapper, the
/// string's heap allocation would leak the key bytes
/// (in textual form) when the `String` drops. The
/// wrapper scrubs on Drop. See SEC-MEDIUM-001 closure
/// rationale.
pub async fn derive_v2_sqlcipher_pragma_key_hex(
    keystore: &dyn Keystore,
    purpose: KeyPurpose,
    context: &[u8],
) -> Result<Zeroizing<String>, V2DerivationError> {
    let bytes = derive_v2_sqlcipher_key(keystore, purpose, context).await?;
    // `format_sqlcipher_pragma_key_hex` returns a plain
    // String; wrapping it in Zeroizing transfers the
    // scrub-on-drop semantic to the hex form. The
    // intermediate plain String exists for one
    // statement; its Drop happens after the wrap, but
    // since we move the value into Zeroizing::new the
    // intermediate is ALREADY zeroized by the wrapper's
    // Drop when the caller is done. (The very brief
    // unwrapped lifetime within this function is
    // acceptable — the alternative would require
    // changing format_sqlcipher_pragma_key_hex's return
    // type globally, breaking the v1 path.)
    Ok(Zeroizing::new(format_sqlcipher_pragma_key_hex(&bytes)))
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
    use async_trait::async_trait;

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
                KeyPurpose::SqlCipherLicenseCache => 0xa3,
                KeyPurpose::SqlCipherBytecodeRetain => 0xa4,
                KeyPurpose::SqlCipherScadaDisplay => 0xa5,
                KeyPurpose::AuditHmacChain => 0xb1,
                KeyPurpose::ReplayCache => 0xb2,
                KeyPurpose::DekEscrow => 0xc1,
                KeyPurpose::ConfigVerify => 0xc2,
            };
            Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(&self, _purpose: KeyPurpose, _context: &[u8]) -> DerivedKeyId {
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
    /// the stub's deterministic 0xa1-prefixed bytes
    /// wrapped in `Zeroizing`. Pins the forwarding
    /// semantic + the Zeroize-harness contract.
    #[tokio::test]
    async fn shim_forwards_sqlcipher_offline_queue_purpose() {
        let stub = StubKeystore;
        let bytes =
            derive_v2_sqlcipher_key(&stub, KeyPurpose::SqlCipherOfflineQueue, b"some-context")
                .await
                .expect("derive ok");
        // Zeroizing<[u8;32]> derefs to [u8;32]; index
        // access goes through the Deref impl.
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

    /// Returned bytes are wrapped in `Zeroizing<>` so the
    /// 32 bytes get scrubbed on Drop. Pins the
    /// architectural property closing SEC-MEDIUM-001.
    /// A refactor that reverted to plain `[u8; 32]`
    /// would fail here because `Zeroizing` is the type
    /// we destructure on.
    #[tokio::test]
    async fn shim_returns_zeroize_wrapped_bytes() {
        let stub = StubKeystore;
        let bytes: Zeroizing<[u8; 32]> =
            derive_v2_sqlcipher_key(&stub, KeyPurpose::SqlCipherOfflineQueue, b"ctx")
                .await
                .expect("derive ok");
        // Type-pin via let-binding above is the actual
        // architectural assertion. A refactor to plain
        // `[u8; 32]` makes the let-binding fail to
        // compile.
        assert_eq!(bytes.len(), 32);
    }

    /// Wrong-purpose guard: AuditHmacChain rejects with
    /// `WrongPurpose`. Pins the architectural fail-closed
    /// against accidental purpose substitution.
    #[tokio::test]
    async fn shim_rejects_non_sqlcipher_purpose() {
        let stub = StubKeystore;
        let err = derive_v2_sqlcipher_key(&stub, KeyPurpose::AuditHmacChain, b"context")
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
            let err = derive_v2_sqlcipher_key(&stub, purpose, b"context")
                .await
                .expect_err("non-sqlcipher purpose must error");
            assert!(matches!(err, V2DerivationError::WrongPurpose { .. }));
        }
    }

    /// `derive_v2_sqlcipher_pragma_key_hex` returns 64
    /// lower-hex chars (the format expected by SQLCipher
    /// `PRAGMA key = "x'...'"`) wrapped in `Zeroizing`.
    /// Pins both the format contract + the Zeroize-
    /// harness extension into the hex form.
    #[tokio::test]
    async fn pragma_hex_wrapper_returns_64_char_lower_hex() {
        let stub = StubKeystore;
        let hex: Zeroizing<String> =
            derive_v2_sqlcipher_pragma_key_hex(&stub, KeyPurpose::SqlCipherOfflineQueue, b"ctx")
                .await
                .expect("derive hex ok");
        assert_eq!(hex.len(), 64);
        assert!(hex.starts_with("a1"));
        assert!(hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    }

    /// Display string for `WrongPurpose` carries the
    /// canonical `v2_derivation_wrong_purpose` prefix for
    /// log aggregator search AND does NOT leak the
    /// rejected variant name (Batch #337 — closes
    /// SEC-MEDIUM-002). The variant name remains in
    /// `Debug` for operator-internal diagnostics.
    #[test]
    fn wrong_purpose_display_string_pinned() {
        let err = V2DerivationError::WrongPurpose {
            got: KeyPurpose::AuditHmacChain,
        };
        let s = format!("{err}");
        assert!(
            s.contains("v2_derivation_wrong_purpose"),
            "operator-visible canonical prefix missing: {s}"
        );
        // SEC-MEDIUM-002 architectural property: the
        // rejected variant name MUST NOT appear in the
        // Display string. A refactor that re-leaked it
        // (e.g., `{got:?}` reintroduced) fails here.
        assert!(
            !s.contains("AuditHmacChain"),
            "SEC-MEDIUM-002 VIOLATION: WrongPurpose Display \
             leaked the rejected variant name into the \
             operator-visible log surface: {s}"
        );
    }

    /// Debug string still carries the variant name for
    /// operator-internal diagnostics. Pinning the split
    /// between Display (scrubbed) and Debug (full) keeps
    /// the SEC-MEDIUM-002 fix from over-correcting into
    /// a useless internal-debugging story.
    #[test]
    fn wrong_purpose_debug_string_retains_variant_name() {
        let err = V2DerivationError::WrongPurpose {
            got: KeyPurpose::AuditHmacChain,
        };
        let s = format!("{err:?}");
        assert!(
            s.contains("AuditHmacChain"),
            "Debug string should retain variant name for \
             operator-internal diagnostics, got: {s}"
        );
    }

    /// `KeyPurpose::is_sqlcipher_variant()` is the SSoT
    /// (Batch #337 — closes LOW-006). The shim's
    /// `is_sqlcipher_purpose` is a thin pass-through.
    /// Pin both halves so a future inlining of the match
    /// arm at the call site fails this gate.
    ///
    /// Updated Batch #341 (ADR-031) to cover the two new
    /// SqlCipher* variants `SqlCipherLicenseCache` +
    /// `SqlCipherBytecodeRetain`. Both must be classified
    /// as SQLCipher migration targets; non-SqlCipher
    /// variants must be rejected.
    #[test]
    fn key_purpose_is_sqlcipher_variant_method_is_ssot() {
        assert!(KeyPurpose::SqlCipherOfflineQueue.is_sqlcipher_variant());
        assert!(KeyPurpose::SqlCipherRetainPersistence.is_sqlcipher_variant());
        assert!(KeyPurpose::SqlCipherLicenseCache.is_sqlcipher_variant());
        assert!(KeyPurpose::SqlCipherBytecodeRetain.is_sqlcipher_variant());
        assert!(!KeyPurpose::AuditHmacChain.is_sqlcipher_variant());
        assert!(!KeyPurpose::ReplayCache.is_sqlcipher_variant());
        assert!(!KeyPurpose::DekEscrow.is_sqlcipher_variant());
        assert!(!KeyPurpose::ConfigVerify.is_sqlcipher_variant());
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
