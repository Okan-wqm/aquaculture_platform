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
#[allow(unused_imports)] // tracing imports: some handlers use debug only when scada-display feature enabled
use tracing::{error, info, warn};

use crate::mqtt::CommandMessage;

use super::{CommandHandler, DEFAULT_REBOOT_DELAY_SECS, DEFAULT_RESTART_DELAY_SECS};

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
    pub(super) async fn cmd_reboot(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing reboot command");

        let delay_secs = params
            .get("delay_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_REBOOT_DELAY_SECS);

        #[cfg(target_os = "linux")]
        {
            info!("Scheduling reboot in {} seconds", delay_secs);

            let _ = tokio::spawn(async move {
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
            let _ = tokio::spawn(async {
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
    pub(super) async fn cmd_deploy_process(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;

        let process: crate::scada_server::ScadaProcess = match serde_json::from_value(params.clone()) {
            Ok(p) => p,
            Err(_) => {
                match Self::convert_cloud_deploy_payload(params) {
                    Ok(p) => p,
                    Err(e) => {
                        return (false, json!(null), Some(format!("Invalid process definition: {}", e)));
                    }
                }
            }
        };

        let state_guard = self.state.read().await;
        let scada_state: crate::scada_server::ScadaState = match &state_guard.scada_state {
            Some(s) => s.clone(),
            None => {
                return (false, json!(null), Some("SCADA display feature not initialized".to_string()));
            }
        };
        drop(state_guard);

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

        let package: crate::scada_types::ScadaPackage = match serde_json::from_value(params.clone()) {
            Ok(p) => p,
            Err(e) => {
                warn!("Direct SCADA package parse failed ({}), trying cloud format fallback", e);
                match params.get("packageData") {
                    Some(pd) => match serde_json::from_value(pd.clone()) {
                        Ok(p) => p,
                        Err(e2) => return (false, json!(null), Some(format!("Invalid SCADA package (fallback also failed): {}", e2))),
                    },
                    None => return (false, json!(null), Some(format!("Invalid SCADA package: {}", e))),
                }
            }
        };

        if package.screens.is_empty() {
            return (false, json!(null), Some("Package must have at least one screen".to_string()));
        }

        let version = package.meta.version;
        let screen_count = package.screens.len();
        let alarm_count = package.alarm_rules.len();

        let state_guard = self.state.read().await;
        let scada_state = match &state_guard.scada_state {
            Some(s) => s.clone(),
            None => return (false, json!(null), Some("SCADA display not initialized".to_string())),
        };
        drop(state_guard);

        match scada_state.deploy_package(package).await {
            Ok(()) => {
                info!(
                    "SCADA package deployed: version={}, screens={}, alarm_rules={}",
                    version, screen_count, alarm_count
                );
                (true, json!({
                    "status": "deployed",
                    "version": version,
                    "screens": screen_count,
                    "alarm_rules": alarm_count,
                }), None)
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
            (false, json!(null), Some("SCADA display feature not initialized".to_string()))
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
            (false, json!(null), Some("SCADA display feature not initialized".to_string()))
        }
    }

    /// Get the current SCADA display status.
    #[cfg(feature = "scada-display")]
    pub(super) async fn cmd_get_display_status(&self) -> (bool, Value, Option<String>) {
        let state_guard = self.state.read().await;
        if let Some(ref scada_state) = state_guard.scada_state {
            let active = scada_state.is_display_active().await;
            let process_opt: Option<crate::scada_server::ScadaProcess> = scada_state.get_process().await;
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
            (false, json!(null), Some("SCADA display feature not initialized".to_string()))
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
