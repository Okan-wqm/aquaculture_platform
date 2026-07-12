//! System control + SCADA display command handlers (Batch 20g
//! ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. These 7 handlers
//! form the "device-level control" domain — reboot / restart / the
//! SCADA display lifecycle (process + package deploy, on / off /
//! status). They share the fire-and-forget spawn pattern (reboot /
//! restart) and the scada-display feature gate pattern.
//!
//! WHAT: `impl CommandHandler` block with:
//! - `cmd_reboot` — schedules `shutdown -r now` via fire-and-
//!   forget tokio::spawn. JoinHandle intentionally not tracked
//!   because the system will be rebooting (no graceful shutdown
//!   meaningful) + the response must return BEFORE the shutdown
//!   subprocess executes, so awaiting the task would deadlock.
//! - `cmd_restart_agent` — symmetric pattern invoking
//!   `systemctl restart suderra-agent`.
//! - `cmd_deploy_process` (feature `scada-display`) — deploy a
//!   SCADA process definition. Supports BOTH flat `ScadaProcess`
//!   direct-deserialize AND cloud-wrapper format (nested
//!   tagMappings map) via `convert_cloud_deploy_payload` helper.
//! - `cmd_deploy_scada_package` (feature `scada-display`) — deploy
//!   full SCADA package (screens + alarm rules + control
//!   permissions + trend config). Supports direct parse AND cloud-
//!   wrapper `packageData` fallback.
//! - `cmd_display_on` / `cmd_display_off` (feature `scada-
//!   display`) — toggle display-active flag.
//! - `cmd_get_display_status` (feature `scada-display`) — report
//!   active flag + deployed-process summary.
//!
//! DEPLOY LOCK: `self.deploy_lock.lock().await` held by both
//! deploy handlers — prevents interleaved SCADA process +
//! package deploys from landing a partial / torn state.
//!
//! PLATFORM GATES: `cmd_reboot` + `cmd_restart_agent` use
//! `#[cfg(target_os = "linux")]` branches because `shutdown` and
//! `systemctl` are Linux-only. Non-Linux builds return a false
//! response with operator-visible "not supported" message rather
//! than silently succeeding.

use serde_json::{Value, json};
#[allow(unused_imports)]
// tracing imports: some handlers use debug only when scada-display feature enabled
use tracing::{error, info, warn};

use crate::mqtt::CommandMessage;

use super::{CommandHandler, DEFAULT_REBOOT_DELAY_SECS, DEFAULT_RESTART_DELAY_SECS};

/// `undeploy_scada_package` params (WF-011) — wire contract pinned by
/// `libs/sensor-contracts/src/schemas/undeploy-scada-package.schema.ts`
/// and the shared `undeploy-scada-package.json` fixture.
#[cfg(any(feature = "scada-display", test))]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndeployScadaPackageParams {
    pub(crate) package_id: String,
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

/// Faz 4 deploy-signature gate outcome. `Unsigned` is accepted
/// with an operator-visible warning until the Faz 5 bundle gate
/// ships enforcement (tracked plan phase — gentle-waddling-rabbit
/// Faz 5); an INVALID or malformed signature ALWAYS rejects.
#[cfg(feature = "scada-display")]
enum DeploySigGate {
    /// ed25519 signature verified against firmware_signing_pubkey
    /// over `tenant_id + artifact_sha256` canonical bytes.
    Verified,
    /// No signature material in the payload (legacy cloud or
    /// pre-Faz-4 sender).
    Unsigned,
}

impl CommandHandler {
    /// Reboot the device.
    ///
    /// # Task Handle
    /// The spawned task is intentionally not tracked because:
    /// 1. The system will be rebooting - no graceful shutdown
    ///    needed.
    /// 2. We must return the response before the reboot occurs
    ///    (awaiting the task would deadlock — the task kills the
    ///    process).
    /// 3. Any panic is logged within the task itself.
    pub(super) async fn cmd_reboot(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing reboot command");

        let delay_secs = params
            .get("delay_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_REBOOT_DELAY_SECS);

        #[cfg(target_os = "linux")]
        {
            info!("Scheduling reboot in {} seconds", delay_secs);

            // Fire-and-forget: the JoinHandle is bound (not
            // `let _ = `) so clippy::let_underscore_future
            // doesn't flag a forgotten-await false positive;
            // the binding is intentionally _-prefixed since
            // we never .abort() the reboot scheduler.
            let _handle = tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(delay_secs)).await;

                let status = std::process::Command::new("shutdown")
                    .args(["-r", "now"])
                    .status();

                match status {
                    Ok(s) if s.success() => info!("Reboot initiated"),
                    Ok(s) => error!("Reboot command failed with status: {}", s),
                    Err(e) => error!("Failed to execute reboot: {}", e),
                }
            });

            // v1.3.3: Add warning that reboot failures cannot be
            // reported back to the caller once the task has been
            // spawned. This is an honest limitation; silencing it
            // would mislead operators.
            (
                true,
                json!({
                    "scheduled": true,
                    "delay_seconds": delay_secs,
                    "note": "Reboot command accepted. If reboot fails (e.g., insufficient permissions), \
                             failure will be logged locally but cannot be reported back to caller."
                }),
                None,
            )
        }

        #[cfg(not(target_os = "linux"))]
        {
            warn!("Reboot not supported on this platform");
            let _ = delay_secs;
            (
                false,
                json!(null),
                Some("Reboot not supported on this platform".to_string()),
            )
        }
    }

    /// Restart the agent service.
    ///
    /// # Task Handle
    /// Same fire-and-forget pattern as `cmd_reboot`:
    /// 1. The agent will be restarted by systemd - no graceful
    ///    shutdown needed.
    /// 2. We must return the response before the restart occurs.
    /// 3. Any panic is logged within the task itself.
    pub(super) async fn cmd_restart_agent(&self) -> (bool, Value, Option<String>) {
        info!("Executing restart_agent command");

        #[cfg(target_os = "linux")]
        {
            // Fire-and-forget — see cmd_reboot_device above
            // for the let _handle = ... rationale.
            let _handle = tokio::spawn(async {
                tokio::time::sleep(tokio::time::Duration::from_secs(DEFAULT_RESTART_DELAY_SECS))
                    .await;

                let status = std::process::Command::new("systemctl")
                    .args(["restart", "suderra-agent"])
                    .status();

                match status {
                    Ok(s) if s.success() => info!("Agent restart initiated"),
                    Ok(s) => error!("Restart command failed with status: {}", s),
                    Err(e) => error!("Failed to execute restart: {}", e),
                }
            });

            (
                true,
                json!({
                    "scheduled": true,
                    "note": "Restart command accepted. If restart fails, \
                             failure will be logged locally but cannot be reported back to caller."
                }),
                None,
            )
        }

        #[cfg(not(target_os = "linux"))]
        {
            warn!("Restart not supported on this platform");
            (
                false,
                json!(null),
                Some("Restart not supported on this platform".to_string()),
            )
        }
    }

    /// Faz 4 deploy-signature gate shared by `cmd_deploy_process`
    /// and `cmd_deploy_scada_package`.
    ///
    /// Gate semantics:
    /// - No signature material → `Unsigned` (caller warns and
    ///   proceeds; enforcement ships with the Faz 5 bundle gate,
    ///   a tracked plan phase).
    /// - Signature present but sha/pubkey missing, malformed hex,
    ///   or ed25519 mismatch → `Err` (deploy REJECTED — an invalid
    ///   signature is never downgraded to a warning).
    ///
    /// The canonical bytes bind the EDGE's OWN tenant_id, not a
    /// tenant claimed in the payload — a signature minted for
    /// tenant A structurally cannot verify on an edge bound to
    /// tenant B (same trust shape as SignedStSource tenant
    /// binding).
    #[cfg(feature = "scada-display")]
    fn gate_deploy_signature(
        kind: crate::scripting::deploy_sig::DeployArtifactKind,
        signature_hex: Option<&str>,
        artifact_sha256_hex: Option<&str>,
        tenant_id: Option<String>,
        pubkey: Option<&ed25519_dalek::VerifyingKey>,
    ) -> Result<DeploySigGate, String> {
        use crate::scripting::deploy_sig::{
            DeploySigBody, parse_signature_hex, verify_deploy_signature,
        };

        let Some(sig_hex) = signature_hex else {
            return Ok(DeploySigGate::Unsigned);
        };
        let sha = artifact_sha256_hex.ok_or_else(|| {
            "deploy signature present but artifactSha256 missing — cannot verify".to_string()
        })?;
        let pubkey = pubkey.ok_or_else(|| {
            "deploy signature present but firmware_signing_pubkey not wired. \
             Set firmware_update.mode != Disabled + signing_pubkey_hex."
                .to_string()
        })?;
        let sig = parse_signature_hex(sig_hex).ok_or_else(|| {
            "deploy signature malformed: expected 128 lowercase hex chars".to_string()
        })?;

        let body = DeploySigBody {
            kind,
            tenant_id,
            artifact_sha256_hex: sha.to_string(),
        };
        verify_deploy_signature(&body, &sig, |msg, sig_bytes| {
            use ed25519_dalek::Verifier;
            pubkey
                .verify(msg, &ed25519_dalek::Signature::from_bytes(sig_bytes))
                .is_ok()
        })
        .map_err(|e| format!("deploy signature verification failed: {}", e))?;
        Ok(DeploySigGate::Verified)
    }

    /// Deploy a SCADA process (screens with node/edge graph +
    /// tag mappings to on-device sensors).
    ///
    /// Accepts cloud deploy payload with nested tagMappings map:
    /// ```json
    /// {
    ///   "name": "...",
    ///   "nodes": [...],
    ///   "edges": [...],
    ///   "tagMappings": {
    ///     "eqId": {
    ///       "equipmentId": "...",
    ///       "equipmentName": "...",
    ///       "tags": [{ "tagName", "sensorType", "unit", "displayName" }]
    ///     }
    ///   },
    ///   "version": 1
    /// }
    /// ```
    /// and converts the nested tagMappings map into the flat
    /// `Vec<TagMapping>` used internally.
    #[cfg(feature = "scada-display")]
    pub(super) async fn cmd_deploy_process(&self, params: &Value) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;

        let process: crate::scada_server::ScadaProcess =
            match serde_json::from_value(params.clone()) {
                Ok(p) => p,
                Err(_) => match Self::convert_cloud_deploy_payload(params) {
                    Ok(p) => p,
                    Err(e) => {
                        return (
                            false,
                            json!(null),
                            Some(format!("Invalid process definition: {}", e)),
                        );
                    }
                },
            };

        let state_guard = self.state.read().await;
        let scada_state: crate::scada_server::ScadaState = match &state_guard.scada_state {
            Some(s) => s.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("SCADA display feature not initialized".to_string()),
                );
            }
        };
        let tenant_id = state_guard.tenant_id.clone();
        let pubkey = state_guard.firmware_signing_pubkey.clone();
        drop(state_guard);

        // Faz 4 signature gate — cloud signs tenant_id +
        // artifact_sha256 under domain tag `process-v1`.
        let signature_hex = params.get("signature").and_then(|v| v.as_str());
        let artifact_sha = params.get("artifactSha256").and_then(|v| v.as_str());
        match Self::gate_deploy_signature(
            crate::scripting::deploy_sig::DeployArtifactKind::Process,
            signature_hex,
            artifact_sha,
            tenant_id,
            pubkey.as_deref(),
        ) {
            Ok(DeploySigGate::Verified) => {
                info!("deploy_process signature verified (artifact sha256 bound)");
            }
            Ok(DeploySigGate::Unsigned) => {
                warn!(
                    "deploy_process accepted UNSIGNED — signature enforcement \
                     arrives with the Faz 5 bundle gate"
                );
            }
            Err(e) => return (false, json!(null), Some(e)),
        }

        match scada_state.deploy_process(process).await {
            Ok(()) => {
                let p: Option<crate::scada_server::ScadaProcess> = scada_state.get_process().await;
                (
                    true,
                    json!({
                        "name": p.as_ref().map(|p| p.name.as_str()),
                        "version": p.as_ref().map(|p| p.version),
                        "deployed_at": p.as_ref().and_then(|p| p.deployed_at.as_deref()),
                    }),
                    None,
                )
            }
            Err(e) => (false, json!(null), Some(e)),
        }
    }

    /// Deploy a full SCADA package (screens, alarm rules, control
    /// permissions, trend config).
    ///
    /// Accepts BOTH direct-package JSON and cloud-wrapper format
    /// with `packageData` nested key. Cloud wrapper fallback
    /// triggers on first-parse failure.
    #[cfg(feature = "scada-display")]
    pub(super) async fn cmd_deploy_scada_package(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing deploy_scada_package command");

        let package: crate::scada_types::ScadaPackage = match serde_json::from_value(params.clone())
        {
            Ok(p) => p,
            Err(e) => {
                warn!(
                    "Direct SCADA package parse failed ({}), trying cloud format fallback",
                    e
                );
                match params.get("packageData") {
                    Some(pd) => match serde_json::from_value(pd.clone()) {
                        Ok(p) => p,
                        Err(e2) => {
                            return (
                                false,
                                json!(null),
                                Some(format!(
                                    "Invalid SCADA package (fallback also failed): {}",
                                    e2
                                )),
                            );
                        }
                    },
                    None => {
                        return (
                            false,
                            json!(null),
                            Some(format!("Invalid SCADA package: {}", e)),
                        );
                    }
                }
            }
        };

        if package.screens.is_empty() {
            return (
                false,
                json!(null),
                Some("Package must have at least one screen".to_string()),
            );
        }

        // CONTRACT-H-002 forward-compat: widget types this firmware does not
        // know deserialize to WidgetType::Unknown instead of failing the whole
        // package (the cloud transform strips/rejects them up front, so this
        // bucket only fills for pre-transform artifacts or a newer cloud).
        // Count + name them, report in the ack — NEVER fail the deploy.
        let unknown_widget_ids: Vec<String> = package
            .screens
            .iter()
            .flat_map(|s| s.widgets.iter())
            .filter(|w| matches!(w.widget_type, crate::scada_types::WidgetType::Unknown))
            .map(|w| w.id.clone())
            .collect();
        let unknown_widget_count = unknown_widget_ids.len();
        if unknown_widget_count > 0 {
            warn!(
                "deploy_scada_package: {} widget(s) with unknown type will not render: {:?}",
                unknown_widget_count, unknown_widget_ids
            );
        }

        let version = package.meta.version;
        let screen_count = package.screens.len();
        let alarm_count = package.alarm_rules.len();

        let state_guard = self.state.read().await;
        let scada_state = match &state_guard.scada_state {
            Some(s) => s.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("SCADA display not initialized".to_string()),
                );
            }
        };
        let tenant_id = state_guard.tenant_id.clone();
        let pubkey = state_guard.firmware_signing_pubkey.clone();
        drop(state_guard);

        // Faz 4 signature gate — cloud signs tenant_id +
        // artifact_sha256 under domain tag `scada-pkg-v1`. The
        // signature material rides in `meta` (top-level for the
        // canonical payload, under `packageData.meta` for the
        // cloud-wrapper fallback).
        let sig_meta = params
            .get("meta")
            .or_else(|| params.get("packageData").and_then(|pd| pd.get("meta")));
        let signature_hex = sig_meta
            .and_then(|m| m.get("signature"))
            .and_then(|v| v.as_str());
        let artifact_sha = sig_meta
            .and_then(|m| m.get("artifactSha256"))
            .and_then(|v| v.as_str());
        match Self::gate_deploy_signature(
            crate::scripting::deploy_sig::DeployArtifactKind::ScadaPackage,
            signature_hex,
            artifact_sha,
            tenant_id,
            pubkey.as_deref(),
        ) {
            Ok(DeploySigGate::Verified) => {
                info!("deploy_scada_package signature verified (artifact sha256 bound)");
            }
            Ok(DeploySigGate::Unsigned) => {
                warn!(
                    "deploy_scada_package accepted UNSIGNED — signature enforcement \
                     arrives with the Faz 5 bundle gate"
                );
            }
            Err(e) => return (false, json!(null), Some(e)),
        }

        match scada_state.deploy_package(package).await {
            Ok(()) => {
                info!(
                    "SCADA package deployed: version={}, screens={}, alarm_rules={}, unknown_widgets={}",
                    version, screen_count, alarm_count, unknown_widget_count
                );
                (
                    true,
                    json!({
                        "status": "deployed",
                        "version": version,
                        "screens": screen_count,
                        "alarm_rules": alarm_count,
                        "unknown_widget_count": unknown_widget_count,
                    }),
                    None,
                )
            }
            Err(e) => (false, json!(null), Some(e)),
        }
    }

    /// Remove the deployed SCADA package from this device (WF-011 —
    /// cloud-initiated undeploy, e.g. the package row was deleted in the
    /// cloud). Reuses the bundle-rollback restore path (`clear_package`),
    /// which drops the persisted file, empties the alarm rule set,
    /// deactivates the SQLite active row (so a restart cannot resurrect
    /// the package), and broadcasts the empty state to connected HMIs.
    #[cfg(feature = "scada-display")]
    pub(super) async fn cmd_undeploy_scada_package(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing undeploy_scada_package command");

        let parsed: UndeployScadaPackageParams = match serde_json::from_value(params.clone()) {
            Ok(p) => p,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid undeploy_scada_package params: {}", e)),
                );
            }
        };

        let state_guard = self.state.read().await;
        let scada_state = match &state_guard.scada_state {
            Some(s) => s.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("SCADA display not initialized".to_string()),
                );
            }
        };
        drop(state_guard);

        match scada_state.clear_package().await {
            Ok(()) => {
                info!(
                    "SCADA package {} undeployed (reason: {})",
                    parsed.package_id,
                    parsed.reason.as_deref().unwrap_or("package_deleted")
                );
                (
                    true,
                    json!({
                        "packageId": parsed.package_id,
                        "cleared": true,
                    }),
                    None,
                )
            }
            Err(e) => (false, json!(null), Some(e)),
        }
    }

    /// Turn on the SCADA display (mark as active).
    #[cfg(feature = "scada-display")]
    pub(super) async fn cmd_display_on(&self) -> (bool, Value, Option<String>) {
        let state_guard = self.state.read().await;
        if let Some(ref scada_state) = state_guard.scada_state {
            scada_state.set_display_active(true).await;
            info!("SCADA display turned ON");
            (true, json!({ "display": "on" }), None)
        } else {
            (
                false,
                json!(null),
                Some("SCADA display feature not initialized".to_string()),
            )
        }
    }

    /// Turn off the SCADA display (mark as inactive).
    #[cfg(feature = "scada-display")]
    pub(super) async fn cmd_display_off(&self) -> (bool, Value, Option<String>) {
        let state_guard = self.state.read().await;
        if let Some(ref scada_state) = state_guard.scada_state {
            scada_state.set_display_active(false).await;
            info!("SCADA display turned OFF");
            (true, json!({ "display": "off" }), None)
        } else {
            (
                false,
                json!(null),
                Some("SCADA display feature not initialized".to_string()),
            )
        }
    }

    /// Get the current SCADA display status.
    #[cfg(feature = "scada-display")]
    pub(super) async fn cmd_get_display_status(&self) -> (bool, Value, Option<String>) {
        let state_guard = self.state.read().await;
        if let Some(ref scada_state) = state_guard.scada_state {
            let active = scada_state.is_display_active().await;
            let process_opt: Option<crate::scada_server::ScadaProcess> =
                scada_state.get_process().await;
            let has_process = process_opt.is_some();
            let process_info = if let Some(p) = process_opt {
                json!({
                    "name": p.name,
                    "version": p.version,
                    "deployed_at": p.deployed_at,
                    "node_count": p.nodes.len(),
                    "edge_count": p.edges.len(),
                    "mapping_count": p.tag_mappings.len(),
                })
            } else {
                json!(null)
            };

            (
                true,
                json!({
                    "display_active": active,
                    "has_process": has_process,
                    "process": process_info,
                }),
                None,
            )
        } else {
            (
                false,
                json!(null),
                Some("SCADA display feature not initialized".to_string()),
            )
        }
    }

    /// Convert cloud deploy payload (nested tagMappings map) to
    /// ScadaProcess.
    ///
    /// The cloud sends tagMappings as:
    /// ```json
    /// { "eqId": { "equipmentId": "...", "equipmentName": "...",
    ///     "tags": [{ "tagName", "sensorType", "unit", "displayName" }] } }
    /// ```
    ///
    /// The edge expects a flat `Vec<TagMapping>`:
    /// ```json
    /// [{ "tagName", "equipmentId", "sensorType", "unit" }]
    /// ```
    #[cfg(feature = "scada-display")]
    fn convert_cloud_deploy_payload(
        params: &Value,
    ) -> Result<crate::scada_server::ScadaProcess, String> {
        let name = params
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'name' field")?
            .to_string();

        let version = params.get("version").and_then(|v| v.as_u64()).unwrap_or(1) as u32;

        let nodes: Vec<Value> = params
            .get("nodes")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let edges: Vec<Value> = params
            .get("edges")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let mut tag_mappings = Vec::new();
        if let Some(mappings_obj) = params.get("tagMappings").and_then(|v| v.as_object()) {
            for (_eq_key, eq_val) in mappings_obj {
                let equipment_id = eq_val
                    .get("equipmentId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                if let Some(tags) = eq_val.get("tags").and_then(|v| v.as_array()) {
                    for tag in tags {
                        let tag_name = tag
                            .get("tagName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let sensor_type = tag
                            .get("sensorType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let unit = tag
                            .get("unit")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        if !tag_name.is_empty() {
                            tag_mappings.push(crate::scada_server::TagMapping {
                                tag_name,
                                equipment_id: equipment_id.clone(),
                                sensor_type,
                                unit,
                            });
                        }
                    }
                }
            }
        }

        Ok(crate::scada_server::ScadaProcess {
            name,
            version,
            nodes,
            edges,
            tag_mappings,
            deployed_at: None,
        })
    }
}

// Silences unused-import warnings when scada-display feature is
// disabled. CommandMessage is imported for future cmd_reboot /
// cmd_restart_agent upgrade that would accept a CommandMessage
// envelope instead of bare params (Sprint 6.x RBAC wire — actor
// field lives on CommandMessage, not params).
#[allow(dead_code)]
fn _suppress_unused_for_feature_off(_: &CommandMessage) {}
