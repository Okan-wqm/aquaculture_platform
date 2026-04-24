//! UserTokenManifestStore — hot-reload atom for OPC UA credential
//! enrollment (Batch #245, Gap A-3b part 1).
//!
//! Parallel to [`super::manifest_runtime::RbacManifestStore`] but
//! deliberately narrower:
//!
//! - No disk-load path. The production surface for user-token
//!   manifest publish is MQTT `update_user_token_manifest` topic
//!   (Batch #246 ingress). First-boot enrollment stays empty until
//!   the cloud pushes the first verified manifest; the validator
//!   fails closed (CredentialMismatch) until that ingress completes.
//! - No `signing_pubkey_hex` plumbing or mode/enforcement routing.
//!   Signature verify is the caller's responsibility — the
//!   Batch #243 `verify_user_token_manifest` function is already
//!   the crypto gate; the store only accepts already-verified
//!   manifests via `ingest_verified`.
//!
//! ## Cached enrollment invariant
//!
//! The store holds the raw `UserTokenManifest` AND a pre-built
//! [`UserTokenEnrollment`] side-by-side. Each `ingest_verified` call
//! rebuilds the enrollment via [`UserTokenEnrollment::from_manifest`]
//! — Argon2id parameter parsing + NFKC normalization + DER prefix
//! validation happen ONCE per manifest swap, not once per login
//! attempt. Hot-reload atomically replaces BOTH the manifest and the
//! cached enrollment so readers never observe a stale cache against
//! a new manifest.
//!
//! ## Reader pattern
//!
//! Readers call `with_enrollment(|maybe_e| ...)` receiving a scoped
//! reference to the cached enrollment (or `None` if no manifest has
//! been ingested yet). The callback runs under the RwLock read guard;
//! the guard is dropped on callback return. Authentication attempts
//! that arrive during a hot-reload either see the old enrollment (if
//! they grabbed the read lock first) or the new enrollment (if the
//! writer won). Both outcomes are safe — no torn reads.
//!
//! ## Why not expose the full `Arc<UserTokenManifest>`
//!
//! A public `current() -> Arc<UserTokenManifest>` method would leak
//! the unsealed manifest body into arbitrary callers. The Tier-1
//! seal pattern (Batch #243 `pub(crate) manifest`) depends on the
//! body being reachable ONLY through `verify_user_token_manifest` OR
//! this runtime's explicit reader methods. Scoped `with_*` readers
//! keep the seal intact.
//!
//! ## Cross-references
//! - Batch #243 [`super::user_token_manifest`] — wire format +
//!   `verify_user_token_manifest` 7-gate verifier.
//! - Batch #244 [`crate::opc_ua_server_user_tokens::UserTokenEnrollment::from_manifest`]
//!   — the typed builder this store caches.
//! - Batch #245 next siblings: `UserTokenValidator` adapter (same
//!   file below) + hot-reload integration tests.

use std::sync::RwLock;

use super::user_token_manifest::UserTokenManifest;
use crate::opc_ua_server_user_tokens::{
    EnrollmentBuildError, UserTokenEnrollment,
};

/// Runtime atom holding the currently-active user-token manifest
/// AND the cached enrollment built from it.
///
/// The RwLock protects both fields as one unit — swap is atomic,
/// readers cannot observe mismatched pairs.
pub struct UserTokenManifestStore {
    inner: RwLock<Option<CachedEntry>>,
}

struct CachedEntry {
    #[allow(dead_code)]
    // Retained for audit / diagnostic introspection (future batch
    // may expose `with_manifest(|m| ...)` for admin panels); the
    // primary hot path consumes `enrollment` and does not re-read
    // the raw manifest per login.
    manifest: UserTokenManifest,
    enrollment: UserTokenEnrollment,
}

impl Default for UserTokenManifestStore {
    fn default() -> Self {
        Self::new()
    }
}

impl UserTokenManifestStore {
    /// Construct an empty store. First-boot shape — `with_enrollment`
    /// returns `None` until the first `ingest_verified` completes.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(None),
        }
    }

    /// Swap the active manifest + rebuild the cached enrollment
    /// atomically. Caller MUST have run `verify_user_token_manifest`
    /// on the source `SignedUserTokenManifest` first — this store
    /// does NOT re-verify (the signed-envelope seal + verifier are
    /// the canonical gate; duplicating them here would invite drift).
    ///
    /// Returns an error if the manifest passes verify but the
    /// builder rejects (e.g. duplicate normalized username, malformed
    /// PHC hash the cloud signer should have caught). On error the
    /// store state is LEFT UNCHANGED — old manifest keeps serving
    /// authentication attempts.
    pub fn ingest_verified(
        &self,
        manifest: UserTokenManifest,
    ) -> Result<(), EnrollmentBuildError> {
        let enrollment = UserTokenEnrollment::from_manifest(&manifest)?;
        let entry = CachedEntry {
            manifest,
            enrollment,
        };
        match self.inner.write() {
            Ok(mut guard) => {
                *guard = Some(entry);
                Ok(())
            }
            Err(poisoned) => {
                // RwLock poison — a previous writer panicked mid-swap.
                // Recover by taking the poisoned guard + overwriting.
                // Fail-closed on the next read attempt if this also
                // fails, but in practice RwLock::write only returns
                // Err on thread-panic, which is a fatal abort path.
                let mut guard = poisoned.into_inner();
                *guard = Some(entry);
                Ok(())
            }
        }
    }

    /// Clear the store — every subsequent `with_enrollment` returns
    /// `None`. Used by operator-triggered credential revocation flows
    /// when the cloud publishes an "empty" manifest (policy_version
    /// bump with zero bindings).
    pub fn clear(&self) {
        match self.inner.write() {
            Ok(mut guard) => *guard = None,
            Err(poisoned) => *poisoned.into_inner() = None,
        }
    }

    /// Run `f` against the cached enrollment under a read guard. `f`
    /// receives `Some(&enrollment)` when a manifest is active; `None`
    /// when the store is empty (first-boot or after `clear`).
    ///
    /// The closure runs UNDER the lock — keep it fast. The two
    /// current callers (`UserTokenValidator::validate_user_pass`
    /// + `validate_x509`) do exactly one lookup + return.
    pub fn with_enrollment<R>(
        &self,
        f: impl FnOnce(Option<&UserTokenEnrollment>) -> R,
    ) -> R {
        match self.inner.read() {
            Ok(guard) => f(guard.as_ref().map(|e| &e.enrollment)),
            Err(poisoned) => {
                let guard = poisoned.into_inner();
                f(guard.as_ref().map(|e| &e.enrollment))
            }
        }
    }

    /// Diagnostic — true when a manifest has been ingested.
    pub fn is_loaded(&self) -> bool {
        self.with_enrollment(|e| e.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::{OperatorId, TenantId};
    use crate::authz::user_token_manifest::{
        UserPassManifestBinding, UserTokenManifest, X509ManifestBinding,
    };
    use crate::opc_ua_server_user_tokens::Argon2idHash;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0xAA; 16])
    }

    fn op(b: u8) -> OperatorId {
        OperatorId::new_from_verified([b; 16])
    }

    fn phc(password: &[u8], salt: &str) -> String {
        Argon2idHash::for_test_hash(password, salt)
            .unwrap()
            .as_phc()
            .to_string()
    }

    fn manifest_v1() -> UserTokenManifest {
        UserTokenManifest {
            policy_version: 1,
            tenant_id: tenant(),
            manifest_valid_from_unix_secs: 1_700_000_000,
            manifest_valid_until_unix_secs: 1_800_000_000,
            user_pass_bindings: vec![UserPassManifestBinding {
                operator_id: op(1),
                username_normalized: "alice".to_string(),
                argon2id_phc: phc(b"pw-alice", "c2FsdHNhbHRzYWx0"),
            }],
            x509_bindings: vec![X509ManifestBinding {
                operator_id: op(2),
                issuer_cn: "hmi-01".to_string(),
                trust_anchor_der: {
                    let mut v = vec![0u8; 256];
                    v[0] = 0x30;
                    v
                },
            }],
        }
    }

    fn manifest_v2_bob_added() -> UserTokenManifest {
        let mut m = manifest_v1();
        m.policy_version = 2;
        m.user_pass_bindings.push(UserPassManifestBinding {
            operator_id: op(3),
            username_normalized: "bob".to_string(),
            argon2id_phc: phc(b"pw-bob", "c2FsdHNhbHRib2I"),
        });
        m
    }

    #[test]
    fn new_store_is_empty() {
        let s = UserTokenManifestStore::new();
        assert!(!s.is_loaded());
        s.with_enrollment(|e| assert!(e.is_none()));
    }

    #[test]
    fn default_ctor_produces_empty_store() {
        let s = UserTokenManifestStore::default();
        assert!(!s.is_loaded());
    }

    #[test]
    fn ingest_makes_enrollment_visible() {
        let s = UserTokenManifestStore::new();
        s.ingest_verified(manifest_v1()).unwrap();
        assert!(s.is_loaded());
        s.with_enrollment(|e| {
            let e = e.unwrap();
            assert_eq!(e.user_pass_count(), 1);
            assert_eq!(e.x509_count(), 1);
        });
    }

    #[test]
    fn ingest_replace_swaps_enrollment_atomically() {
        let s = UserTokenManifestStore::new();
        s.ingest_verified(manifest_v1()).unwrap();
        s.with_enrollment(|e| {
            assert_eq!(e.unwrap().user_pass_count(), 1);
        });

        s.ingest_verified(manifest_v2_bob_added()).unwrap();
        s.with_enrollment(|e| {
            // Hot-reload visible after second ingest.
            assert_eq!(e.unwrap().user_pass_count(), 2);
        });
    }

    #[test]
    fn ingest_rejects_malformed_binding_without_corrupting_store() {
        let s = UserTokenManifestStore::new();
        s.ingest_verified(manifest_v1()).unwrap();

        // Manifest with a corrupt PHC — ingest rejects, store keeps v1.
        let mut broken = manifest_v2_bob_added();
        broken.user_pass_bindings[1].argon2id_phc =
            "completely-malformed-phc".to_string();
        let err = s.ingest_verified(broken).unwrap_err();
        match err {
            EnrollmentBuildError::HashInvalid { operator_id, .. } => {
                assert_eq!(operator_id, op(3));
            }
            other => panic!("wrong variant: {:?}", other),
        }

        // Old (v1) enrollment still serves requests — store was not
        // partially mutated.
        s.with_enrollment(|e| {
            let e = e.unwrap();
            assert_eq!(e.user_pass_count(), 1);
            assert_eq!(e.x509_count(), 1);
        });
    }

    #[test]
    fn clear_empties_store() {
        let s = UserTokenManifestStore::new();
        s.ingest_verified(manifest_v1()).unwrap();
        assert!(s.is_loaded());
        s.clear();
        assert!(!s.is_loaded());
        s.with_enrollment(|e| assert!(e.is_none()));
    }

    #[test]
    fn with_enrollment_scope_is_short_lived() {
        // Regression check: the closure returns a value, not a
        // reference — so the read guard can drop immediately after.
        let s = UserTokenManifestStore::new();
        s.ingest_verified(manifest_v1()).unwrap();
        let user_pass_count = s.with_enrollment(|e| {
            e.map(|e| e.user_pass_count()).unwrap_or(0)
        });
        assert_eq!(user_pass_count, 1);
        // Holding no guard here; a subsequent ingest must not deadlock.
        s.ingest_verified(manifest_v2_bob_added()).unwrap();
    }

    #[test]
    fn send_sync_bounds_hold() {
        // The store must be Send + Sync so it can live in `Arc<>` and
        // be shared across the async runtime.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<UserTokenManifestStore>();
    }
}
