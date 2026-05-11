//! `cmd_verify_signed_manifest` — SignedFirmwareManifest
//! verification-only preview (Batch 115 Sprint 6.5 Phase 2).
//!
//! ## WHY
//!
//! Plan §3 R-4 + ADR-019 §3 mandate ed25519 signed firmware
//! manifests verified against an on-device trusted pubkey.
//! Batch 8 shipped the fail-closed `verify_firmware_manifest`
//! primitive (8 gates: target arch, validity window, clock,
//! tenant, monotonic version, freshness, canonical bytes,
//! ed25519). Batch 114 wired the AppState-cached
//! `VerifyingKey`. This batch exposes the verify gate as an
//! MQTT command so the cloud release pipeline can:
//!
//! 1. DRY-RUN a candidate manifest against the device BEFORE
//!    starting the deploy orchestration. Catches tenant
//!    mismatch / expired window / arch mismatch / version
//!    rollback attempts WITHOUT wasting bandwidth on a
//!    doomed download.
//! 2. Serve as the integration test fixture for the future
//!    Batch 116 `cmd_apply_signed_manifest` orchestrator —
//!    same verify path, just without the state-mutating
//!    apply_roll + bootloader calls.
//!
//! ## Authorization
//!
//! Gated by `Permission::UpdateFirmware` — the same
//! privilege class as update_firmware + confirm_slot +
//! rollback_firmware. Verification-preview MUST be gated
//! at the firmware-deploy level (not lower) because the
//! response payload reveals which tenant / version /
//! pubkey the device trusts. Gating lower would leak those
//! identifiers to any less-privileged operator + widen the
//! attacker's information-gathering surface.
//!
//! ## NOT in scope (tracked for later batches)
//!
//! - State mutation (apply_roll, bootloader coordination) —
//!   Batch 116.
//! - File streaming / download to standby partition —
//!   needs real A/B hardware paths in config.
//! - TOCTOU re-verify after download — downstream of the
//!   file-streaming batch.
//! - Per-file SHA-256 recompute — a separate gate that
//!   runs AFTER files land on standby (Batch 8 doc).
//!
//! ## Mode interaction
//!
//! - `firmware_update.mode = Disabled`: the command is
//!   rejected because AppState.firmware_signing_pubkey is
//!   None. Operator must enable Permissive or Enforcing.
//! - `firmware_update.mode = Permissive` / `Enforcing`:
//!   the verify path runs with the parsed VerifyingKey.

use serde_json::{Value, json};
use std::time::SystemTime;
use tracing::{info, warn};

use super::CommandHandler;
use crate::authz::permission::TenantId;
use crate::security::sanitize_for_log;
use crate::updater::SignedFirmwareManifest;

impl CommandHandler {
    /// `verify_signed_manifest` — run the 8-gate verify
    /// against a submitted SignedFirmwareManifest payload.
    ///
    /// Params:
    /// - `manifest`: SignedFirmwareManifest JSON body
    ///   (required). Must match the
    ///   `updater::SignedFirmwareManifest` wire shape.
    ///
    /// Returns on success:
    ///   {
    ///     "verified": true,
    ///     "firmware_version": u64,
    ///     "release_tag": "...",
    ///     "tenant_match": true,
    ///     "file_count": usize
    ///   }
    ///
    /// On failure: `verified = false`, plus a structured
    /// `gate` field identifying which verify-gate rejected.
    pub(super) async fn cmd_verify_signed_manifest(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing verify_signed_manifest command (Sprint 6.5 Phase 2)");

        // Pull the required AppState slices under a single
        // read-guard. Minimizes lock-hold window +
        // serializes the snapshot with command execution.
        let (pubkey, tenant_str, mode, highest_seen) = {
            let state = self.state.read().await;
            (
                state.firmware_signing_pubkey.clone(),
                state.tenant_id.clone(),
                state.config.firmware_update.mode,
                state
                    .partition_store
                    .as_ref()
                    .and_then(|ps| ps.snapshot().ok())
                    .map(|snap| snap.active_firmware_version)
                    .unwrap_or(0),
            )
        };

        // Mode-gate: Disabled mode has no pubkey; reject
        // with a structured message so the operator sees
        // the coherence requirement.
        let pubkey = match pubkey {
            Some(k) => k,
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "mode_disabled",
                        "mode": format!("{:?}", mode),
                    }),
                    Some(format!(
                        "verify_signed_manifest rejected: firmware_update.mode={:?} — pubkey not wired. \
                         Set firmware_update.mode to permissive or enforcing + provide signing_pubkey_hex.",
                        mode
                    )),
                );
            }
        };

        // Parse the tenant_id string on AppState to a
        // TenantId suitable for the manifest comparison.
        // Un-activated devices carry tenant_id=None; the
        // verify gate rejects with TenantMismatch in that
        // case because zero-tenant does not match any
        // real-tenant manifest.
        let expected_tenant = match tenant_str {
            Some(t) => match uuid::Uuid::parse_str(&t) {
                Ok(u) => TenantId::new_from_verified(*u.as_bytes()),
                Err(e) => {
                    return (
                        false,
                        json!({
                            "verified": false,
                            "gate": "tenant_parse_failed",
                            "reason": sanitize_for_log(&e.to_string()),
                        }),
                        Some(format!(
                            "verify_signed_manifest rejected: tenant_id on AppState is not a valid UUID: {}",
                            sanitize_for_log(&e.to_string())
                        )),
                    );
                }
            },
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "device_not_activated",
                    }),
                    Some(
                        "verify_signed_manifest rejected: device not activated (tenant_id is None)"
                            .to_string(),
                    ),
                );
            }
        };

        // Parse the manifest param. Shape match via serde
        // against the SignedFirmwareManifest wire struct.
        let manifest_value = match params.get("manifest") {
            Some(v) => v.clone(),
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "missing_param",
                        "param": "manifest",
                    }),
                    Some(
                        "verify_signed_manifest rejected: missing required 'manifest' parameter"
                            .to_string(),
                    ),
                );
            }
        };

        let signed: SignedFirmwareManifest = match serde_json::from_value(manifest_value) {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    "verify_signed_manifest: manifest parse failed: {}",
                    sanitize_for_log(&e.to_string())
                );
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "manifest_parse_failed",
                        "reason": sanitize_for_log(&e.to_string()),
                    }),
                    Some(format!(
                        "verify_signed_manifest rejected: manifest JSON parse failed: {}",
                        sanitize_for_log(&e.to_string())
                    )),
                );
            }
        };

        // Run the Batch 8 verify_firmware_manifest primitive
        // with ed25519_dalek closure-injected as the
        // signature verifier. The VerifyingKey lives inside
        // an Arc so clone is cheap; verify_strict enforces
        // the canonical S-below-l requirement that thwarts
        // malleability-class signature forgery probes.
        let now = SystemTime::now();
        let result = crate::updater::verify_firmware_manifest(
            &signed,
            &expected_tenant,
            highest_seen,
            now,
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey.verify_strict(canonical, &sig).is_ok()
            },
        );

        match result {
            Ok(manifest) => {
                info!(
                    "verify_signed_manifest SUCCESS: firmware_version={} release_tag={} file_count={}",
                    manifest.firmware_version,
                    sanitize_for_log(&manifest.release_tag),
                    manifest.files.len()
                );
                (
                    true,
                    json!({
                        "verified": true,
                        "firmware_version": manifest.firmware_version,
                        "release_tag": manifest.release_tag,
                        "target_arch": format!("{:?}", manifest.target_arch),
                        "valid_from_unix_secs": manifest.valid_from_unix_secs,
                        "valid_until_unix_secs": manifest.valid_until_unix_secs,
                        "file_count": manifest.files.len(),
                        "highest_seen_firmware_version": highest_seen,
                        "mode": format!("{:?}", mode),
                    }),
                    None,
                )
            }
            Err(e) => {
                warn!("verify_signed_manifest REJECTED: gate={:?}", e);
                (
                    false,
                    json!({
                        "verified": false,
                        "gate": gate_label_for_err(&e),
                        "reason": e.to_string(),
                        "highest_seen_firmware_version": highest_seen,
                        "mode": format!("{:?}", mode),
                    }),
                    Some(format!("verify_signed_manifest rejected: {}", e)),
                )
            }
        }
    }
}

/// Map ManifestVerifyError variants to stable string labels
/// suitable for the audit detail + response JSON. Stable
/// identifiers so operator-facing UIs can render a per-gate
/// failure reason without pattern-matching on Display output.
fn gate_label_for_err(e: &crate::updater::ManifestVerifyError) -> &'static str {
    use crate::updater::ManifestVerifyError as M;
    match e {
        M::TargetArchMismatch => "target_arch_mismatch",
        M::InvalidValidityWindow { .. } => "invalid_validity_window",
        M::InvalidNow => "invalid_now",
        M::TenantMismatch => "tenant_mismatch",
        M::StaleFirmwareVersion { .. } => "stale_firmware_version",
        M::NotYetValid { .. } => "not_yet_valid",
        M::Expired { .. } => "expired",
        M::CanonicalBytesFailure(_) => "canonical_bytes_failure",
        M::InvalidSignature => "invalid_signature",
        M::FileDigestMismatch { .. } => "file_digest_mismatch",
        M::FileSizeMismatch { .. } => "file_size_mismatch",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_label_pins_stable_identifiers() {
        use crate::updater::ManifestVerifyError as M;
        assert_eq!(
            gate_label_for_err(&M::TargetArchMismatch),
            "target_arch_mismatch"
        );
        assert_eq!(gate_label_for_err(&M::TenantMismatch), "tenant_mismatch");
        assert_eq!(
            gate_label_for_err(&M::InvalidSignature),
            "invalid_signature"
        );
        assert_eq!(
            gate_label_for_err(&M::InvalidValidityWindow {
                valid_from: 0,
                valid_until: 0
            }),
            "invalid_validity_window"
        );
        assert_eq!(
            gate_label_for_err(&M::FileDigestMismatch {
                file_path: "x".into()
            }),
            "file_digest_mismatch"
        );
        assert_eq!(
            gate_label_for_err(&M::StaleFirmwareVersion {
                claimed: 1,
                highest_seen: 2
            }),
            "stale_firmware_version"
        );
    }
}
