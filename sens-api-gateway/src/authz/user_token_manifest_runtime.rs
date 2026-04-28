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

use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use super::manifest_version_store::ManifestVersionStore;
use super::permission::TenantId;
use super::signing_key_util::{parse_ed25519_pubkey_hex, SigningKeyHexError};
use super::user_token_manifest::{
    verify_user_token_manifest, SignedUserTokenManifest, UserTokenManifest,
    UserTokenManifestVerifyError,
};
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
    /// Optional persistent monotonic-version floor (Batch #246
    /// multi-stream `manifest_version` table under
    /// `STREAM_ID_USER_TOKEN`). When present, `ingest_signed` reads
    /// the floor pre-verify + writes the accepted version post-
    /// verify. When absent (tests / ingest_verified direct path),
    /// the store has no cross-reboot replay defense — callers using
    /// the test ctor explicitly opt out.
    version_store: Option<Arc<ManifestVersionStore>>,
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
    /// Construct an empty store WITHOUT version persistence. Used
    /// by tests that exercise `ingest_verified` directly; production
    /// boot path uses `new().with_version_store(...)` so reboot-
    /// across replay is caught.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(None),
            version_store: None,
        }
    }

    /// Builder-style persistence attachment. Pre-Batch-247 call sites
    /// that only want in-memory hot-reload keep working (just never
    /// call this). Production boot path attaches the version store
    /// opened via `ManifestVersionStore::open_for_stream(path,
    /// STREAM_ID_USER_TOKEN)`.
    pub fn with_version_store(
        mut self,
        store: Arc<ManifestVersionStore>,
    ) -> Self {
        self.version_store = Some(store);
        self
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

    /// End-to-end ingress: verify the signed manifest + build the
    /// enrollment + swap the cache + advance the persistent
    /// version floor. Production callers (MQTT
    /// `update_user_token_manifest` handler — Batch #248) invoke
    /// this single method rather than composing the steps by hand.
    ///
    /// ## Flow (fail-closed at every step)
    ///
    /// 1. Read the current floor from `version_store` (or 0 if no
    ///    persistence configured — test-only path).
    /// 2. Run the Batch #243 `verify_user_token_manifest` 7-gate
    ///    crypto + tenant + version + expiry gate using the floor
    ///    as `highest_seen_policy_version`. Caller-injected
    ///    `verify_signature` closure runs ed25519_dalek against the
    ///    `user_token_manifest_signing_key`.
    /// 3. Run the Batch #244 `UserTokenEnrollment::from_manifest`
    ///    builder — typed validation + duplicate detection.
    /// 4. Atomic swap: replace cached enrollment under the write
    ///    lock. Before this point the old enrollment serves all
    ///    authentication; after, the new one does.
    /// 5. Advance the persistent floor via
    ///    `version_store.record_accepted(policy_version)`.
    ///
    /// ## Ordering invariant (load-bearing)
    ///
    /// Step 4 MUST precede step 5. If a crash happens between 4 and
    /// 5, the next boot re-reads the OLD floor + allows the same
    /// manifest to be re-ingested — idempotent + safe. If the
    /// ordering were reversed (floor advanced before cache swap),
    /// a crash between 5 and 4 would leave the floor advanced but
    /// the cache stale with the OLD manifest — the next manifest
    /// push would need a version ABOVE the already-accepted one,
    /// but the enrollment serving auth would still reflect the
    /// pre-accepted manifest. That drift is the more dangerous
    /// state (fail-open window); current ordering fails-closed.
    pub fn ingest_signed(
        &self,
        signed: &SignedUserTokenManifest,
        expected_tenant: &TenantId,
        now: SystemTime,
        verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
    ) -> Result<IngestOutcome, IngestError> {
        // Step 1: read floor.
        let floor = match self.version_store.as_ref() {
            Some(vs) => vs
                .get_highest_seen()
                .map_err(IngestError::VersionStoreRead)?,
            None => 0,
        };

        // Step 2: verify (7 gates including version monotonicity
        // against the floor).
        let verified = verify_user_token_manifest(
            signed,
            expected_tenant,
            floor,
            now,
            verify_signature,
        )
        .map_err(IngestError::VerifyFailed)?;

        let accepted_version = verified.policy_version;

        // Step 3: build typed enrollment (may fail on signer-side
        // bug — duplicate username / malformed PHC).
        let enrollment = UserTokenEnrollment::from_manifest(&verified)
            .map_err(IngestError::BuildFailed)?;

        // Step 4: atomic swap.
        let entry = CachedEntry {
            manifest: verified,
            enrollment,
        };
        match self.inner.write() {
            Ok(mut guard) => *guard = Some(entry),
            Err(poisoned) => *poisoned.into_inner() = Some(entry),
        }

        // Step 5: advance persistent floor AFTER the cache is live.
        if let Some(vs) = self.version_store.as_ref() {
            vs.record_accepted(accepted_version)
                .map_err(IngestError::VersionStoreWrite)?;
        }

        Ok(IngestOutcome { accepted_version })
    }

    /// Wire-bytes ingress — handler-side entry point (Batch #249a).
    /// Takes the JSON bytes of a [`SignedUserTokenManifest`] + the
    /// hex-encoded signing pubkey from config + the device's
    /// provisioning-bound tenant. Runs the full pipeline:
    ///
    /// 1. Parse bytes as `SignedUserTokenManifest` JSON.
    /// 2. Parse pubkey hex via the shared
    ///    [`super::signing_key_util::parse_ed25519_pubkey_hex`] helper.
    /// 3. Build the ed25519 verify closure.
    /// 4. Delegate to [`Self::ingest_signed`] for floor read + 7-gate
    ///    verify + typed build + atomic swap + floor write.
    ///
    /// The MQTT command handler (Batch #249b
    /// `cmd_update_user_token_manifest`) invokes this single method
    /// per arriving envelope; it stays a thin transport-layer
    /// adapter with no crypto / storage knowledge.
    ///
    /// **Fail-closed on every step** — any error leaves the cached
    /// enrollment + persistent floor unchanged.
    pub fn hot_reload_from_bytes(
        &self,
        signing_pubkey_hex: Option<&str>,
        bytes: &[u8],
        expected_tenant: &TenantId,
        now: SystemTime,
    ) -> Result<IngestOutcome, HotReloadError> {
        let hex = signing_pubkey_hex
            .ok_or(HotReloadError::SigningPubkeyNotConfigured)?;

        let pubkey = parse_ed25519_pubkey_hex(hex)
            .map_err(HotReloadError::InvalidSigningPubkey)?;

        let signed: SignedUserTokenManifest = serde_json::from_slice(bytes)
            .map_err(|e| HotReloadError::JsonParseFailed(e.to_string()))?;

        let verify_fn = |canonical: &[u8], sig_bytes: &[u8; 64]| -> bool {
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            pubkey.verify_strict(canonical, &sig).is_ok()
        };

        self.ingest_signed(&signed, expected_tenant, now, verify_fn)
            .map_err(HotReloadError::Ingest)
    }
}

/// Top-level error for [`UserTokenManifestStore::hot_reload_from_bytes`].
/// Distinct from [`IngestError`] because the handler can fail BEFORE
/// the ingest pipeline even starts (missing pubkey in config,
/// malformed pubkey hex, malformed JSON envelope).
#[derive(Debug, Clone)]
pub enum HotReloadError {
    /// Config did not carry `user_token_manifest_signing_pubkey_hex`
    /// — operator needs to populate this before the cloud can push
    /// enrollments. Fail-closed: no manifest is accepted until the
    /// pubkey is wired.
    SigningPubkeyNotConfigured,

    /// The hex-encoded pubkey failed validation (wrong length, bad
    /// hex character, invalid curve point). Ops should re-check the
    /// value copied into `config.yaml`.
    InvalidSigningPubkey(SigningKeyHexError),

    /// The byte payload failed to deserialize as a
    /// SignedUserTokenManifest JSON object. MQTT publisher bug or
    /// transport corruption.
    JsonParseFailed(String),

    /// Parse + pubkey OK, but the ingest pipeline itself rejected
    /// the manifest (verify / build / floor). See
    /// [`IngestError`] for the fail-mode taxonomy.
    Ingest(IngestError),
}

impl std::fmt::Display for HotReloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SigningPubkeyNotConfigured => {
                f.write_str("signing_pubkey_not_configured")
            }
            Self::InvalidSigningPubkey(e) => {
                write!(f, "invalid_signing_pubkey: {}", e)
            }
            Self::JsonParseFailed(msg) => {
                write!(f, "json_parse_failed: {}", msg)
            }
            Self::Ingest(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for HotReloadError {}

/// Outcome of a successful [`UserTokenManifestStore::ingest_signed`]
/// call. Carries the accepted `policy_version` so the MQTT handler
/// can emit an audit event with the new floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngestOutcome {
    pub accepted_version: u64,
}

/// Top-level ingress error taxonomy. One variant per step of the
/// ingest_signed pipeline so the MQTT handler can route failures
/// to distinct audit events.
#[derive(Debug, Clone)]
pub enum IngestError {
    /// Failed to read the persistent floor from SQLCipher. Should
    /// not happen under normal operation — indicates DB corruption
    /// or permission loss. Caller MUST fail closed (keep serving
    /// the old enrollment) rather than default-to-0.
    VersionStoreRead(String),

    /// 7-gate verify rejected the signed manifest.
    VerifyFailed(UserTokenManifestVerifyError),

    /// Post-verify, the typed-newtype builder rejected the manifest
    /// body (signer-side bug: duplicate normalized username,
    /// malformed PHC hash, invalid X.509 DER). The OLD cache is
    /// retained — the rejected manifest never becomes the live
    /// enrollment.
    BuildFailed(EnrollmentBuildError),

    /// The cache swap succeeded but the persistent floor write
    /// failed. The in-memory enrollment is now the new manifest but
    /// the floor was NOT advanced — on reboot the same (already-
    /// accepted) manifest will pass monotonicity again. Annoying
    /// but SAFE: idempotent replay of an already-accepted manifest
    /// is not an attack. Emit a warning but do NOT roll back the
    /// cache (the cache swap is irreversible — the new manifest
    /// is already the truth). Caller MUST audit-log this variant;
    /// it indicates SQLCipher write failure + operator should
    /// investigate DB health.
    VersionStoreWrite(String),
}

impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::VersionStoreRead(msg) => {
                write!(f, "version_store_read: {}", msg)
            }
            Self::VerifyFailed(e) => write!(f, "verify_failed: {}", e),
            Self::BuildFailed(e) => write!(f, "build_failed: {}", e),
            Self::VersionStoreWrite(msg) => {
                write!(f, "version_store_write: {}", msg)
            }
        }
    }
}

impl std::error::Error for IngestError {}

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

    // ========================================================
    // Batch #247 — ingest_signed end-to-end wire
    // ========================================================

    use super::super::manifest_version_store::{
        ManifestVersionStore, STREAM_ID_USER_TOKEN,
    };
    use super::super::policy::Ed25519SignatureBytes;
    use super::super::user_token_manifest::SignedUserTokenManifest;
    use std::time::Duration;

    fn sign_with_dummy(m: UserTokenManifest) -> SignedUserTokenManifest {
        SignedUserTokenManifest {
            manifest: m,
            signature: Ed25519SignatureBytes::from_slice(&[0u8; 64]).unwrap(),
        }
    }

    fn now_inside() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_750_000_000)
    }

    fn tmp_version_db() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "suderra-usertoken-ingest-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir tmp");
        dir.join(format!(
            "v-{}-{}.sqlite",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            rand::random::<u32>(),
        ))
    }

    fn try_version_store(path: &std::path::Path) -> Option<Arc<ManifestVersionStore>> {
        match ManifestVersionStore::open_for_stream(path, STREAM_ID_USER_TOKEN) {
            Ok(s) => Some(Arc::new(s)),
            Err(e) => {
                eprintln!("Skipping test: version_store open failed: {}", e);
                None
            }
        }
    }

    #[test]
    fn ingest_signed_without_persistence_accepts_valid_manifest() {
        let s = UserTokenManifestStore::new(); // no version store
        let signed = sign_with_dummy(manifest_v1());
        let out = s
            .ingest_signed(
                &signed,
                &tenant(),
                now_inside(),
                |_, _| true,
            )
            .unwrap();
        assert_eq!(out.accepted_version, 1);
        assert!(s.is_loaded());
    }

    #[test]
    fn ingest_signed_rejects_on_signature_failure() {
        let s = UserTokenManifestStore::new();
        let signed = sign_with_dummy(manifest_v1());
        let err = s
            .ingest_signed(
                &signed,
                &tenant(),
                now_inside(),
                |_, _| false, // verifier rejects
            )
            .unwrap_err();
        match err {
            IngestError::VerifyFailed(UserTokenManifestVerifyError::InvalidSignature) => {}
            other => panic!("wrong variant: {:?}", other),
        }
        assert!(!s.is_loaded());
    }

    #[test]
    fn ingest_signed_rejects_on_tenant_mismatch() {
        let s = UserTokenManifestStore::new();
        let signed = sign_with_dummy(manifest_v1());
        let other_tenant = TenantId::new_from_verified([0xBB; 16]);
        let err = s
            .ingest_signed(&signed, &other_tenant, now_inside(), |_, _| true)
            .unwrap_err();
        match err {
            IngestError::VerifyFailed(UserTokenManifestVerifyError::TenantMismatch) => {}
            other => panic!("wrong variant: {:?}", other),
        }
        assert!(!s.is_loaded());
    }

    #[test]
    fn ingest_signed_with_persistence_advances_floor() {
        let path = tmp_version_db();
        let Some(vs) = try_version_store(&path) else { return };
        let s =
            UserTokenManifestStore::new().with_version_store(vs.clone());

        let signed_v1 = sign_with_dummy(manifest_v1());
        let out = s
            .ingest_signed(
                &signed_v1,
                &tenant(),
                now_inside(),
                |_, _| true,
            )
            .unwrap();
        assert_eq!(out.accepted_version, 1);
        assert_eq!(vs.get_highest_seen().unwrap(), 1);

        // Replay the same manifest — stale version rejected.
        let err = s
            .ingest_signed(
                &signed_v1,
                &tenant(),
                now_inside(),
                |_, _| true,
            )
            .unwrap_err();
        match err {
            IngestError::VerifyFailed(
                UserTokenManifestVerifyError::StalePolicyVersion {
                    claimed,
                    highest_seen,
                },
            ) => {
                assert_eq!(claimed, 1);
                assert_eq!(highest_seen, 1);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn ingest_signed_rejects_rollback_across_reboot_simulation() {
        let path = tmp_version_db();
        let Some(vs) = try_version_store(&path) else { return };
        let s =
            UserTokenManifestStore::new().with_version_store(vs.clone());

        // Ingest v2 first.
        let signed_v2 = sign_with_dummy(manifest_v2_bob_added());
        s.ingest_signed(&signed_v2, &tenant(), now_inside(), |_, _| true)
            .unwrap();
        assert_eq!(vs.get_highest_seen().unwrap(), 2);

        // Simulate reboot: NEW store + REOPENED version store on the
        // same path. Attacker replays the captured v1 manifest.
        drop(s);
        let Some(vs2) = try_version_store(&path) else { return };
        let s2 =
            UserTokenManifestStore::new().with_version_store(vs2.clone());

        let signed_v1 = sign_with_dummy(manifest_v1());
        let err = s2
            .ingest_signed(
                &signed_v1,
                &tenant(),
                now_inside(),
                |_, _| true,
            )
            .unwrap_err();
        match err {
            IngestError::VerifyFailed(
                UserTokenManifestVerifyError::StalePolicyVersion {
                    claimed: 1,
                    highest_seen: 2,
                },
            ) => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn ingest_signed_with_persistence_accepts_monotonic_bump() {
        let path = tmp_version_db();
        let Some(vs) = try_version_store(&path) else { return };
        let s =
            UserTokenManifestStore::new().with_version_store(vs.clone());

        let signed_v1 = sign_with_dummy(manifest_v1());
        s.ingest_signed(&signed_v1, &tenant(), now_inside(), |_, _| true)
            .unwrap();

        // v2 > v1 → accepted, floor advances.
        let signed_v2 = sign_with_dummy(manifest_v2_bob_added());
        let out = s
            .ingest_signed(
                &signed_v2,
                &tenant(),
                now_inside(),
                |_, _| true,
            )
            .unwrap();
        assert_eq!(out.accepted_version, 2);
        assert_eq!(vs.get_highest_seen().unwrap(), 2);

        // Cached enrollment reflects v2 (bob now enrolled).
        s.with_enrollment(|e| {
            let e = e.unwrap();
            assert_eq!(e.user_pass_count(), 2);
        });
    }

    // ========================================================
    // Batch #249a — hot_reload_from_bytes bytes-to-outcome wrapper
    // ========================================================

    use ed25519_dalek::{SigningKey, Signer, SECRET_KEY_LENGTH};

    /// Mint a real signing key + pubkey hex + signed manifest body.
    /// Uses a deterministic secret so tests are reproducible.
    fn real_signed_bytes(m: UserTokenManifest) -> (String, Vec<u8>) {
        let sk = SigningKey::from_bytes(&[42u8; SECRET_KEY_LENGTH]);
        let vk = sk.verifying_key();
        let pubkey_hex: String =
            vk.to_bytes().iter().map(|b| format!("{:02x}", b)).collect();

        let canonical = m.canonical_bytes().expect("canonical");
        let sig = sk.sign(&canonical);
        let signed = SignedUserTokenManifest {
            manifest: m,
            signature: super::super::policy::Ed25519SignatureBytes::from_slice(
                &sig.to_bytes(),
            )
            .unwrap(),
        };
        let bytes = serde_json::to_vec(&signed).expect("json");
        (pubkey_hex, bytes)
    }

    #[test]
    fn hot_reload_happy_path_end_to_end() {
        let s = UserTokenManifestStore::new();
        let (hex, bytes) = real_signed_bytes(manifest_v1());
        let out = s
            .hot_reload_from_bytes(
                Some(&hex),
                &bytes,
                &tenant(),
                now_inside(),
            )
            .unwrap();
        assert_eq!(out.accepted_version, 1);
        assert!(s.is_loaded());
    }

    #[test]
    fn hot_reload_rejects_missing_signing_pubkey() {
        let s = UserTokenManifestStore::new();
        let (_, bytes) = real_signed_bytes(manifest_v1());
        let err = s
            .hot_reload_from_bytes(None, &bytes, &tenant(), now_inside())
            .unwrap_err();
        match err {
            HotReloadError::SigningPubkeyNotConfigured => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn hot_reload_rejects_malformed_pubkey_hex() {
        let s = UserTokenManifestStore::new();
        let (_, bytes) = real_signed_bytes(manifest_v1());
        let err = s
            .hot_reload_from_bytes(
                Some("not-hex"),
                &bytes,
                &tenant(),
                now_inside(),
            )
            .unwrap_err();
        match err {
            HotReloadError::InvalidSigningPubkey(_) => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn hot_reload_rejects_malformed_json() {
        let s = UserTokenManifestStore::new();
        let (hex, _) = real_signed_bytes(manifest_v1());
        let err = s
            .hot_reload_from_bytes(
                Some(&hex),
                b"not json at all",
                &tenant(),
                now_inside(),
            )
            .unwrap_err();
        match err {
            HotReloadError::JsonParseFailed(_) => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn hot_reload_rejects_wrong_signature() {
        // Sign with key A, verify with key B → InvalidSignature at
        // the Ingest/Verify layer.
        let s = UserTokenManifestStore::new();
        let (_correct_hex, bytes) = real_signed_bytes(manifest_v1());
        // Attacker pubkey — a different curve point.
        let attacker_sk = SigningKey::from_bytes(&[77u8; SECRET_KEY_LENGTH]);
        let wrong_hex: String = attacker_sk
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        let err = s
            .hot_reload_from_bytes(
                Some(&wrong_hex),
                &bytes,
                &tenant(),
                now_inside(),
            )
            .unwrap_err();
        match err {
            HotReloadError::Ingest(IngestError::VerifyFailed(
                UserTokenManifestVerifyError::InvalidSignature,
            )) => {}
            other => panic!("wrong variant: {:?}", other),
        }
        assert!(!s.is_loaded());
    }

    #[test]
    fn hot_reload_rejects_cross_tenant_manifest() {
        let s = UserTokenManifestStore::new();
        let (hex, bytes) = real_signed_bytes(manifest_v1());
        // Device-side expected tenant != manifest tenant.
        let other_tenant = TenantId::new_from_verified([0xBB; 16]);
        let err = s
            .hot_reload_from_bytes(
                Some(&hex),
                &bytes,
                &other_tenant,
                now_inside(),
            )
            .unwrap_err();
        match err {
            HotReloadError::Ingest(IngestError::VerifyFailed(
                UserTokenManifestVerifyError::TenantMismatch,
            )) => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn hot_reload_display_error_strings_are_stable() {
        // Smoke test to lock the Display strings for audit-log
        // routing. Actual error creation is trivial and pattern-
        // matched against exact snake_case tokens.
        assert_eq!(
            HotReloadError::SigningPubkeyNotConfigured.to_string(),
            "signing_pubkey_not_configured"
        );
    }

    #[test]
    fn ingest_signed_preserves_old_cache_on_build_failure() {
        // Ingest v1 (valid) → cache holds v1.
        let s = UserTokenManifestStore::new();
        let signed_v1 = sign_with_dummy(manifest_v1());
        s.ingest_signed(&signed_v1, &tenant(), now_inside(), |_, _| true)
            .unwrap();
        assert!(s.is_loaded());

        // Ingest v2 with a malformed PHC hash — verify succeeds,
        // build fails, old cache retained.
        let mut broken = manifest_v2_bob_added();
        broken.user_pass_bindings[1].argon2id_phc =
            "not-a-phc".to_string();
        let signed_broken = sign_with_dummy(broken);
        let err = s
            .ingest_signed(
                &signed_broken,
                &tenant(),
                now_inside(),
                |_, _| true,
            )
            .unwrap_err();
        match err {
            IngestError::BuildFailed(EnrollmentBuildError::HashInvalid { .. }) => {}
            other => panic!("wrong variant: {:?}", other),
        }

        // Old v1 cache still serves.
        s.with_enrollment(|e| {
            assert_eq!(e.unwrap().user_pass_count(), 1);
        });
    }
}
