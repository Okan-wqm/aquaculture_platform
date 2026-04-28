//! Protocol write command handlers (Batch 20h ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. This module houses
//! the 4 PROTOCOL-WRITE handlers — each writes a single value to
//! one physical / logical output via a specific fieldbus protocol.
//! Extracting them separately from the broader IO-config / tag
//! lifecycle (cmd_update_io_config / cmd_set_output land in the
//! next batch's `io_config.rs`) surfaces the protocol-endpoint-
//! write pattern as an auditable boundary.
//!
//! WHAT: `impl CommandHandler` block with 4 handlers:
//! - `cmd_write_modbus` — write a single u16 register on a named
//!   Modbus device. Bounds-checks address + value against u16::
//!   MAX (IEC 61131-3 register-width contract) before dispatching
//!   to the thread-safe `modbus_handle.write_register()`.
//! - `cmd_write_gpio` — write a digital state to a numbered GPIO
//!   pin. Accepts BOTH the textual form ("high"/"low") and
//!   boolean-ish forms ("1"/"0"/"true"/"false"/"on"/"off"). v2.2
//!   actor pattern via `gpio_handle.write_pin()`.
//! - `cmd_write_opcua` — STUB. Returns `implemented: false` honest
//!   response. Sprint 6.x target (Plan §5 Faz 5 OPC UA server).
//! - `cmd_write_s7` — STUB. Returns `implemented: false`. Sprint
//!   6.x target (Plan §5 Faz 5 OPC UA server / IEC 61131 PLC
//!   stack).
//!
//! INVARIANT: Every write handler validates input FIRST (bounds,
//! type, required presence) and returns a specific error
//! `(false, json!(null), Some("Missing X"))` — NEVER a silent
//! default. A missing write destination must NEVER route to
//! "device 0, address 0" by accident.

use serde_json::{Value, json};
use tracing::{error, info, warn};

use super::CommandHandler;

impl CommandHandler {
    /// Write to Modbus register.
    ///
    /// WHY BOUNDS-CHECK: Modbus holding registers are 16-bit by
    /// spec (IEC 61131-3). An address or value exceeding u16::MAX
    /// indicates operator error or a malformed cloud-originated
    /// command — returning a specific bounds-error surface
    /// (address vs value) gives the operator an actionable
    /// diagnostic.
    pub(super) async fn cmd_write_modbus(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing write_modbus command");

        let device_name = match params.get("device").and_then(|v| v.as_str()) {
            Some(d) => d,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'device' parameter".to_string()),
                );
            }
        };

        let address = match params.get("address").and_then(|v| v.as_u64()) {
            Some(a) if a <= u16::MAX as u64 => a as u16,
            Some(a) => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Address {} exceeds maximum u16 value ({})",
                        a,
                        u16::MAX
                    )),
                );
            }
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };

        let value = match params.get("value").and_then(|v| v.as_u64()) {
            Some(v) if v <= u16::MAX as u64 => v as u16,
            Some(v) => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Value {} exceeds maximum u16 value ({})",
                        v,
                        u16::MAX
                    )),
                );
            }
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'value' parameter".to_string()),
                );
            }
        };

        let modbus_handle = {
            let state = self.state.read().await;
            state.modbus_handle.clone()
        };

        let handle = match modbus_handle {
            Some(h) => h,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No Modbus devices configured".to_string()),
                );
            }
        };

        match handle.write_register(device_name, address, value).await {
            Ok(()) => {
                info!("Wrote {} to register {} on {}", value, address, device_name);
                (
                    true,
                    json!({"device": device_name, "address": address, "value": value}),
                    None,
                )
            }
            Err(e) => {
                error!("Failed to write Modbus register: {}", e);
                (false, json!(null), Some(format!("Write failed: {}", e)))
            }
        }
    }

    /// Write to GPIO pin (v2.2: uses gpio_handle actor pattern).
    ///
    /// WHY MULTI-FORM STATE: Operators from different backgrounds
    /// reach for different vocabulary ("high"/"low" — electrical;
    /// "on"/"off" — operational; "1"/"0" — binary). Accepting all
    /// three surfaces matches the domain vocabulary without
    /// forcing operators to remember which form the agent happens
    /// to prefer.
    pub(super) async fn cmd_write_gpio(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing write_gpio command");

        let pin = match params.get("pin").and_then(|v| v.as_u64()) {
            Some(p) if p <= u8::MAX as u64 => p as u8,
            Some(p) => {
                return (
                    false,
                    json!(null),
                    Some(format!("GPIO pin {} exceeds valid range (0-255)", p)),
                );
            }
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'pin' parameter".to_string()),
                );
            }
        };

        let state_value = match params.get("state").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'state' parameter (high/low)".to_string()),
                );
            }
        };

        let pin_value = match state_value.to_lowercase().as_str() {
            "high" | "1" | "true" | "on" => true,
            "low" | "0" | "false" | "off" => false,
            _ => {
                return (
                    false,
                    json!(null),
                    Some("Invalid state. Use 'high' or 'low'".to_string()),
                );
            }
        };

        let gpio_handle = {
            let state = self.state.read().await;
            state.gpio_handle.clone()
        };

        let gpio_handle = match gpio_handle {
            Some(h) => h,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No GPIO pins configured".to_string()),
                );
            }
        };

        match gpio_handle.write_pin(pin, pin_value).await {
            Ok(()) => {
                info!("Set GPIO pin {} to {}", pin, state_value);
                (true, json!({"pin": pin, "state": state_value}), None)
            }
            Err(e) => {
                error!("Failed to write GPIO pin: {}", e);
                (false, json!(null), Some(format!("Write failed: {}", e)))
            }
        }
    }

    /// Write a value to an OPC-UA node on a PLC.
    ///
    /// STUB: Sprint 6.x target. Plan §5 Faz 5 lands the OPC UA
    /// server + client. Until then returns an honest
    /// `implemented: false` response rather than silently succeeding.
    pub(super) async fn cmd_write_opcua(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        warn!("cmd_write_opcua called but OPC-UA write is not yet implemented");

        let address = params
            .get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("<unknown>");
        let value = params.get("value").unwrap_or(&json!(null));

        (
            false,
            json!({
                "protocol": "opcua",
                "address": address,
                "requested_value": value,
                "implemented": false,
            }),
            Some("OPC-UA write not yet implemented".to_string()),
        )
    }

    /// Write a value to an S7 PLC via S7comm protocol.
    ///
    /// STUB: Sprint 6.x target. Same honest unimplemented-response
    /// pattern as `cmd_write_opcua`.
    pub(super) async fn cmd_write_s7(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        warn!("cmd_write_s7 called but S7 write is not yet implemented");

        let address = params
            .get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("<unknown>");
        let value = params.get("value").unwrap_or(&json!(null));

        (
            false,
            json!({
                "protocol": "s7comm",
                "address": address,
                "requested_value": value,
                "implemented": false,
            }),
            Some("S7 write not yet implemented".to_string()),
        )
    }
}
