//! `cmd_refresh_license` — signed-manifest license push
//! (Batch 143 Faz 7).
//!
//! ## WHY
//!
//! Plan §3 R-10 + §5 Faz 7 specify two license-delivery
//! paths:
//! 1. Boot-time fetch from cloud
//!    `GET /billing/edge-license/:tenantId` (Faz 8
//!    platform).
//! 2. Cloud-pushed MQTT command when the operator
//!    rotates tier (upgrade / downgrade / custom
//!    contract terms).
//!
//! This batch lands path (2) — the cloud-signed license
//! manifest arrives as an MQTT command payload, gets
//! verified against the firmware_signing_pubkey (plan
//! R-10 key-reuse), + swaps into
//! `AppState.license` so subsequent cmd_deploy_program
//! + future enforcement hooks read the new tier.
//!
//! ## Authorization
//!
//! Gated by `Permission::ManagePolicy` — license is a
//! trust-anchor rotation (governs every other per-tier
//! gate). Same privilege class as `update_policy`
//! (RBAC manifest rotation) + `rotate_master` (keystore
//! rotation).
//!
//! ## NOT in scope
//!
//! - SQLCipher persistence (Batch 144 / `license_cache`).
//!   The current command mutates in-memory only; on
//!   agent restart the license reverts to
//!   conservative() fallback until platform fetch
//!   lands.
//! - HTTP fetch path (Faz 8 cross-repo work).
//! - Rollback-on-verify-reject (the RbacManifest
//!   equivalent persists highest_seen separately; Faz 7
//!   follows same discipline in Batch 144).

use std::sync::Arc;

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::license::{
    verify_license_manifest, SignedLicenseManifest,
};
use crate::security::sanitize_for_log;

impl CommandHandler {
    /// `refresh_license` — apply a cloud-signed
    /// SignedLicenseManifest payload.
    ///
    /// Params:
    /// - `manifest`: SignedLicenseManifest JSON body
    ///   (required).
    ///
    /// Returns on success:
    ///   {
    ///     "applied": true,
    ///     "tier": "starter" | "professional" | "enterprise" | "custom",
    ///     "policy_version": u64,
    ///     "valid_until_unix_secs": i64
    ///   }
    ///
    /// On verify failure: pass-through gate label from
    /// `LicenseVerifyError`.
    pub(super) async fn cmd_refresh_license(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing refresh_license command (Faz 7 Batch 143)");

        // Pull AppState slices under single read-guard —
        // same pattern as cmd_apply_signed_manifest.
        // Batch 145 Faz 7: read highest_seen from the
        // SQLCipher cache (when wired) instead of
        // hardcoding 0. Cross-boot rollback defense +
        // in-boot re-refresh monotonicity both land via
        // the cache.
        let (pubkey, tenant_str, license_cache, current_policy_version) = {
            let state = self.state.read().await;
            let cache = state.license_cache.clone();
            let floor = match cache.as_ref() {
                Some(c) => match c.get_highest_seen() {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(
                            "refresh_license: cache.get_highest_seen failed: {}. Treating as 0; other gates (tenant + freshness + signature) still enforce trust.",
                            e
                        );
                        0
                    }
                },
                None => 0,
            };
            (
                state.firmware_signing_pubkey.clone(),
                state.tenant_id.clone(),
                cache,
                floor,
            )
        };

        let pubkey = match pubkey {
            Some(k) => k,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "refresh_license rejected: firmware_signing_pubkey not wired. \
                         Set firmware_update.mode != Disabled + signing_pubkey_hex."
                            .to_string(),
                    ),
                );
            }
        };

        let expected_tenant = match tenant_str {
            Some(t) => match uuid::Uuid::parse_str(&t) {
                Ok(u) => {
                    crate::authz::permission::TenantId::new_from_verified(*u.as_bytes())
                }
                Err(e) => {
                    return (
                        false,
                        json!(null),
                        Some(format!(
                            "refresh_license: tenant_id on AppState is not a valid UUID: {}",
                            sanitize_for_log(&e.to_string())
                        )),
                    );
                }
            },
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "refresh_license rejected: device not activated (tenant_id is None)"
                            .to_string(),
                    ),
                );
            }
        };

        let manifest_value = match params.get("manifest") {
            Some(v) => v.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "refresh_license rejected: missing required 'manifest' parameter"
                            .to_string(),
                    ),
                );
            }
        };

        let signed: SignedLicenseManifest = match serde_json::from_value(manifest_value) {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    "refresh_license: manifest parse failed: {}",
                    sanitize_for_log(&e.to_string())
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "refresh_license rejected: manifest JSON parse failed: {}",
                        sanitize_for_log(&e.to_string())
                    )),
                );
            }
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let verified = match verify_license_manifest(
            &signed,
            &expected_tenant,
            current_policy_version,
            now,
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey.verify_strict(canonical, &sig).is_ok()
            },
        ) {
            Ok(m) => m,
            Err(e) => {
                warn!("refresh_license VERIFY REJECTED: {:?}", e);
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": format!("{}", e),
                        "reason": format!("{:?}", e),
                    }),
                    Some(format!("refresh_license rejected: {}", e)),
                );
            }
        };

        // Hot-swap AppState.license. Arc::new for a fresh
        // allocation; existing readers with the old Arc
        // see the OLD limits until they re-read (standard
        // Arc-swap semantic — no torn reads because the
        // Arc swap is atomic via RwLock write-guard).
        let tier_str = verified.limits.tier.as_str();
        let policy_version = verified.policy_version;
        let valid_until = verified.valid_until_unix_secs;

        // Batch 145 Faz 7: persist to cache BEFORE hot-
        // swap so a crash between persist + swap leaves
        // the NEW limits on disk (operator sees the
        // advance on next boot) rather than the swap-
        // without-persist case where a crash would
        // revert. Best-effort: cache failure warn-logs
        // but does not block the refresh. The in-memory
        // swap always happens because Batch 143's
        // architectural decision: refresh semantics
        // succeed on verify, persistence is
        // observability.
        if let Some(cache) = license_cache.as_ref() {
            if let Err(e) = cache.save(&signed) {
                warn!(
                    "refresh_license: cache.save failed ({}). Hot-swap proceeds; cross-boot persistence DEGRADED until cache reopens successfully.",
                    e
                );
            }
            if let Err(e) = cache.record_accepted(policy_version) {
                warn!(
                    "refresh_license: cache.record_accepted({}) failed ({}). Monotonic floor NOT advanced; next refresh may re-accept this version.",
                    policy_version, e
                );
            }
        } else {
            warn!(
                "refresh_license: license_cache is None (SQLCipher open failed at boot). Hot-swap proceeds in-memory only; agent restart will revert to conservative()."
            );
        }

        {
            let mut state = self.state.write().await;
            state.license = Arc::new(verified.limits);
        }

        info!(
            "refresh_license APPLIED: tier={} policy_version={} valid_until={}",
            tier_str, policy_version, valid_until
        );

        (
            true,
            json!({
                "applied": true,
                "tier": tier_str,
                "policy_version": policy_version,
                "valid_until_unix_secs": valid_until,
            }),
            None,
        )
    }
}
