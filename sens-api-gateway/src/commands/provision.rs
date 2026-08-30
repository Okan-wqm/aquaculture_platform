//! Runtime Modbus device provisioning (Slice 3.5 / SENSOR-CRITICAL-007).
//!
//! ## Why this exists
//!
//! A tenant-added VFD (or any writable Modbus drive) is registered in the cloud
//! AFTER the edge was provisioned. For the edge-delegated write path
//! (`write_modbus`) to reach the drive, the cloud must be able to push a NEW
//! Modbus device — connection + slave_id + register map + `allowed_write_ranges`
//! — to the RUNNING edge. The static boot config cannot represent devices a
//! tenant adds later, and `update_io_config` only maps register tags onto
//! PRE-EXISTING devices; neither can create the device with a connection.
//!
//! These handlers close that gap:
//! - `cmd_provision_modbus_device` — hot-adds/replaces the device on the live
//!   Modbus actor (additive; other drives keep their connections) AND persists
//!   it into `config.modbus` via `Config::save()`.
//! - `cmd_decommission_modbus_device` — the inverse: removes it live + from the
//!   persisted config.
//!
//! ## Durability
//!
//! Persisting into `config.modbus` makes the binding reboot-durable: at boot,
//! `init_hardware_handles` rebuilds the Modbus actor from `config.modbus`, so the
//! drive is driveable again after an offline reboot even with no cloud link (the
//! edge's offline-operation invariant). The cloud remains the SSoT and reconciles
//! by re-provisioning / decommissioning; the persisted copy is the local safety
//! net, not a second source of truth.
//!
//! ## Safety — deny-by-default write authority
//!
//! `validate_provision_write_authz` mirrors the load-time invariant in
//! `Config::validate`: a device with `allow_writes=true` MUST carry non-empty
//! `allowed_write_ranges` (or an explicit `allow_all_write_addresses`) or the
//! provision is REJECTED. A VFD must never be provisioned as writable-to-any-
//! register. The per-write gate in `ModbusClient::validate_write_address` still
//! enforces the same ranges on every request, so provisioning never widens write
//! authority on its own — this check fails the operation early with an
//! actionable error rather than silently accepting an unsafe device.

use serde_json::{Value, json};
use tracing::{error, info, warn};

use super::CommandHandler;
use crate::config::ModbusDeviceConfig;

impl CommandHandler {
    /// Provision (add or replace) a Modbus device at runtime.
    ///
    /// Params: `{ "device": <ModbusDeviceConfig> }`. Returns
    /// `(connected, {device, persisted, connected}, error?)`. `connected=false`
    /// with `persisted=true` means the binding is durable and will retry, but the
    /// channel is not up yet (e.g. malformed address) — the command reports
    /// failure so the cloud does not treat the write path as live.
    pub(super) async fn cmd_provision_modbus_device(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing provision_modbus_device command");

        let device_val = match params.get("device") {
            Some(d) => d.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'device' parameter".to_string()),
                );
            }
        };

        let config: ModbusDeviceConfig = match serde_json::from_value(device_val) {
            Ok(c) => c,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid Modbus device config: {}", e)),
                );
            }
        };

        if config.name.trim().is_empty() {
            return (
                false,
                json!(null),
                Some("Modbus device 'name' must be non-empty".to_string()),
            );
        }

        // Deny-by-default write authorization (mirrors load-time validation).
        if let Some(err) = validate_provision_write_authz(&config) {
            warn!(
                "Rejecting provision of Modbus device '{}': {}",
                config.name, err
            );
            return (false, json!(null), Some(err));
        }

        let name = config.name.clone();

        // Persist into config.modbus (SSoT + reboot-durable) BEFORE hot-adding.
        // Roll back the in-memory change if the disk write fails so the running
        // config and the on-disk config never drift.
        let handle = {
            let mut state = self.state.write().await;
            let backup = state.config.modbus.clone();
            match state.config.modbus.iter_mut().find(|d| d.name == name) {
                Some(existing) => *existing = config.clone(),
                None => state.config.modbus.push(config.clone()),
            }
            if let Err(e) = state.config.save() {
                state.config.modbus = backup;
                error!(
                    "Failed to persist provisioned Modbus device '{}': {}",
                    name, e
                );
                return (
                    false,
                    json!(null),
                    Some(format!("Failed to persist device config: {}", e)),
                );
            }
            state.modbus_handle.clone()
        };

        let handle = match handle {
            Some(h) => h,
            None => {
                // The Modbus actor is started unconditionally at boot, so this
                // only happens pre-init (e.g. in tests). The config is persisted,
                // so a restart activates the device.
                return (
                    false,
                    json!({ "device": name, "persisted": true, "connected": false }),
                    Some(
                        "Modbus subsystem not initialized; device persisted, restart to activate"
                            .to_string(),
                    ),
                );
            }
        };

        match handle.provision_device(config).await {
            Ok(()) => {
                info!("Provisioned Modbus device '{}' (channel established)", name);
                (
                    true,
                    json!({ "device": name, "persisted": true, "connected": true }),
                    None,
                )
            }
            Err(e) => {
                // Persisted + registered, but the channel is not up (invalid
                // address / TLS). Honest partial result: durable binding, write
                // path NOT live, so the command reports failure.
                warn!(
                    "Provisioned Modbus device '{}' but channel failed: {}",
                    name, e
                );
                (
                    false,
                    json!({ "device": name, "persisted": true, "connected": false }),
                    Some(format!(
                        "Device provisioned but channel not established: {}",
                        e
                    )),
                )
            }
        }
    }

    /// Decommission (remove + disconnect) a Modbus device at runtime.
    ///
    /// Params: `{ "device": "<name>" }`. Removes the device from the live actor
    /// AND the persisted config. Idempotent — decommissioning an unknown device
    /// succeeds with `removed=false`.
    pub(super) async fn cmd_decommission_modbus_device(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing decommission_modbus_device command");

        let name = match params.get("device").and_then(|v| v.as_str()) {
            Some(d) if !d.trim().is_empty() => d.to_string(),
            _ => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'device' parameter".to_string()),
                );
            }
        };

        // Remove from the persisted config first (SSoT), rolling back on failure.
        let handle = {
            let mut state = self.state.write().await;
            let before = state.config.modbus.len();
            let backup = state.config.modbus.clone();
            state.config.modbus.retain(|d| d.name != name);
            if state.config.modbus.len() != before {
                if let Err(e) = state.config.save() {
                    state.config.modbus = backup;
                    error!("Failed to persist decommission of '{}': {}", name, e);
                    return (
                        false,
                        json!(null),
                        Some(format!("Failed to persist device removal: {}", e)),
                    );
                }
            }
            state.modbus_handle.clone()
        };

        let removed = match handle {
            Some(h) => h.decommission_device(&name).await,
            None => false,
        };

        info!(
            "Decommissioned Modbus device '{}' (live removal: {})",
            name, removed
        );
        (true, json!({ "device": name, "removed": removed }), None)
    }
}

/// Validate that a runtime-provisioned device does not grant write authority
/// without an explicit allowed-range whitelist. Mirrors the load-time invariant
/// in `Config::validate` so a runtime path cannot bypass deny-by-default.
///
/// Returns `Some(error)` when the device is rejected, `None` when it is safe.
fn validate_provision_write_authz(config: &ModbusDeviceConfig) -> Option<String> {
    let sec = &config.security;
    if !sec.enabled || !sec.allow_writes {
        return None;
    }
    if sec.allowed_write_ranges.is_empty() && !sec.allow_all_write_addresses {
        return Some(format!(
            "Modbus device '{}': allow_writes=true requires non-empty allowed_write_ranges or explicit allow_all_write_addresses=true",
            config.name
        ));
    }
    // Reject malformed ranges (start > end). A silently-empty range would deny
    // every write, masking a config error as a security posture.
    for &(start, end) in &sec.allowed_write_ranges {
        if start > end {
            return Some(format!(
                "Modbus device '{}': invalid allowed_write_ranges entry {}..{} (start must be <= end)",
                config.name, start, end
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ModbusSecurityConfig;

    fn config_with_security(security: ModbusSecurityConfig) -> ModbusDeviceConfig {
        ModbusDeviceConfig {
            name: "vfd-pump-1".to_string(),
            connection_type: "tcp".to_string(),
            address: "10.0.0.5:502".to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security,
            tls: Default::default(),
        }
    }

    #[test]
    fn read_only_device_needs_no_write_ranges() {
        // allow_writes defaults to false → a read-only device is always accepted.
        let cfg = config_with_security(ModbusSecurityConfig::default());
        assert!(validate_provision_write_authz(&cfg).is_none());
    }

    #[test]
    fn writable_device_without_ranges_is_rejected() {
        let cfg = config_with_security(ModbusSecurityConfig {
            allow_writes: true,
            allowed_write_ranges: vec![],
            allow_all_write_addresses: false,
            ..Default::default()
        });
        let err = validate_provision_write_authz(&cfg).expect("must reject");
        assert!(
            err.contains("allowed_write_ranges"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn writable_device_with_ranges_is_accepted() {
        let cfg = config_with_security(ModbusSecurityConfig {
            allow_writes: true,
            allowed_write_ranges: vec![(49999, 50001)],
            ..Default::default()
        });
        assert!(validate_provision_write_authz(&cfg).is_none());
    }

    #[test]
    fn writable_device_with_explicit_all_addresses_is_accepted() {
        let cfg = config_with_security(ModbusSecurityConfig {
            allow_writes: true,
            allowed_write_ranges: vec![],
            allow_all_write_addresses: true,
            ..Default::default()
        });
        assert!(validate_provision_write_authz(&cfg).is_none());
    }

    #[test]
    fn malformed_range_is_rejected() {
        let cfg = config_with_security(ModbusSecurityConfig {
            allow_writes: true,
            allowed_write_ranges: vec![(50001, 49999)],
            ..Default::default()
        });
        let err = validate_provision_write_authz(&cfg).expect("must reject");
        assert!(
            err.contains("start must be <= end"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn security_disabled_skips_write_authz() {
        // A device with security disabled bypasses this gate; the per-write
        // path still governs the (unusual) security-disabled posture.
        let cfg = config_with_security(ModbusSecurityConfig {
            enabled: false,
            allow_writes: true,
            allowed_write_ranges: vec![],
            ..Default::default()
        });
        assert!(validate_provision_write_authz(&cfg).is_none());
    }
}
