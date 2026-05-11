//! LoRaWAN command handlers (Batch 20j ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. These 2 handlers
//! are feature-gated on `lorawan` and rely exclusively on
//! `AppState.lora_handle` (the LoRa actor handle). Extracting
//! them into their own sub-module means the lorawan feature
//! surface can be reviewed without cross-reading unrelated
//! protocols.
//!
//! WHAT: `impl CommandHandler` block (feature-gated on `lorawan`)
//! with 2 handlers:
//! - `cmd_update_lora_devices` — deploys a new LoRa device list
//!   with diff semantics: devices in the new list are added (or
//!   updated); devices previously configured but absent from the
//!   new list are removed. Errors are collected and returned
//!   alongside successful add/remove counts (partial-success
//!   semantics — an operator editing a 50-device fleet needs to
//!   see exactly which entries parsed + which failed).
//! - `cmd_lora_downlink` — queues a single downlink message
//!   for a specific device by DevAddr. Validates hex payload
//!   even-length early (odd hex strings would silently truncate
//!   otherwise).
//!
//! PARTIAL SUCCESS: `cmd_update_lora_devices` returns `success =
//! true` when at least one device was successfully added OR
//! removed, EVEN if errors occurred. This lets operators recover
//! incrementally from a malformed sub-entry without re-uploading
//! the entire fleet. The error list is always surfaced in the
//! response body.

#![cfg(feature = "lorawan")]

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;

impl CommandHandler {
    /// Update LoRa device list from backend.
    ///
    /// Receives a list of device configurations and updates the
    /// LoRa actor. Existing devices not in the new list are
    /// removed (diff semantics).
    pub(super) async fn cmd_update_lora_devices(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing update_lora_devices command");

        let devices = match params.get("devices").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'devices' array parameter".to_string()),
                );
            }
        };

        let state = self.state.read().await;

        let lora_handle = match &state.lora_handle {
            Some(h) => h.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("LoRa handle not available".to_string()),
                );
            }
        };

        let mut added = 0;
        let mut removed = 0;
        let mut errors = Vec::new();

        // Collect all dev_euis from the NEW list — used for the
        // removal diff pass below.
        let mut new_dev_euis = std::collections::HashSet::new();

        for device_json in devices {
            match serde_json::from_value::<crate::config::LoRaDeviceConfigYaml>(device_json.clone())
            {
                Ok(yaml_config) => {
                    new_dev_euis.insert(yaml_config.dev_eui.clone());

                    match crate::lora::parse_device_config(&yaml_config) {
                        Ok(device_config) => {
                            if let Err(e) = lora_handle.add_device(device_config).await {
                                errors.push(format!("Device add failed: {}", e));
                            } else {
                                added += 1;
                            }
                        }
                        Err(e) => {
                            errors.push(format!("Device config parse error: {}", e));
                        }
                    }
                }
                Err(e) => {
                    errors.push(format!("JSON parse error: {}", e));
                }
            }
        }

        // Diff: remove devices that exist currently but are absent
        // from the new list. This is what makes updates
        // destructive-on-removal rather than purely additive.
        let current_devices: Vec<String> = {
            let state_r = self.state.read().await;
            state_r
                .config
                .lorawan
                .as_ref()
                .map(|l| l.devices.iter().map(|d| d.dev_eui.clone()).collect())
                .unwrap_or_default()
        };

        for existing_eui in &current_devices {
            if !new_dev_euis.contains(existing_eui) {
                match crate::lora::types::DevEui::from_hex(existing_eui) {
                    Ok(dev_eui) => {
                        if let Err(e) = lora_handle.remove_device(dev_eui).await {
                            errors
                                .push(format!("Device remove failed for {}: {}", existing_eui, e));
                        } else {
                            removed += 1;
                            info!("LoRa device removed via diff: dev_eui={}", existing_eui);
                        }
                    }
                    Err(e) => {
                        errors.push(format!("DevEUI parse error for removal: {}", e));
                    }
                }
            }
        }

        if errors.is_empty() {
            info!("LoRa devices updated: {} added, {} removed", added, removed);
            (true, json!({ "added": added, "removed": removed }), None)
        } else {
            warn!(
                "LoRa device update partially failed: {} added, {} removed, {} errors",
                added,
                removed,
                errors.len()
            );
            (
                added > 0 || removed > 0,
                json!({ "added": added, "removed": removed, "errors": errors }),
                if added == 0 && removed == 0 {
                    Some(errors.join("; "))
                } else {
                    None
                },
            )
        }
    }

    /// Queue a downlink message for a specific LoRa device.
    pub(super) async fn cmd_lora_downlink(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing lora_downlink command");

        let dev_addr_hex = match params.get("dev_addr").and_then(|v| v.as_str()) {
            Some(addr) => addr,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'dev_addr' parameter".to_string()),
                );
            }
        };

        let payload_hex = match params.get("payload").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'payload' hex string parameter".to_string()),
                );
            }
        };

        let f_port = params.get("f_port").and_then(|v| v.as_u64()).unwrap_or(1) as u8;

        let confirmed = params
            .get("confirmed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let dev_addr = match crate::lora::types::DevAddr::from_hex(dev_addr_hex) {
            Ok(addr) => addr,
            Err(e) => {
                return (false, json!(null), Some(format!("Invalid dev_addr: {}", e)));
            }
        };

        // Even-length guard. Odd-length hex strings would
        // otherwise silently truncate in the step_by(2) loop below.
        if payload_hex.len() % 2 != 0 {
            return (
                false,
                json!(null),
                Some("Payload hex string must have even length".to_string()),
            );
        }

        let payload_bytes: Vec<u8> = match (0..payload_hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&payload_hex[i..i + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
        {
            Ok(bytes) => bytes,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid payload hex: {}", e)),
                );
            }
        };

        let state = self.state.read().await;

        let lora_handle = match &state.lora_handle {
            Some(h) => h.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("LoRa handle not available".to_string()),
                );
            }
        };

        let item = crate::lora::mac::DownlinkItem {
            dev_addr,
            payload: payload_bytes,
            f_port,
            confirmed,
            priority: 0,
        };

        match lora_handle.queue_downlink(item).await {
            Ok(()) => {
                info!(
                    "LoRa downlink queued: dev_addr={}, f_port={}",
                    dev_addr_hex, f_port
                );
                (
                    true,
                    json!({ "dev_addr": dev_addr_hex, "f_port": f_port, "confirmed": confirmed }),
                    None,
                )
            }
            Err(e) => (
                false,
                json!(null),
                Some(format!("Downlink queue failed: {}", e)),
            ),
        }
    }
}
