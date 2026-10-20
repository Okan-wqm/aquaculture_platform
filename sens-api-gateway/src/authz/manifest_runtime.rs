//! RbacManifestStore runtime loader (Batch 67, Sprint 6.1
//! full wire partial).
//!
//! Holds the VERIFIED RBAC manifest in memory + exposes the
//! operator→pubkey lookup that the CommandEnvelope Gate 7
//! signature verify path will consume (Sprint 6.1 full wire
//! Gate 7 swap planned as Batch 68+).
//!
//! The store is populated at boot by `load_from_file`:
//! 1. Reads the JSON file [`boot_manifest_path`] resolves from the
//!    agent's path SSoT (ADR-048 DEC-4.5).
//! 2. Deserializes as `SignedRbacManifest`.
//! 3. Calls the Batch 5b pure `verify_manifest` with
//!    closure-injected ed25519 via `ed25519_dalek`.
//! 4. On Ok, stores the verified `RbacManifest` in
//!    `self.current`.
//! 5. On Err, routes per mode (Permissive warn-logs +
//!    continues with empty store; Enforcing returns Err →
//!    main.rs exit(1)).
//!
//! Consumers (envelope adapter, command dispatch) call
//! `lookup_operator_pubkey(operator_id) -> Option<[u8; 32]>`
//! to resolve the actor's ed25519 pubkey for signature
//! verification.
//!
//! ## What this module does NOT do (Sprint 6.1 full wire)
//!
//! - MQTT `update_policy` hot-reload — operator-triggered
//!   manifest refresh without agent restart. Sprint 6.1
//!   full wire adds the command handler.
//! - highest_seen_policy_version persistence across
//!   restarts. Currently uses 0 (first-boot floor) every
//!   boot; Sprint 6.1 full wire persists to SQLCipher +
//!   loads at next boot to prevent manifest rollback
//!   across restarts.
//! - Envelope adapter Gate 7 consumption. Batch 68+ swaps
//!   the Batch 63 NO-OP closure to call
//!   lookup_operator_pubkey + ed25519_dalek::verify_strict.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use tracing::{info, warn};

use super::manifest::{OperatorBinding, RbacManifest, SignedRbacManifest};
use super::manifest_version_store::ManifestVersionStore;
use super::permission::{OperatorId, TenantId};
use super::verify::verify_manifest;
use crate::config::RbacManifestMode;

/// The manifest file the boot loader reads.
///
/// Suderra OS: the statement the root installer delivered into the
/// read-only site directory, at its compile-time path (ADR-048 DEC-4.12);
/// the configuration cannot move it (`Config::validate`).
///
/// Generic: the copy a previous `update_policy` persisted under the data
/// root, whenever it exists — it is the newest accepted manifest, and the
/// version floor already stands at its version, so an older seed file
/// would be refused as a rollback. Otherwise the operator's
/// `rbac_manifest.manifest_path`, else `/etc/suderra/rbac_manifest.json`.
#[cfg(feature = "suderra-os")]
pub fn boot_manifest_path(paths: &crate::paths::AgentPaths, _configured: Option<&Path>) -> PathBuf {
    paths.rbac_manifest_file()
}

/// See the Suderra OS variant.
#[cfg(not(feature = "suderra-os"))]
pub fn boot_manifest_path(paths: &crate::paths::AgentPaths, configured: Option<&Path>) -> PathBuf {
    let persisted = paths.rbac_manifest_persist_file();
    if persisted.exists() {
        return persisted;
    }
    configured
        .map(Path::to_path_buf)
        .unwrap_or_else(|| paths.rbac_manifest_file())
}

/// Runtime store for the verified RBAC manifest.
///
/// `current` is RwLock-protected so Sprint 6.1 full wire's
/// MQTT hot-reload can swap the manifest atomically without
/// blocking lookup readers.
///
/// `version_store` (Batch 71) — optional SQLCipher-backed
/// persistence for the `highest_seen_policy_version` floor.
/// When present, `load_from_file_inner` reads the floor on
/// entry + writes the accepted version after successful verify;
/// this closes the cross-reboot manifest-rollback window.
/// Tests that don't exercise persistence omit it via `new()`.
pub struct RbacManifestStore {
    current: RwLock<Option<RbacManifest>>,
    version_store: Option<Arc<ManifestVersionStore>>,
}

impl RbacManifestStore {
    /// Construct an empty store (no manifest loaded, no
    /// version persistence). Tests + pre-Batch-71 code paths.
    pub fn new() -> Self {
        Self {
            current: RwLock::new(None),
            version_store: None,
        }
    }

    /// Attach a persistent version store (Batch 71). Builder-
    /// style so existing `RbacManifestStore::new()` call sites
    /// keep working; AppState wires the version store via
    /// `init_rbac_manifest_store` when `rbac_manifest.mode !=
    /// Disabled`.
    pub fn with_version_store(mut self, store: Arc<ManifestVersionStore>) -> Self {
        self.version_store = Some(store);
        self
    }

    /// Load + verify the manifest from disk.
    ///
    /// INPUTS:
    /// - `mode` — operator-configured rollout stage.
    /// - `signing_pubkey_hex` — 64-char hex ed25519 pubkey
    ///   for signature verify. Required in Permissive/
    ///   Enforcing mode (Batch 66 Rule 12 enforces at config
    ///   load).
    /// - `path` — the manifest file ([`boot_manifest_path`]).
    /// - `expected_tenant` — TenantId from provisioning
    ///   bound to this device.
    ///
    /// OUTPUT:
    /// - `Ok(())` — Disabled mode (skip), or Permissive mode
    ///   (log failure + continue), or Enforcing mode with
    ///   successful verify.
    /// - `Err(String)` — Enforcing mode with verify failure;
    ///   caller exits(1).
    pub fn load_from_file(
        &self,
        mode: RbacManifestMode,
        signing_pubkey_hex: Option<&str>,
        path: &Path,
        expected_tenant: &TenantId,
    ) -> Result<(), String> {
        if matches!(mode, RbacManifestMode::Disabled) {
            info!("RBAC manifest load skipped: mode=Disabled (HC-1 backward compat)");
            return Ok(());
        }

        info!(
            "RBAC manifest load: mode={:?} path={}",
            mode,
            path.display()
        );

        let outcome = self.load_from_file_inner(signing_pubkey_hex, path, expected_tenant);

        match (mode, outcome) {
            (RbacManifestMode::Disabled, _) => Ok(()), // unreachable (early return)
            (_, Ok(manifest)) => {
                info!(
                    "RBAC manifest verified: policy_version={} operator_count={} role_count={}",
                    manifest.policy_version,
                    manifest.operator_bindings.len(),
                    manifest.roles.len()
                );
                match self.current.write() {
                    Ok(mut guard) => {
                        *guard = Some(manifest);
                    }
                    Err(_) => {
                        return Err("RwLock poisoned on RBAC manifest store write".to_string());
                    }
                }
                Ok(())
            }
            (RbacManifestMode::Permissive, Err(reason)) => {
                warn!(
                    "RBAC manifest load FAILED in Permissive mode: {}. \
                     Store remains empty; envelope signature verify falls to \
                     Batch 63 NO-OP closure.",
                    reason
                );
                Ok(())
            }
            (RbacManifestMode::Enforcing, Err(reason)) => Err(reason),
        }
    }

    /// Inner load — reads bytes from `path`, verifies them against the
    /// floor, then advances the floor. Returns the verified RbacManifest
    /// or Err(reason).
    fn load_from_file_inner(
        &self,
        signing_pubkey_hex: Option<&str>,
        path: &Path,
        expected_tenant: &TenantId,
    ) -> Result<RbacManifest, String> {
        let bytes = std::fs::read(path)
            .map_err(|e| format!("Failed to read RBAC manifest at {}: {}", path.display(), e))?;

        let verified = self
            .verify_against_floor(signing_pubkey_hex, &bytes, expected_tenant)
            .map_err(|e| format!("{} (source={})", e, path.display()))?;
        self.advance_floor(verified.policy_version)?;
        Ok(verified)
    }

    /// Shared verify logic. Called from both the boot-time file loader
    /// AND the Batch 72 MQTT hot-reload handler — SSoT for manifest
    /// acceptance. It writes nothing: the caller advances the floor with
    /// [`Self::advance_floor`] once the manifest it accepted is durable
    /// where the next boot reads it (EDGE-HIGH-050).
    ///
    /// Steps:
    /// 1. Parse `bytes` as SignedRbacManifest JSON.
    /// 2. Resolve ed25519 pubkey from hex string.
    /// 3. Read persistent `highest_seen_policy_version` floor
    ///    (fail-closed on store-read error).
    /// 4. Call pure `verify_manifest` with a verify closure
    ///    wrapping `ed25519_dalek::VerifyingKey::verify_strict`.
    fn verify_against_floor(
        &self,
        signing_pubkey_hex: Option<&str>,
        bytes: &[u8],
        expected_tenant: &TenantId,
    ) -> Result<RbacManifest, String> {
        let hex = signing_pubkey_hex.ok_or_else(|| {
            "manifest_signing_pubkey_hex is None — Batch 66 Rule 12 should have caught this"
                .to_string()
        })?;
        let pubkey = parse_ed25519_pubkey_hex(hex)?;

        let signed: SignedRbacManifest = serde_json::from_slice(bytes)
            .map_err(|e| format!("Failed to parse RBAC manifest JSON: {}", e))?;

        // Batch 71 Sprint 6.1 full wire: read the persisted
        // floor when a version store is attached; fall back to
        // 0 otherwise (matches pre-Batch-71 behavior for
        // tests + AppState paths that don't wire persistence).
        // Failure to read the floor is FAIL-CLOSED: we return
        // the read error rather than silently using 0 — a
        // corrupted/unreadable store is a security signal.
        let highest_seen_policy_version = match &self.version_store {
            Some(vs) => vs.get_highest_seen()?,
            None => 0u64,
        };

        let verify_fn = |canonical: &[u8], sig_bytes: &[u8; 64]| -> bool {
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            pubkey.verify_strict(canonical, &sig).is_ok()
        };

        let verified = verify_manifest(
            &signed,
            expected_tenant,
            highest_seen_policy_version,
            std::time::SystemTime::now(),
            verify_fn,
        )
        .map_err(|e| format!("{:?}", e))?;

        Ok(verified)
    }

    /// Batch 71 rollback-protection write: advance the persisted floor to
    /// an accepted manifest's version. UPSERT keeps
    /// MAX(existing, policy_version) — idempotent on re-load of the same
    /// manifest across a process restart.
    fn advance_floor(&self, policy_version: u64) -> Result<(), String> {
        if let Some(vs) = &self.version_store {
            let new_floor = vs.record_accepted(policy_version)?;
            info!(
                "RBAC manifest floor advanced: policy_version={} persisted_floor={}",
                policy_version, new_floor
            );
        }
        Ok(())
    }

    /// Hot-reload the manifest from operator-supplied bytes
    /// (Batch 72 Sprint 6.1 follow-up MQTT `update_policy`
    /// handler path). Generic profile only: on Suderra OS the manifest
    /// is signed site material the root installer delivers (ADR-048
    /// DEC-4.12) and `update_policy` is refused.
    ///
    /// Order (EDGE-HIGH-050), each step only after the previous one
    /// succeeded:
    /// 1. Verify against the current floor (writes nothing).
    /// 2. Persist the bytes durably to `persist_path` (temporary name,
    ///    fsync, rename, directory fsync) — the file the next boot
    ///    loads ([`boot_manifest_path`]).
    /// 3. Advance the version floor.
    /// 4. Swap the verified manifest into `self.current`.
    ///
    /// The floor therefore never runs ahead of the manifest on disk: a
    /// failed persist leaves floor, disk and memory exactly as they
    /// were, and the next boot loads a manifest the floor accepts.
    /// Before this order the floor advanced first, so a failed write
    /// (EROFS under `/etc`) left the on-disk manifest below the floor
    /// and an Enforcing boot refused it as a rollback — forever.
    ///
    /// On failure: `self.current` is UNCHANGED. This matches
    /// the fail-closed discipline of `load_from_file`: if the
    /// new manifest is invalid (bad signature, tenant mismatch,
    /// rollback attempt), the agent keeps operating under the
    /// previously-verified manifest rather than regressing.
    #[cfg(not(feature = "suderra-os"))]
    pub fn hot_reload_from_bytes(
        &self,
        signing_pubkey_hex: Option<&str>,
        bytes: &[u8],
        expected_tenant: &TenantId,
        persist_path: &Path,
    ) -> Result<u64, String> {
        let verified = self.verify_against_floor(signing_pubkey_hex, bytes, expected_tenant)?;
        let new_version = verified.policy_version;

        persist_manifest_bytes(persist_path, bytes).map_err(|e| {
            format!(
                "Hot-reload disk persist to {} failed: {} (nothing applied, policy_version={} not accepted)",
                persist_path.display(),
                e,
                new_version
            )
        })?;

        self.advance_floor(new_version)?;

        match self.current.write() {
            Ok(mut guard) => {
                *guard = Some(verified);
            }
            Err(_) => {
                return Err("RwLock poisoned on RBAC manifest hot-reload swap".to_string());
            }
        }

        info!(
            "RBAC manifest hot-reloaded: policy_version={} persisted={}",
            new_version,
            persist_path.display()
        );
        Ok(new_version)
    }

    /// Look up an operator's ed25519 pubkey bytes from the
    /// verified manifest. Returns None when:
    /// - Store is empty (manifest not loaded — Disabled mode,
    ///   or Permissive mode with load failure).
    /// - Operator not in the manifest's operator_bindings.
    /// - RwLock poisoned (treated as miss; logged by caller).
    pub fn lookup_operator_pubkey(&self, operator_id: &OperatorId) -> Option<[u8; 32]> {
        let guard = match self.current.read() {
            Ok(g) => g,
            Err(_) => return None,
        };
        let manifest = guard.as_ref()?;
        let binding: &OperatorBinding = manifest
            .operator_bindings
            .iter()
            .find(|b| b.operator_id.as_bytes() == operator_id.as_bytes())?;
        Some(*binding.pubkey.as_bytes())
    }

    /// Snapshot-observer helper: returns `(operator_count,
    /// role_count)` of the currently-loaded manifest, or None
    /// when the store is empty.
    ///
    /// Batch 72 Sprint 6.1 hot-reload response includes these
    /// counts so operators see the post-reload manifest shape
    /// without a separate GET round-trip.
    pub fn snapshot_counts(&self) -> Option<(usize, usize)> {
        self.current.read().ok().and_then(|g| {
            g.as_ref()
                .map(|m| (m.operator_bindings.len(), m.roles.len()))
        })
    }

    /// Snapshot-observer helper: returns whether the store
    /// currently has a verified manifest loaded.
    ///
    /// Used by the boot-banner follow-up + Sprint 6.1
    /// cmd_get_config expansion.
    pub fn is_loaded(&self) -> bool {
        self.current.read().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Snapshot-observer helper: returns the policy_version
    /// of the loaded manifest, or None.
    ///
    /// Sprint 6.1 full wire exposes via cmd_get_config for
    /// operator visibility of active manifest version.
    pub fn policy_version(&self) -> Option<u64> {
        self.current
            .read()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.policy_version))
    }

    /// Batch 223 test-only bypass: seed the `current`
    /// RwLock with a manifest directly, without running the
    /// signature-verify gates. ONLY callable inside the
    /// crate's `#[cfg(test)]` builds — production paths
    /// (`load_from_file`, `hot_reload_from_bytes`) enforce
    /// the full verification chain. Exists purely so unit
    /// tests for the InMemoryPolicyEngine + other consumers
    /// can seed deterministic manifest shapes without
    /// building a full ed25519 signing pipeline.
    #[cfg(test)]
    pub(crate) fn test_set_manifest(&self, manifest: RbacManifest) {
        *self.current.write().expect("RwLock") = Some(manifest);
    }

    /// Batch 223 Faz 2 Sprint 6.1 — scoped read of the
    /// current manifest body for PolicyEngine consumers.
    /// Closure receives a borrowed `&RbacManifest` under
    /// the read-lock; returns whatever the closure yields.
    /// `None` when the store is empty OR the lock is
    /// poisoned (latter treated as empty for fail-closed
    /// semantic).
    ///
    /// WHY this shape (not a `fn current(&self) ->
    /// Option<Arc<RbacManifest>>`): keeps the manifest
    /// tightly sealed inside the store's RwLock — callers
    /// cannot clone the manifest out of the lock and accumulate
    /// stale copies that diverge from a later hot-reload.
    /// Scoped-reader pattern matches the rest of the
    /// `manifest_runtime` access discipline.
    pub fn with_manifest<R, F>(&self, f: F) -> Option<R>
    where
        F: FnOnce(&RbacManifest) -> R,
    {
        let guard = self.current.read().ok()?;
        let manifest = guard.as_ref()?;
        Some(f(manifest))
    }
}

impl Default for RbacManifestStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Durably replace `path` with `bytes`: temporary name in the same
/// directory, fsync, rename, directory fsync — the next boot sees the old
/// file or the complete new one, never a torn one.
#[cfg(not(feature = "suderra-os"))]
fn persist_manifest_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    let tmp = parent.join(format!(".rbac_manifest.json.tmp-{}", std::process::id()));
    let written = std::fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write {}: {}", tmp.display(), e));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "rename {} -> {}: {}",
            tmp.display(),
            path.display(),
            e
        ));
    }
    std::fs::File::open(parent)
        .and_then(|d| d.sync_all())
        .map_err(|e| format!("fsync {}: {}", parent.display(), e))
}

/// Parse a 64-char hex ed25519 pubkey into VerifyingKey — RBAC
/// caller-side shim around the shared
/// [`super::signing_key_util::parse_ed25519_pubkey_hex`] (Batch #249a
/// refactor). Owns the "manifest_signing_pubkey_hex" string prefix
/// for pre-Batch-249a error message stability (consumers that
/// string-match on the message stay happy).
fn parse_ed25519_pubkey_hex(hex: &str) -> Result<ed25519_dalek::VerifyingKey, String> {
    super::signing_key_util::parse_ed25519_pubkey_hex(hex).map_err(|e| {
        use super::signing_key_util::SigningKeyHexError;
        match e {
            SigningKeyHexError::WrongLength { got } => {
                format!("manifest_signing_pubkey_hex must be 64 chars, got {}", got)
            }
            SigningKeyHexError::InvalidHexAt { byte_index, reason } => {
                format!("invalid hex at byte {}: {}", byte_index, reason)
            }
            SigningKeyHexError::InvalidCurvePoint { reason } => {
                format!("ed25519 key construction failed: {}", reason)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_store_reports_not_loaded() {
        let store = RbacManifestStore::new();
        assert!(!store.is_loaded());
        assert_eq!(store.policy_version(), None);
    }

    #[test]
    fn empty_store_lookup_returns_none() {
        let store = RbacManifestStore::new();
        let op = OperatorId::new_from_verified([0u8; 16]);
        assert_eq!(store.lookup_operator_pubkey(&op), None);
    }

    #[test]
    fn parse_ed25519_pubkey_rejects_short_hex() {
        assert!(parse_ed25519_pubkey_hex("abcd").is_err());
    }

    #[test]
    fn parse_ed25519_pubkey_rejects_non_hex() {
        assert!(parse_ed25519_pubkey_hex(&"z".repeat(64)).is_err());
    }
}

/// EDGE-HIGH-050: the hot-reload order — persist, then floor, then swap —
/// against a real signed manifest and a real SQLCipher floor store.
#[cfg(all(test, not(feature = "suderra-os")))]
mod hot_reload_order_tests {
    use super::*;
    use crate::authz::policy::Ed25519SignatureBytes;
    use ed25519_dalek::{SECRET_KEY_LENGTH, Signer, SigningKey};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn signed(policy_version: u64) -> (String, Vec<u8>) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs() as i64;
        let manifest = RbacManifest {
            policy_version,
            tenant_id: tenant(),
            manifest_valid_from_unix_secs: now - 3600,
            manifest_valid_until_unix_secs: now + 3600,
            operator_bindings: Vec::new(),
            roles: Vec::new(),
        };
        let sk = SigningKey::from_bytes(&[42u8; SECRET_KEY_LENGTH]);
        let hex: String = sk
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let sig = sk.sign(&manifest.canonical_bytes().expect("canonical"));
        let signed = SignedRbacManifest {
            manifest,
            signature: Ed25519SignatureBytes::from_slice(&sig.to_bytes()).expect("sig"),
        };
        (hex, serde_json::to_vec(&signed).expect("json"))
    }

    fn store_with_floor(dir: &Path) -> (RbacManifestStore, Arc<ManifestVersionStore>) {
        crate::offline_queue::test_support::ensure_key_sandbox();
        let vs = Arc::new(
            ManifestVersionStore::open(&dir.join("rbac_version.sqlite")).expect("open floor store"),
        );
        (RbacManifestStore::new().with_version_store(vs.clone()), vs)
    }

    /// A persist that cannot happen (EROFS under /etc in the field; here a
    /// parent that is a regular file) leaves floor, memory and disk as
    /// they were, so the next Enforcing boot still accepts its manifest.
    #[test]
    fn failed_persist_leaves_floor_and_memory_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (store, vs) = store_with_floor(dir.path());
        let (hex, bytes) = signed(5);
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").expect("seed blocker");

        let err = store
            .hot_reload_from_bytes(
                Some(&hex),
                &bytes,
                &tenant(),
                &blocker.join("rbac_manifest.json"),
            )
            .expect_err("persist must fail");
        assert!(err.contains("nothing applied"), "{err}");
        assert_eq!(
            vs.get_highest_seen().expect("floor"),
            0,
            "floor must not move"
        );
        assert!(!store.is_loaded(), "memory must not change");
    }

    #[test]
    fn successful_reload_persists_advances_the_floor_and_swaps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (store, vs) = store_with_floor(dir.path());
        let (hex, bytes) = signed(5);
        let path = dir.path().join("data").join("rbac_manifest.json");

        let version = store
            .hot_reload_from_bytes(Some(&hex), &bytes, &tenant(), &path)
            .expect("reload");
        assert_eq!(version, 5);
        assert_eq!(std::fs::read(&path).expect("persisted"), bytes);
        assert_eq!(vs.get_highest_seen().expect("floor"), 5);
        assert_eq!(store.policy_version(), Some(5));
    }

    /// Generic boot source: the persisted hot-reload copy wins over the
    /// operator's seed file once it exists.
    #[test]
    fn boot_prefers_the_persisted_copy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = crate::paths::AgentPaths::generic(crate::paths::GenericOverrides {
            data_root: Some(dir.path().to_path_buf()),
            ..Default::default()
        });
        let seed = dir.path().join("seed.json");
        assert_eq!(boot_manifest_path(&paths, Some(&seed)), seed);
        assert_eq!(
            boot_manifest_path(&paths, None),
            Path::new("/etc/suderra/rbac_manifest.json")
        );
        std::fs::write(paths.rbac_manifest_persist_file(), b"{}").expect("seed persisted");
        assert_eq!(
            boot_manifest_path(&paths, Some(&seed)),
            paths.rbac_manifest_persist_file()
        );
    }
}
