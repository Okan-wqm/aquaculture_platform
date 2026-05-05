//! RBAC manifest hot-reload command handler (Batch 72 Sprint
//! 6.1 follow-up — MQTT `update_policy`).
//!
//! WHY this exists:
//!   Batch 67+68 landed boot-time manifest load; Batch 71
//!   added persistent rollback-protection floor. Operators
//!   still needed agent-restart to pick up a new manifest.
//!   Plan §5 Faz 2 item 4 mandates MQTT-driven hot-reload so
//!   policy rotation (e.g., revoking a compromised operator
//!   binding) propagates in seconds, not in a maintenance
//!   window.
//!
//! WHAT this handler does:
//!   1. Reads `signed_manifest` JSON from command params —
//!      the SignedRbacManifest wire shape (same as disk file).
//!   2. Resolves expected_tenant from AppState.tenant_id (the
//!      device's provisioning-bound tenant).
//!   3. Resolves manifest signing pubkey from config.
//!   4. Delegates to RbacManifestStore::hot_reload_from_bytes
//!      which runs the full verify chain (signature + tenant
//!      binding + version monotonicity against persistent
//!      floor) + atomic in-memory swap + atomic disk persist.
//!   5. Returns the new policy_version on success.
//!
//! WHAT this handler does NOT do (roadmap — each item has an
//! explicit next-sprint owner per plan §5 Faz 2):
//!   - Audit event emission — Phase 2 / Sprint 6.2 audit sink
//!     lands the HMAC-chained audit writer; pre-Sprint-6.2
//!     paths use structured logs only.
//!   - Rate-limit — the RateLimiter in helpers.rs already
//!     gates command dispatch, shared across all commands.
//!   - Emergency break-glass path — Phase 2 / Sprint 6.1
//!     final step per plan §3.1 R-5 + ADR-018 specifies
//!     `/etc/suderra/emergency_policy.json.sig` read-only
//!     partition.
//!
//! AUTHZ: requires Permission::ManagePolicy via the
//!   `required_permission::permission_for_command` table —
//!   enforced before this handler runs.

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::authz::permission::TenantId;
use crate::config::RbacManifestMode;
use crate::security::sanitize_for_log;

impl CommandHandler {
    /// `update_policy` — hot-reload RBAC manifest.
    ///
    /// Params (required):
    /// - `signed_manifest: object` — a JSON-serialized
    ///   SignedRbacManifest (manifest + ed25519 signature).
    ///
    /// Returns:
    /// - On success: `{"policy_version": N, "operator_count": M,
    ///   "role_count": K}`.
    /// - On failure: structured error with `reason` field.
    pub(super) async fn cmd_update_policy(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing update_policy command (Sprint 6.1 hot-reload)");

        // Extract signed_manifest param as a JSON Value (we
        // re-serialize to bytes for the verify path — keeps
        // the wire format identical to the disk loader).
        let signed_manifest = match params.get("signed_manifest") {
            Some(v) => v,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "Missing 'signed_manifest' parameter — expected \
                         SignedRbacManifest JSON object"
                            .to_string(),
                    ),
                );
            }
        };

        let bytes = match serde_json::to_vec(signed_manifest) {
            Ok(b) => b,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Failed to re-serialize signed_manifest param: {}",
                        e
                    )),
                );
            }
        };

        // Snapshot the wiring we need from AppState under the
        // read-guard, then drop the guard before the blocking
        // verify/disk work runs. Avoids holding the state
        // read-lock across filesystem IO.
        let (
            mode,
            pubkey_hex,
            manifest_path_override,
            tenant_id_str,
            rbac_store,
        ) = {
            let state = self.state.read().await;
            (
                state.config.rbac_manifest.mode,
                state.config.rbac_manifest.manifest_signing_pubkey_hex.clone(),
                state.config.rbac_manifest.manifest_path.clone(),
                state.tenant_id.clone(),
                state.rbac_manifest_store.clone(),
            )
        };

        if matches!(mode, RbacManifestMode::Disabled) {
            warn!(
                "update_policy rejected: rbac_manifest.mode=Disabled. \
                 Hot-reload requires Permissive or Enforcing."
            );
            return (
                false,
                json!(null),
                Some(
                    "rbac_manifest.mode=Disabled — hot-reload unavailable. \
                     Change mode to Permissive or Enforcing in config and restart."
                        .to_string(),
                ),
            );
        }

        let tenant_str = match tenant_id_str {
            Some(t) => t,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "update_policy rejected: tenant_id is None \
                         (device not yet provisioned). Complete provisioning first."
                            .to_string(),
                    ),
                );
            }
        };

        let uuid = match uuid::Uuid::parse_str(&tenant_str) {
            Ok(u) => u,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "update_policy rejected: tenant_id UUID parse failed: {}",
                        sanitize_for_log(&e.to_string())
                    )),
                );
            }
        };
        let expected_tenant = TenantId::new_from_verified(*uuid.as_bytes());

        match rbac_store.hot_reload_from_bytes(
            pubkey_hex.as_deref(),
            &bytes,
            &expected_tenant,
            manifest_path_override.as_deref(),
        ) {
            Ok(new_version) => {
                // Re-read the swapped manifest to surface
                // operator_count + role_count in the response.
                // The store's in-memory snapshot is already the
                // new one at this point.
                let (op_count, role_count) = rbac_store
                    .snapshot_counts()
                    .unwrap_or((0, 0));
                info!(
                    "update_policy SUCCESS: policy_version={} operators={} roles={}",
                    new_version, op_count, role_count
                );
                (
                    true,
                    json!({
                        "policy_version": new_version,
                        "operator_count": op_count,
                        "role_count": role_count,
                    }),
                    None,
                )
            }
            Err(reason) => {
                warn!(
                    "update_policy REJECTED: {}",
                    sanitize_for_log(&reason)
                );
                (
                    false,
                    json!({
                        "reason": reason.clone(),
                    }),
                    Some(format!("Manifest verify failed: {}", reason)),
                )
            }
        }
    }
}
