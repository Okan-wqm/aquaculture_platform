//! RbacManifestStore runtime loader (Batch 67, Sprint 6.1
//! full wire partial).
//!
//! Holds the VERIFIED RBAC manifest in memory + exposes the
//! operator→pubkey lookup that the CommandEnvelope Gate 7
//! signature verify path will consume (Sprint 6.1 full wire
//! Gate 7 swap planned as Batch 68+).
//!
//! The store is populated at boot by `load_from_files`:
//! 1. Reads the JSON files [`boot_manifest_candidates`] resolves from the
//!    agent's path SSoT (ADR-048 DEC-4.5) and keeps the verified one with
//!    the highest `policy_version`.
//! 2. Deserializes as `SignedRbacManifest`.
//! 3. Calls the Batch 5b pure `verify_manifest` with
//!    closure-injected ed25519 via `ed25519_dalek`.
//! 4. On Ok, stores the verified `RbacManifest` in
//!    `self.current`.
//! 5. On Err, routes per mode (Permissive warn-logs +
//!    continues with empty store; Enforcing returns Err →
//!    degraded mode after the boot safe-state).
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
#[cfg(not(feature = "suderra-os"))]
use std::sync::Arc;
use std::sync::RwLock;

use tracing::info;
#[cfg(not(feature = "suderra-os"))]
use tracing::warn;

#[cfg(not(feature = "suderra-os"))]
use super::manifest::SignedRbacManifest;
use super::manifest::{OperatorBinding, RbacManifest};
#[cfg(not(feature = "suderra-os"))]
use super::manifest_version_store::ManifestVersionStore;
use super::permission::OperatorId;
#[cfg(not(feature = "suderra-os"))]
use super::permission::TenantId;
#[cfg(not(feature = "suderra-os"))]
use super::verify::manifest_digest;
#[cfg(not(feature = "suderra-os"))]
use crate::config::RbacManifestMode;

/// The manifest files the generic boot loader considers (ADR-048 DEC-4.5):
/// the copy a previous `update_policy` persisted under the data root, and
/// the operator's `rbac_manifest.manifest_path` (else
/// `/etc/suderra/rbac_manifest.json`). Both channels deliver manifests, so
/// neither may silently shadow the other: the boot loader verifies every
/// candidate that exists and keeps the one with the highest
/// `policy_version` ([`RbacManifestStore::load_from_files`]). Before, the
/// persisted copy always won once it existed, and a newer manifest rolled
/// out through configuration management was ignored forever.
///
/// The Suderra OS manifest is the site statement, verified with the site
/// (`crate::site_trust`).
#[cfg(not(feature = "suderra-os"))]
pub fn boot_manifest_candidates(
    paths: &crate::paths::AgentPaths,
    configured: Option<&Path>,
) -> [PathBuf; 2] {
    [
        paths.rbac_manifest_persist_file(),
        configured
            .map(Path::to_path_buf)
            .unwrap_or_else(|| paths.rbac_manifest_file()),
    ]
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
    #[cfg(not(feature = "suderra-os"))]
    version_store: Option<Arc<ManifestVersionStore>>,
}

impl RbacManifestStore {
    /// Construct an empty store (no manifest loaded, no
    /// version persistence). Tests + pre-Batch-71 code paths.
    pub fn new() -> Self {
        Self {
            current: RwLock::new(None),
            #[cfg(not(feature = "suderra-os"))]
            version_store: None,
        }
    }

    /// Attach a persistent version store (Batch 71). Builder-
    /// style so existing `RbacManifestStore::new()` call sites
    /// keep working; AppState wires the version store via
    /// `init_rbac_manifest_store` when `rbac_manifest.mode !=
    /// Disabled`.
    #[cfg(not(feature = "suderra-os"))]
    pub fn with_version_store(mut self, store: Arc<ManifestVersionStore>) -> Self {
        self.version_store = Some(store);
        self
    }

    /// Load + verify the boot manifest from disk: the verified candidate
    /// with the highest `policy_version`.
    ///
    /// INPUTS:
    /// - `mode` — operator-configured rollout stage.
    /// - `signing_pubkey_hex` — 64-char hex ed25519 pubkey
    ///   for signature verify. Required in Permissive/
    ///   Enforcing mode (Batch 66 Rule 12 enforces at config
    ///   load).
    /// - `candidates` — the manifest files ([`boot_manifest_candidates`]);
    ///   one that does not exist is skipped.
    /// - `expected_tenant` — TenantId from provisioning
    ///   bound to this device.
    ///
    /// OUTPUT:
    /// - `Ok(())` — Disabled mode (skip), or Permissive mode
    ///   (log failure + continue), or Enforcing mode with
    ///   successful verify.
    /// - `Err(String)` — Enforcing mode with verify failure;
    ///   the caller enters degraded mode after the boot safe-state.
    #[cfg(not(feature = "suderra-os"))]
    pub fn load_from_files(
        &self,
        mode: RbacManifestMode,
        signing_pubkey_hex: Option<&str>,
        candidates: &[&Path],
        expected_tenant: &TenantId,
    ) -> Result<(), String> {
        if matches!(mode, RbacManifestMode::Disabled) {
            info!("RBAC manifest load skipped: mode=Disabled (HC-1 backward compat)");
            return Ok(());
        }

        info!(
            "RBAC manifest load: mode={:?} candidates={:?}",
            mode, candidates
        );

        let outcome = self.load_from_files_inner(signing_pubkey_hex, candidates, expected_tenant);

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

    /// Inner load — verifies every candidate that exists against the floor
    /// ([`LoadKind::Boot`](super::verify::LoadKind)), keeps the verified one
    /// with the highest `policy_version`, then advances the floor to it.
    /// Two different verified manifests at that version are ambiguous and
    /// refused. Returns the chosen RbacManifest or Err(reason).
    #[cfg(not(feature = "suderra-os"))]
    fn load_from_files_inner(
        &self,
        signing_pubkey_hex: Option<&str>,
        candidates: &[&Path],
        expected_tenant: &TenantId,
    ) -> Result<RbacManifest, String> {
        let mut rejected = Vec::new();
        let mut verified: Vec<(RbacManifest, String, &Path)> = Vec::new();
        for path in candidates {
            let bytes = match std::fs::read(path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    rejected.push(format!("{}: read failed: {}", path.display(), e));
                    continue;
                }
            };
            match self.verify_against_floor(
                signing_pubkey_hex,
                &bytes,
                expected_tenant,
                super::verify::LoadKind::Boot,
            ) {
                Ok((manifest, digest)) => verified.push((manifest, digest, path)),
                Err(e) => rejected.push(format!("{}: {}", path.display(), e)),
            }
        }
        for reason in &rejected {
            warn!("RBAC manifest candidate not used: {}", reason);
        }
        let Some(top) = verified.iter().map(|(m, _, _)| m.policy_version).max() else {
            return Err(if rejected.is_empty() {
                format!("no RBAC manifest at any of {:?}", candidates)
            } else {
                rejected.join("; ")
            });
        };
        let mut at_top = verified
            .into_iter()
            .filter(|(m, _, _)| m.policy_version == top);
        let Some((manifest, digest, path)) = at_top.next() else {
            return Err(format!("no RBAC manifest at policy_version {top}"));
        };
        if let Some((_, other_digest, other_path)) = at_top.find(|(_, d, _)| *d != digest) {
            return Err(format!(
                "{} and {} are different manifests at policy_version {} (digests {} and {}); \
                 neither is used",
                path.display(),
                other_path.display(),
                top,
                digest,
                other_digest
            ));
        }
        info!(
            "RBAC manifest boot source: {} (policy_version={}, the highest verified of {} \
             candidate(s))",
            path.display(),
            top,
            candidates.len()
        );
        self.advance_floor(manifest.policy_version, &digest)?;
        Ok(manifest)
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
    #[cfg(not(feature = "suderra-os"))]
    fn verify_against_floor(
        &self,
        signing_pubkey_hex: Option<&str>,
        bytes: &[u8],
        expected_tenant: &TenantId,
        kind: super::verify::LoadKind,
    ) -> Result<(RbacManifest, String), String> {
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
        // EDGE-HIGH-059: the record carries the digest of the manifest
        // accepted at the floor, so the boot reload of that very manifest
        // is a re-verification instead of a rejected replay.
        let accepted = match &self.version_store {
            Some(vs) => vs.get_accepted()?,
            None => super::verify::AcceptedVersion::default(),
        };

        let verify_fn = |canonical: &[u8], sig_bytes: &[u8; 64]| -> bool {
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            pubkey.verify_strict(canonical, &sig).is_ok()
        };

        let verified = super::verify::verify_manifest(
            &signed,
            expected_tenant,
            &accepted,
            kind,
            std::time::SystemTime::now(),
            verify_fn,
        )
        .map_err(|e| format!("{:?}", e))?;
        let digest = manifest_digest(&verified).map_err(|e| format!("{:?}", e))?;

        Ok((verified, digest))
    }

    /// Batch 71 rollback-protection write: advance the persisted floor to
    /// an accepted manifest's version. UPSERT keeps
    /// MAX(existing, policy_version) — idempotent on re-load of the same
    /// manifest across a process restart.
    #[cfg(not(feature = "suderra-os"))]
    fn advance_floor(&self, policy_version: u64, digest: &str) -> Result<(), String> {
        if let Some(vs) = &self.version_store {
            let new_floor = vs.record_accepted_with_digest(policy_version, digest)?;
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
    ///    considers ([`boot_manifest_candidates`]).
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
    /// the fail-closed discipline of `load_from_files`: if the
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
        let (verified, digest) = self.verify_against_floor(
            signing_pubkey_hex,
            bytes,
            expected_tenant,
            super::verify::LoadKind::Update,
        )?;
        let new_version = verified.policy_version;

        persist_manifest_bytes(persist_path, bytes).map_err(|e| {
            format!(
                "Hot-reload disk persist to {} failed: {} (nothing applied, policy_version={} not accepted)",
                persist_path.display(),
                e,
                new_version
            )
        })?;

        self.advance_floor(new_version, &digest)?;

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
    /// (`load_from_files`, `hot_reload_from_bytes`) enforce
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

/// The Suderra OS agent's RBAC version gate (contract mutable-state.json
/// policy-cache contents, DEC-9.9): `policy_version` and statement digest
/// of the manifest it accepted.
#[cfg(feature = "suderra-os")]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RbacGateRecord {
    /// Accepted `policy_version`.
    pub policy_version: u64,
    /// Statement digest (SHA-256 of the DSSE payload) of that manifest.
    pub statement_digest: String,
}

#[cfg(feature = "suderra-os")]
impl RbacGateRecord {
    /// Reads the gate; `None` before the first acceptance.
    pub fn read(path: &Path) -> Result<Option<Self>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("RBAC version gate {}: {}", path.display(), e)),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("RBAC version gate {} is corrupt: {}", path.display(), e))
    }

    /// Durably writes the gate (0600; temporary name, fsync, rename,
    /// directory fsync).
    pub fn write(&self, path: &Path) -> Result<(), String> {
        crate::shared_io::atomic_json_sidecar::write_atomic_json_owner_only(path, self)
            .map_err(|e| e.to_string())
    }
}

#[cfg(feature = "suderra-os")]
impl RbacManifestStore {
    /// Makes a verified `suderra.rbac-manifest.v1` statement the store's
    /// manifest (DEC-9.4, DEC-9.9).
    ///
    /// The statement reaches this point only through
    /// [`crate::site_trust::SiteTrust::establish`]: verified as the
    /// contract's agent verifier does it, against the `rbac-manifest` anchor
    /// of the verified trust-anchors bundle and the device's tenant, every
    /// actor key a `command` anchor of the same bundle, the manifest the
    /// verified site config names, and admitted by the agent's RBAC version
    /// gate, which was advanced durably before this call. On a manifest the
    /// agent's permission vocabulary cannot represent the store is left
    /// unchanged: with no manifest every permissioned command is refused.
    pub fn install_contract(
        &self,
        verified: &crate::edge_contract::verify::Verified<
            crate::edge_contract::statements::RbacManifest,
        >,
    ) -> Result<u64, String> {
        let manifest = runtime_manifest_from_contract(&verified.statement)?;
        let policy_version = manifest.policy_version;
        match self.current.write() {
            Ok(mut guard) => *guard = Some(manifest),
            Err(_) => return Err("RwLock poisoned on RBAC manifest store write".to_string()),
        }
        info!(
            "RBAC manifest statement installed: policy_version={} reverified={} digest={}",
            policy_version, verified.reverified, verified.digest
        );
        Ok(policy_version)
    }
}

/// Unix seconds of a contract timestamp (`YYYY-MM-DDTHH:MM:SSZ`, already
/// schema-validated).
#[cfg(feature = "suderra-os")]
fn contract_unix_secs(timestamp: &str) -> Result<i64, String> {
    chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H:%M:%SZ")
        .map(|t| t.and_utc().timestamp())
        .map_err(|e| format!("timestamp {timestamp:?}: {e}"))
}

/// A contract UUID as the 16 bytes the agent's identifiers carry.
#[cfg(feature = "suderra-os")]
fn contract_uuid_bytes(text: &str) -> Result<[u8; 16], String> {
    uuid::Uuid::parse_str(text)
        .map(|u| *u.as_bytes())
        .map_err(|e| format!("UUID {text:?}: {e}"))
}

/// The engine's view of a verified contract RBAC manifest. Every
/// permission must be one of the agent's `Permission` vocabulary, and none
/// may be of the two-person-integrity class: contract 1.x cannot grant one
/// (DEC-9.4), so finding one means the schema and the agent disagree and
/// the manifest is refused.
#[cfg(feature = "suderra-os")]
pub fn runtime_manifest_from_contract(
    m: &crate::edge_contract::statements::RbacManifest,
) -> Result<RbacManifest, String> {
    use super::manifest::{CustomRole, Ed25519PublicKeyBytes};
    use super::permission::{Permission, TenantId};
    use crate::edge_contract::encoding::decode_base64_array;

    let operator_bindings = m
        .actors
        .iter()
        .map(|actor| {
            Ok(OperatorBinding {
                operator_id: OperatorId::new_from_verified(contract_uuid_bytes(&actor.actor_id)?),
                pubkey: Ed25519PublicKeyBytes::from_bytes(
                    decode_base64_array::<32>(&actor.public_key)
                        .ok_or_else(|| format!("actor {} public_key", actor.actor_id))?,
                ),
                role_names: actor.roles.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let roles = m
        .roles
        .iter()
        .map(|role| {
            let permissions = role
                .permissions
                .iter()
                .map(|value| {
                    let permission: Permission = serde_json::from_value(value.clone())
                        .map_err(|e| format!("role {} permission {value}: {e}", role.name))?;
                    if permission.requires_two_person_integrity() {
                        return Err(format!(
                            "role {} grants two-person-integrity permission {value}, which no \
                             contract 1.x manifest can carry (ADR-048 DEC-9.4)",
                            role.name
                        ));
                    }
                    Ok(permission)
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(CustomRole {
                name: role.name.clone(),
                permissions,
                valid_from_unix_secs: contract_unix_secs(&role.not_before)?,
                valid_until_unix_secs: contract_unix_secs(&role.expires_at)?,
                is_emergency_role: false,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(RbacManifest {
        policy_version: m.policy_version,
        tenant_id: TenantId::new_from_verified(contract_uuid_bytes(&m.tenant_id)?),
        manifest_valid_from_unix_secs: contract_unix_secs(&m.not_before)?,
        manifest_valid_until_unix_secs: contract_unix_secs(&m.expires_at)?,
        operator_bindings,
        roles,
    })
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
#[cfg(not(feature = "suderra-os"))]
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

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn parse_ed25519_pubkey_rejects_short_hex() {
        assert!(parse_ed25519_pubkey_hex("abcd").is_err());
    }

    #[cfg(not(feature = "suderra-os"))]
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

    /// EDGE-HIGH-059 migration: a device upgraded from an agent whose hot
    /// reload advanced the floor without recording a digest boots in
    /// Enforcing on the manifest it accepted, and the adoption records the
    /// digest, so a different manifest at that version is refused from then
    /// on and a hot reload at it never adopts.
    #[test]
    fn an_enforcing_boot_adopts_the_manifest_at_a_legacy_floor_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (_, vs) = store_with_floor(dir.path());
        // What a pre-EDGE-HIGH-059 hot reload left: floor 5, no digest.
        assert_eq!(vs.record_accepted(5).expect("legacy floor"), 5);
        assert_eq!(vs.get_accepted().expect("read").digest, None);
        let (hex, bytes) = signed(5);
        let path = dir.path().join("rbac_manifest.json");
        std::fs::write(&path, &bytes).expect("seed");

        // A hot reload at the legacy floor is still a replay.
        let reload = RbacManifestStore::new().with_version_store(vs.clone());
        assert!(
            reload
                .hot_reload_from_bytes(Some(&hex), &bytes, &tenant(), &dir.path().join("p.json"))
                .is_err()
        );

        let boot = RbacManifestStore::new().with_version_store(vs.clone());
        boot.load_from_files(RbacManifestMode::Enforcing, Some(&hex), &[&path], &tenant())
            .expect("the accepted manifest boots");
        assert_eq!(boot.policy_version(), Some(5));
        let digest = vs
            .get_accepted()
            .expect("read")
            .digest
            .expect("digest recorded");
        let signed_manifest: SignedRbacManifest = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(
            Ok(digest),
            manifest_digest(&signed_manifest.manifest).map_err(|e| format!("{e:?}"))
        );

        // Reboot: an identical re-verification.
        RbacManifestStore::new()
            .with_version_store(vs.clone())
            .load_from_files(RbacManifestMode::Enforcing, Some(&hex), &[&path], &tenant())
            .expect("reboot");
        // Another manifest at the adopted version is now a replay.
        let sk = SigningKey::from_bytes(&[42u8; SECRET_KEY_LENGTH]);
        let mut other = signed_manifest;
        other.manifest.policy_version = 5;
        other.manifest.manifest_valid_until_unix_secs += 1;
        let sig = sk.sign(&other.manifest.canonical_bytes().expect("canonical"));
        other.signature = Ed25519SignatureBytes::from_slice(&sig.to_bytes()).expect("sig");
        std::fs::write(&path, serde_json::to_vec(&other).expect("json")).expect("swap");
        let replay = RbacManifestStore::new().with_version_store(vs);
        assert!(
            replay
                .load_from_files(RbacManifestMode::Enforcing, Some(&hex), &[&path], &tenant())
                .is_err()
        );
        assert!(!replay.is_loaded());
    }

    /// EDGE-HIGH-059: a reboot reloads the manifest the floor already
    /// stands at; it is accepted again, while another manifest at that
    /// version is still refused as a replay.
    #[test]
    fn reboot_reaccepts_the_accepted_manifest_and_refuses_a_replay() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (store, vs) = store_with_floor(dir.path());
        let (hex, bytes) = signed(5);
        let path = dir.path().join("rbac_manifest.json");
        std::fs::write(&path, &bytes).expect("seed");
        store
            .load_from_files(RbacManifestMode::Enforcing, Some(&hex), &[&path], &tenant())
            .expect("first boot");
        let reboot = RbacManifestStore::new().with_version_store(vs.clone());
        reboot
            .load_from_files(RbacManifestMode::Enforcing, Some(&hex), &[&path], &tenant())
            .expect("second boot accepts its own manifest");
        assert_eq!(reboot.policy_version(), Some(5));

        // Same version, different body: a replay.
        let sk = SigningKey::from_bytes(&[42u8; SECRET_KEY_LENGTH]);
        let mut other: SignedRbacManifest = serde_json::from_slice(&bytes).expect("parse");
        other.manifest.operator_bindings.push(OperatorBinding {
            operator_id: OperatorId::new_from_verified([9u8; 16]),
            pubkey: crate::authz::manifest::Ed25519PublicKeyBytes::from_bytes([1u8; 32]),
            role_names: Vec::new(),
        });
        let sig = sk.sign(&other.manifest.canonical_bytes().expect("canonical"));
        other.signature = Ed25519SignatureBytes::from_slice(&sig.to_bytes()).expect("sig");
        std::fs::write(&path, serde_json::to_vec(&other).expect("json")).expect("swap");
        let replay = RbacManifestStore::new().with_version_store(vs);
        assert!(
            replay
                .load_from_files(RbacManifestMode::Enforcing, Some(&hex), &[&path], &tenant())
                .is_err()
        );
        assert!(!replay.is_loaded());
    }

    /// m8: the boot loader verifies the persisted hot-reload copy and the
    /// operator's file and keeps the higher verified `policy_version`, in
    /// either direction; a stale candidate is skipped, not fatal.
    #[test]
    fn boot_keeps_the_higher_of_the_persisted_copy_and_the_operator_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = crate::paths::AgentPaths::generic(crate::paths::GenericOverrides {
            data_root: Some(dir.path().to_path_buf()),
            ..Default::default()
        });
        let operator = dir.path().join("operator-rbac.json");
        let [persisted, configured] = boot_manifest_candidates(&paths, Some(&operator));
        assert_eq!(persisted, paths.rbac_manifest_persist_file());
        assert_eq!(configured, operator);
        assert_eq!(
            boot_manifest_candidates(&paths, None)[1],
            Path::new("/etc/suderra/rbac_manifest.json")
        );
        let (_, vs) = store_with_floor(dir.path());
        let (hex, v5) = signed(5);
        let (_, v6) = signed(6);
        let boot = |vs: &Arc<ManifestVersionStore>| {
            let store = RbacManifestStore::new().with_version_store(vs.clone());
            store
                .load_from_files(
                    RbacManifestMode::Enforcing,
                    Some(&hex),
                    &[&persisted, &configured],
                    &tenant(),
                )
                .map(|()| store.policy_version())
        };
        // update_policy persisted v5; configuration management delivers v6.
        std::fs::write(&persisted, &v5).expect("persisted");
        assert_eq!(boot(&vs), Ok(Some(5)), "only the persisted copy exists");
        std::fs::write(&configured, &v6).expect("operator");
        assert_eq!(boot(&vs), Ok(Some(6)), "the newer operator file wins");
        assert_eq!(vs.get_highest_seen().expect("floor"), 6);
        // The stale persisted copy is skipped on every later boot.
        assert_eq!(boot(&vs), Ok(Some(6)));
        // Two different manifests at one version: neither is used.
        let (_, v7) = signed(7);
        let mut other: SignedRbacManifest = serde_json::from_slice(&v7).expect("parse");
        other.manifest.manifest_valid_until_unix_secs += 1;
        let sk = SigningKey::from_bytes(&[42u8; SECRET_KEY_LENGTH]);
        let sig = sk.sign(&other.manifest.canonical_bytes().expect("canonical"));
        other.signature = Ed25519SignatureBytes::from_slice(&sig.to_bytes()).expect("sig");
        std::fs::write(&persisted, &v7).expect("persisted v7");
        std::fs::write(&configured, serde_json::to_vec(&other).expect("json")).expect("v7'");
        let err = boot(&vs).expect_err("ambiguous");
        assert!(
            err.contains("different manifests at policy_version 7"),
            "{err}"
        );
        assert_eq!(vs.get_highest_seen().expect("floor"), 6, "nothing accepted");
        // No candidate at all fails closed in Enforcing.
        std::fs::remove_file(&persisted).expect("rm");
        std::fs::remove_file(&configured).expect("rm");
        assert!(boot(&vs).expect_err("none").starts_with("no RBAC manifest"));
    }
}

/// DEC-9.4 / DEC-9.9: installing the contract's golden RBAC manifest
/// verified against the bundle and device. The version gate and the
/// statement checks are `crate::site_trust`'s (its tests).
#[cfg(all(test, feature = "suderra-os"))]
mod contract_statement_tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;
    use crate::authz::permission::Permission;
    use crate::edge_contract::dsse::Envelope;
    use crate::edge_contract::verify::verify_rbac;
    use crate::trust_anchors::test_support::{FIXTURE_NOW, fixture, fixture_trust};

    const POLICY_1: &str = "rbac-manifest/valid/platform-actor-policy-1.dsse.json";

    #[test]
    fn the_platform_actor_maps_to_the_bundle_command_key() {
        let (_root, trust) = fixture_trust("trust-anchors/valid/bundle-seq-1.dsse.json");
        let env = Envelope::parse(&fixture(POLICY_1)).unwrap();
        let no_gates = std::collections::BTreeMap::new();
        let verified = verify_rbac(
            &env,
            &trust.scope(&no_gates, FIXTURE_NOW),
            trust.bundle_keys(),
        )
        .accepted()
        .unwrap();
        let store = RbacManifestStore::new();
        assert_eq!(store.install_contract(&verified), Ok(1));
        let (keyid, command) = trust
            .bundle_keys()
            .of_purpose(crate::edge_contract::registry::Purpose::Command)
            .next()
            .expect("command anchor");
        assert_eq!(keyid.len(), 64);
        let actor = store
            .with_manifest(|m| m.operator_bindings[0].operator_id.clone())
            .expect("loaded");
        assert_eq!(store.lookup_operator_pubkey(&actor), Some(command.raw));
        assert!(
            store
                .with_manifest(|m| m.roles.iter().all(|r| r
                    .permissions
                    .iter()
                    .all(|p| !p.requires_two_person_integrity())))
                .unwrap()
        );
    }

    #[test]
    fn a_two_person_permission_is_refused_even_if_a_schema_let_it_through() {
        let manifest: crate::edge_contract::statements::RbacManifest =
            serde_json::from_value(serde_json::json!({
                "_type": "suderra.rbac-manifest.v1",
                "tenant_id": "7e570000-0000-4000-8000-000000000001",
                "policy_version": 1,
                "not_before": "2026-10-01T00:00:00Z",
                "expires_at": "2027-10-01T00:00:00Z",
                "actors": [{
                    "actor_id": "7e570000-0000-4000-8000-0000000000a1",
                    "kind": "platform",
                    "keyid": "0000000000000000000000000000000000000000000000000000000000000000",
                    "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                    "roles": ["platform-authenticated"],
                }],
                "roles": [{
                    "name": "platform-authenticated",
                    "permissions": ["ReadTag", "Reboot"],
                    "not_before": "2026-10-01T00:00:00Z",
                    "expires_at": "2027-10-01T00:00:00Z",
                }],
            }))
            .unwrap();
        let err = runtime_manifest_from_contract(&manifest).unwrap_err();
        assert!(err.contains("two-person-integrity"), "{err}");
        assert!(Permission::Reboot.requires_two_person_integrity());
    }
}
