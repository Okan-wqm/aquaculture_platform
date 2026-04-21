//! RbacManifestStore runtime loader (Batch 67, Sprint 6.1
//! full wire partial).
//!
//! Holds the VERIFIED RBAC manifest in memory + exposes the
//! operator→pubkey lookup that the CommandEnvelope Gate 7
//! signature verify path will consume (Sprint 6.1 full wire
//! Gate 7 swap planned as Batch 68+).
//!
//! The store is populated at boot by `load_from_file`:
//! 1. Reads JSON file at `rbac_manifest.manifest_path` (or
//!    default `/etc/suderra/rbac_manifest.json`).
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

use std::path::Path;
use std::sync::{Arc, RwLock};

use tracing::{info, warn};

use super::manifest::{OperatorBinding, RbacManifest, SignedRbacManifest};
use super::manifest_version_store::ManifestVersionStore;
use super::permission::{OperatorId, TenantId};
use super::verify::verify_manifest;
use crate::config::RbacManifestMode;

/// Canonical manifest file path.
const DEFAULT_MANIFEST_PATH: &str = "/etc/suderra/rbac_manifest.json";

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
    /// - `manifest_path_override` — None = default path.
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
        manifest_path_override: Option<&Path>,
        expected_tenant: &TenantId,
    ) -> Result<(), String> {
        if matches!(mode, RbacManifestMode::Disabled) {
            info!("RBAC manifest load skipped: mode=Disabled (HC-1 backward compat)");
            return Ok(());
        }

        let path = manifest_path_override
            .map(Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from(DEFAULT_MANIFEST_PATH));

        info!(
            "RBAC manifest load: mode={:?} path={}",
            mode,
            path.display()
        );

        let outcome = self.load_from_file_inner(
            signing_pubkey_hex,
            &path,
            expected_tenant,
        );

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
                        return Err(
                            "RwLock poisoned on RBAC manifest store write"
                                .to_string(),
                        );
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

    /// Inner load — reads bytes from `path`, then delegates to
    /// `verify_and_floor`. Returns the verified RbacManifest
    /// or Err(reason).
    fn load_from_file_inner(
        &self,
        signing_pubkey_hex: Option<&str>,
        path: &Path,
        expected_tenant: &TenantId,
    ) -> Result<RbacManifest, String> {
        let bytes = std::fs::read(path).map_err(|e| {
            format!(
                "Failed to read RBAC manifest at {}: {}",
                path.display(),
                e
            )
        })?;

        self.verify_and_floor(signing_pubkey_hex, &bytes, expected_tenant)
            .map_err(|e| format!("{} (source={})", e, path.display()))
    }

    /// Shared verify + version-floor logic. Called from both the
    /// boot-time file loader AND the Batch 72 MQTT hot-reload
    /// handler — SSoT for manifest acceptance.
    ///
    /// Steps:
    /// 1. Parse `bytes` as SignedRbacManifest JSON.
    /// 2. Resolve ed25519 pubkey from hex string.
    /// 3. Read persistent `highest_seen_policy_version` floor
    ///    (fail-closed on store-read error).
    /// 4. Call pure `verify_manifest` with a verify closure
    ///    wrapping `ed25519_dalek::VerifyingKey::verify_strict`.
    /// 5. On success, UPSERT the new version into the persistent
    ///    floor (`MAX(existing, incoming)` — one-way ratchet).
    ///
    /// Returns the verified manifest — callers own the atomic
    /// in-memory swap via `self.current.write()` + any disk-
    /// persistence responsibility (file loader has no write;
    /// MQTT hot-reload persists to disk for post-restart continuity).
    fn verify_and_floor(
        &self,
        signing_pubkey_hex: Option<&str>,
        bytes: &[u8],
        expected_tenant: &TenantId,
    ) -> Result<RbacManifest, String> {
        let hex = signing_pubkey_hex.ok_or_else(|| {
            "manifest_signing_pubkey_hex is None — Batch 66 Rule 12 should have caught this".to_string()
        })?;
        let pubkey = parse_ed25519_pubkey_hex(hex)?;

        let signed: SignedRbacManifest = serde_json::from_slice(bytes).map_err(|e| {
            format!("Failed to parse RBAC manifest JSON: {}", e)
        })?;

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

        // Batch 71 rollback-protection write: only after a
        // successful verify do we advance the persisted floor.
        // UPSERT keeps MAX(existing, verified.policy_version)
        // — idempotent on re-load of the same manifest across
        // a process restart.
        if let Some(vs) = &self.version_store {
            let new_floor = vs.record_accepted(verified.policy_version)?;
            info!(
                "RBAC manifest floor advanced: policy_version={} persisted_floor={}",
                verified.policy_version, new_floor
            );
        }

        Ok(verified)
    }

    /// Hot-reload the manifest from operator-supplied bytes
    /// (Batch 72 Sprint 6.1 follow-up MQTT `update_policy`
    /// handler path).
    ///
    /// On success:
    /// 1. Verified manifest is swapped into `self.current`
    ///    under RwLock write-guard (atomic — readers observe
    ///    either old or new, never partial).
    /// 2. Bytes are persisted to `manifest_path_override` (or
    ///    the default `/etc/suderra/rbac_manifest.json`) via
    ///    atomic tempfile + rename, so a subsequent agent
    ///    reboot loads the new manifest from disk.
    /// 3. Returns the new policy_version.
    ///
    /// On failure: `self.current` is UNCHANGED. This matches
    /// the fail-closed discipline of `load_from_file`: if the
    /// new manifest is invalid (bad signature, tenant mismatch,
    /// rollback attempt), the agent keeps operating under the
    /// previously-verified manifest rather than regressing.
    ///
    /// WHY atomic file persist: an agent restart must load the
    /// SAME manifest that's currently in memory. A write-failure
    /// mid-persistence could leave a partial file that next-boot
    /// fails to parse — the tempfile+rename pattern ensures the
    /// file is either the OLD content or the COMPLETE NEW content.
    pub fn hot_reload_from_bytes(
        &self,
        signing_pubkey_hex: Option<&str>,
        bytes: &[u8],
        expected_tenant: &TenantId,
        manifest_path_override: Option<&Path>,
    ) -> Result<u64, String> {
        let verified = self.verify_and_floor(signing_pubkey_hex, bytes, expected_tenant)?;
        let new_version = verified.policy_version;

        // In-memory atomic swap. Must happen BEFORE disk write
        // because the RwLock write-guard is the authoritative
        // SSoT — if disk write fails after in-memory swap, the
        // agent keeps serving the new manifest and logs the
        // persistence failure. The alternative (disk-first)
        // creates a window where a crash between disk-write and
        // memory-swap leaves disk ahead of memory.
        match self.current.write() {
            Ok(mut guard) => {
                *guard = Some(verified);
            }
            Err(_) => {
                return Err(
                    "RwLock poisoned on RBAC manifest hot-reload swap".to_string(),
                );
            }
        }

        // Atomic disk persist: tempfile in same dir + rename.
        // Same-dir requirement ensures rename() is within the
        // filesystem boundary (cross-fs rename is not atomic).
        let path = manifest_path_override
            .map(Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from(DEFAULT_MANIFEST_PATH));

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Hot-reload disk persist: mkdir {} failed: {} (in-memory swap succeeded, policy_version={})",
                    parent.display(),
                    e,
                    new_version
                )
            })?;
        }

        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, bytes).map_err(|e| {
            format!(
                "Hot-reload disk persist: tempfile write to {} failed: {} (in-memory swap succeeded, policy_version={})",
                tmp_path.display(),
                e,
                new_version
            )
        })?;
        std::fs::rename(&tmp_path, &path).map_err(|e| {
            // Rename failed — attempt to clean up tempfile.
            let _ = std::fs::remove_file(&tmp_path);
            format!(
                "Hot-reload disk persist: rename {} → {} failed: {} (in-memory swap succeeded, policy_version={})",
                tmp_path.display(),
                path.display(),
                e,
                new_version
            )
        })?;

        info!(
            "RBAC manifest hot-reloaded: policy_version={} persisted={}",
            new_version,
            path.display()
        );
        Ok(new_version)
    }

    /// Look up an operator's ed25519 pubkey bytes from the
    /// verified manifest. Returns None when:
    /// - Store is empty (manifest not loaded — Disabled mode,
    ///   or Permissive mode with load failure).
    /// - Operator not in the manifest's operator_bindings.
    /// - RwLock poisoned (treated as miss; logged by caller).
    pub fn lookup_operator_pubkey(
        &self,
        operator_id: &OperatorId,
    ) -> Option<[u8; 32]> {
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
        self.current
            .read()
            .ok()
            .and_then(|g| g.as_ref().map(|m| (m.operator_bindings.len(), m.roles.len())))
    }

    /// Snapshot-observer helper: returns whether the store
    /// currently has a verified manifest loaded.
    ///
    /// Used by the boot-banner follow-up + Sprint 6.1
    /// cmd_get_config expansion.
    pub fn is_loaded(&self) -> bool {
        self.current
            .read()
            .map(|g| g.is_some())
            .unwrap_or(false)
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
}

impl Default for RbacManifestStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse a 64-char hex ed25519 pubkey into VerifyingKey.
/// Mirrors `config_integrity::verify_runtime::parse_factory_
/// pubkey` — same hex discipline, different key role.
fn parse_ed25519_pubkey_hex(hex: &str) -> Result<ed25519_dalek::VerifyingKey, String> {
    if hex.len() != 64 {
        return Err(format!(
            "manifest_signing_pubkey_hex must be 64 chars, got {}",
            hex.len()
        ));
    }
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        let byte_idx = i * 2;
        let hex_byte = hex
            .get(byte_idx..byte_idx + 2)
            .ok_or_else(|| format!("hex slice error at index {}", byte_idx))?;
        *b = u8::from_str_radix(hex_byte, 16)
            .map_err(|e| format!("invalid hex at byte {}: {}", i, e))?;
    }
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map_err(|e| format!("ed25519 key construction failed: {}", e))
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
