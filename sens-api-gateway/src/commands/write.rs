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
//! - `cmd_write_opcua` — writes a typed value through the PLC
//!   programming OPC UA client, then reads back the same address.
//! - `cmd_write_s7` — writes a typed value through S7comm, then
//!   reads back the same address.
//!
//! INVARIANT: Every write handler validates input FIRST (bounds,
//! type, required presence) and returns a specific error
//! `(false, json!(null), Some("Missing X"))` — NEVER a silent
//! default. A missing write destination must NEVER route to
//! "device 0, address 0" by accident.

use serde_json::{Value, json};
use tracing::{error, info, warn};

use super::CommandHandler;
use crate::plc_programming::common::{bytes_to_variable_value, variable_value_to_bytes};
use crate::plc_programming::{OpcUaClient, PlcDataType, PlcProgrammer, PlcVariableValue, S7Client};

fn parse_plc_data_type(params: &Value) -> Result<PlcDataType, String> {
    let raw = params
        .get("data_type")
        .and_then(|v| v.as_str())
        .unwrap_or("INT")
        .trim()
        .to_ascii_uppercase();

    match raw.as_str() {
        "BOOL" | "BOOLEAN" => Ok(PlcDataType::Bool),
        "BYTE" => Ok(PlcDataType::Byte),
        "WORD" => Ok(PlcDataType::Word),
        "DWORD" => Ok(PlcDataType::Dword),
        "LWORD" => Ok(PlcDataType::Lword),
        "SINT" => Ok(PlcDataType::Sint),
        "INT" => Ok(PlcDataType::Int),
        "DINT" => Ok(PlcDataType::Dint),
        "LINT" => Ok(PlcDataType::Lint),
        "USINT" => Ok(PlcDataType::Usint),
        "UINT" => Ok(PlcDataType::Uint),
        "UDINT" => Ok(PlcDataType::Udint),
        "ULINT" => Ok(PlcDataType::Ulint),
        "REAL" | "FLOAT" | "FLOAT32" => Ok(PlcDataType::Real),
        "LREAL" | "DOUBLE" | "FLOAT64" => Ok(PlcDataType::Lreal),
        "STRING" => Ok(PlcDataType::String),
        "WSTRING" => Ok(PlcDataType::Wstring),
        other => Err(format!("Unsupported PLC data_type '{}'", other)),
    }
}

fn number_as_i64(value: &Value, field: &str) -> Result<i64, String> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|v| i64::try_from(v).ok()))
        .ok_or_else(|| format!("{} must be an integer", field))
}

fn parse_plc_value(params: &Value, data_type: &PlcDataType) -> Result<PlcVariableValue, String> {
    let value = params
        .get("value")
        .ok_or_else(|| "Missing 'value' parameter".to_string())?;

    // 2026-04-29 typed PLC payload parser:
    // Converts JSON command values into explicit IEC 61131-3 typed values before
    // byte encoding. This avoids lossy `as` casts and rejects out-of-range
    // writes before any PLC connection is opened.
    match data_type {
        PlcDataType::Bool => value
            .as_bool()
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|s| match s.to_ascii_lowercase().as_str() {
                        "true" | "1" | "on" | "high" => Some(true),
                        "false" | "0" | "off" | "low" => Some(false),
                        _ => None,
                    })
            })
            .map(PlcVariableValue::Bool)
            .ok_or_else(|| "BOOL value must be boolean-like".to_string()),
        PlcDataType::Sint => i8::try_from(number_as_i64(value, "SINT value")?)
            .map(PlcVariableValue::Sint)
            .map_err(|_| "SINT value out of range".to_string()),
        PlcDataType::Int => i16::try_from(number_as_i64(value, "INT value")?)
            .map(PlcVariableValue::Int)
            .map_err(|_| "INT value out of range".to_string()),
        PlcDataType::Dint | PlcDataType::Time => i32::try_from(number_as_i64(value, "DINT value")?)
            .map(PlcVariableValue::Dint)
            .map_err(|_| "DINT value out of range".to_string()),
        PlcDataType::Lint => Ok(PlcVariableValue::Lint(number_as_i64(value, "LINT value")?)),
        PlcDataType::Usint | PlcDataType::Byte => value
            .as_u64()
            .and_then(|v| u8::try_from(v).ok())
            .map(PlcVariableValue::Usint)
            .ok_or_else(|| "USINT/BYTE value out of range".to_string()),
        PlcDataType::Uint => value
            .as_u64()
            .and_then(|v| u16::try_from(v).ok())
            .map(PlcVariableValue::Uint)
            .ok_or_else(|| "UINT value out of range".to_string()),
        PlcDataType::Word => value
            .as_u64()
            .and_then(|v| u16::try_from(v).ok())
            .map(PlcVariableValue::Uint)
            .ok_or_else(|| "WORD value out of range".to_string()),
        PlcDataType::Udint | PlcDataType::Dword => value
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .map(PlcVariableValue::Udint)
            .ok_or_else(|| "UDINT value out of range".to_string()),
        PlcDataType::Ulint | PlcDataType::Lword => value
            .as_u64()
            .map(PlcVariableValue::Ulint)
            .ok_or_else(|| "ULINT value must be an unsigned integer".to_string()),
        PlcDataType::Real => value
            .as_f64()
            .map(|v| PlcVariableValue::Real(v as f32))
            .ok_or_else(|| "REAL value must be numeric".to_string()),
        PlcDataType::Lreal => value
            .as_f64()
            .map(PlcVariableValue::Lreal)
            .ok_or_else(|| "LREAL value must be numeric".to_string()),
        PlcDataType::String => value
            .as_str()
            .map(|v| PlcVariableValue::String(v.to_string()))
            .ok_or_else(|| "STRING value must be a string".to_string()),
        PlcDataType::Wstring => value
            .as_str()
            .map(|v| PlcVariableValue::WString(v.to_string()))
            .ok_or_else(|| "WSTRING value must be a string".to_string()),
        _ => Err("ARRAY/STRUCT PLC writes are not supported by this command".to_string()),
    }
}

// 2026-04-29 PLC connection inventory guard:
// Direct PLC writes must target a pre-validated config inventory entry. This
// prevents command payloads from smuggling ad-hoc endpoints or credentials into
// a physical write path.
fn required_connection_id(params: &Value) -> Result<&str, String> {
    params
        .get("connection_id")
        .or_else(|| params.get("connection_name"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Missing 'connection_id' parameter".to_string())
}

// 2026-04-29 command payload boundary:
// Rejects connection-material overrides so MQTT callers can choose only a
// named connection and cannot alter endpoint, port, rack/slot, or secret fields
// per command.
fn reject_connection_overrides(params: &Value, fields: &[&str]) -> Result<(), String> {
    if let Some(field) = fields.iter().find(|field| params.get(**field).is_some()) {
        return Err(format!(
            "Connection field '{}' is not accepted in command payload; use configured connection_id",
            field
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_connection_id_accepts_primary_field() {
        let params = serde_json::json!({
            "connection_id": "plc-line-1",
            "address": "ns=2;s=Pump.Speed",
            "value": 12
        });

        assert_eq!(required_connection_id(&params).unwrap(), "plc-line-1");
    }

    #[test]
    fn required_connection_id_accepts_legacy_connection_name_alias() {
        let params = serde_json::json!({
            "connection_name": "plc-line-2",
            "address": "DB1.DBW0",
            "value": 42
        });

        assert_eq!(required_connection_id(&params).unwrap(), "plc-line-2");
    }

    #[test]
    fn required_connection_id_rejects_missing_or_empty_values() {
        assert!(required_connection_id(&serde_json::json!({})).is_err());
        assert!(required_connection_id(&serde_json::json!({"connection_id": "   "})).is_err());
    }

    #[test]
    fn reject_connection_overrides_blocks_endpoint_material() {
        let params = serde_json::json!({
            "connection_id": "plc-line-1",
            "endpoint_url": "opc.tcp://attacker.example:4840"
        });

        let err = reject_connection_overrides(&params, &["endpoint_url"]).unwrap_err();
        assert!(err.contains("endpoint_url"));
        assert!(err.contains("configured connection_id"));
    }

    #[test]
    fn reject_connection_overrides_allows_clean_command_payload() {
        let params = serde_json::json!({
            "connection_id": "plc-line-1",
            "address": "ns=2;s=Pump.Speed",
            "value": 12
        });

        assert!(reject_connection_overrides(&params, &["endpoint_url", "password"]).is_ok());
    }
}

impl CommandHandler {
    /// Write to Modbus register.
    ///
    /// WHY BOUNDS-CHECK: Modbus holding registers are 16-bit by
    /// spec (IEC 61131-3). An address or value exceeding u16::MAX
    /// indicates operator error or a malformed cloud-originated
    /// command — returning a specific bounds-error surface
    /// (address vs value) gives the operator an actionable
    /// diagnostic.
    pub(super) async fn cmd_write_modbus(&self, params: &Value) -> (bool, Value, Option<String>) {
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

        match handle
            .write_register_checked(device_name, address, value)
            .await
        {
            Ok(receipt) => {
                info!("Wrote {} to register {} on {}", value, address, device_name);
                (
                    true,
                    json!({
                        "device": device_name,
                        "address": address,
                        "value": value,
                        "protocol_ack": receipt.protocol_ack,
                        "readback_enabled": receipt.readback_enabled,
                        "readback_verified": receipt.readback_verified,
                        "readback_value": receipt.readback_value,
                    }),
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
    pub(super) async fn cmd_write_gpio(&self, params: &Value) -> (bool, Value, Option<String>) {
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
    pub(super) async fn cmd_write_opcua(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing write_opcua command");

        let node_address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) if !a.trim().is_empty() => a,
            _ => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };
        if let Err(e) = reject_connection_overrides(
            params,
            &[
                "device",
                "plc_address",
                "port",
                "endpoint_url",
                "username",
                "password",
                "client_cert_path",
                "client_key_path",
                "timeout_secs",
                "session_timeout_ms",
                "program_namespace",
            ],
        ) {
            return (false, json!(null), Some(e));
        }
        let connection_id = match required_connection_id(params) {
            Ok(id) => id,
            Err(e) => return (false, json!(null), Some(e)),
        };

        let data_type = match parse_plc_data_type(params) {
            Ok(dt) => dt,
            Err(e) => return (false, json!(null), Some(e)),
        };
        let typed_value = match parse_plc_value(params, &data_type) {
            Ok(v) => v,
            Err(e) => return (false, json!(null), Some(e)),
        };
        let bytes = variable_value_to_bytes(&typed_value);

        let config = {
            let state = self.state.read().await;
            state
                .config
                .plc_programming
                .opcua
                .iter()
                .find(|cfg| cfg.name == connection_id)
                .cloned()
        };
        let config = match config {
            Some(config) => config,
            None => {
                return (
                    false,
                    json!(null),
                    Some(format!("Unknown OPC-UA connection_id '{}'", connection_id)),
                );
            }
        };

        let mut client = OpcUaClient::new(config);
        if let Err(e) = client.connect().await {
            return (
                false,
                json!(null),
                Some(format!("OPC-UA connect failed: {}", e)),
            );
        }

        // 2026-04-29 OPC UA command write implementation:
        // The command no longer returns a stub. It writes through the typed PLC
        // client and verifies the same node with readback before reporting
        // success, preventing a false-positive setpoint response.
        let write_result = client
            .write_variable(node_address, &data_type, &bytes)
            .await;
        let result = match write_result {
            Ok(()) => match client.read_variable(node_address, &data_type, 1).await {
                Ok(readback_bytes) => match bytes_to_variable_value(&readback_bytes, &data_type) {
                    Ok(readback_value) if readback_value == typed_value => (
                        true,
                        json!({
                            "protocol": "opcua",
                            "connection_id": connection_id,
                            "address": node_address,
                            "data_type": data_type,
                            "value": typed_value,
                            "readback_verified": true,
                            "readback_value": readback_value,
                        }),
                        None,
                    ),
                    Ok(readback_value) => (
                        false,
                        json!({
                            "protocol": "opcua",
                            "connection_id": connection_id,
                            "address": node_address,
                            "data_type": data_type,
                            "value": typed_value,
                            "readback_verified": false,
                            "readback_value": readback_value,
                        }),
                        Some("OPC-UA readback mismatch".to_string()),
                    ),
                    Err(e) => (
                        false,
                        json!(null),
                        Some(format!("OPC-UA readback decode failed: {}", e)),
                    ),
                },
                Err(e) => (
                    false,
                    json!(null),
                    Some(format!("OPC-UA readback failed: {}", e)),
                ),
            },
            Err(e) => (
                false,
                json!(null),
                Some(format!("OPC-UA write failed: {}", e)),
            ),
        };

        if let Err(e) = client.disconnect().await {
            warn!("OPC-UA disconnect after write failed: {}", e);
        }
        result
    }

    /// Write a value to an S7 PLC via S7comm protocol.
    pub(super) async fn cmd_write_s7(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing write_s7 command");

        let variable_address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) if !a.trim().is_empty() => a,
            _ => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };
        if let Err(e) = reject_connection_overrides(
            params,
            &[
                "device",
                "plc_address",
                "port",
                "rack",
                "slot",
                "plc_type",
                "timeout_secs",
                "pdu_size",
            ],
        ) {
            return (false, json!(null), Some(e));
        }
        let connection_id = match required_connection_id(params) {
            Ok(id) => id,
            Err(e) => return (false, json!(null), Some(e)),
        };
        let data_type = match parse_plc_data_type(params) {
            Ok(dt) => dt,
            Err(e) => return (false, json!(null), Some(e)),
        };
        let typed_value = match parse_plc_value(params, &data_type) {
            Ok(v) => v,
            Err(e) => return (false, json!(null), Some(e)),
        };
        let bytes = variable_value_to_bytes(&typed_value);

        let config = {
            let state = self.state.read().await;
            state
                .config
                .plc_programming
                .s7
                .iter()
                .find(|cfg| cfg.name == connection_id)
                .cloned()
        };
        let config = match config {
            Some(config) => config,
            None => {
                return (
                    false,
                    json!(null),
                    Some(format!("Unknown S7 connection_id '{}'", connection_id)),
                );
            }
        };

        let mut client = S7Client::new(config);
        if let Err(e) = client.connect().await {
            return (
                false,
                json!(null),
                Some(format!("S7 connect failed: {}", e)),
            );
        }

        // 2026-04-29 S7 command write implementation:
        // Uses the existing S7comm primitive and requires readback equality
        // before returning success, eliminating the previous public stub path.
        let write_result = client
            .write_variable(variable_address, &data_type, &bytes)
            .await;
        let result = match write_result {
            Ok(()) => match client.read_variable(variable_address, &data_type, 1).await {
                Ok(readback_bytes) => match bytes_to_variable_value(&readback_bytes, &data_type) {
                    Ok(readback_value) if readback_value == typed_value => (
                        true,
                        json!({
                            "protocol": "s7comm",
                            "connection_id": connection_id,
                            "address": variable_address,
                            "data_type": data_type,
                            "value": typed_value,
                            "readback_verified": true,
                            "readback_value": readback_value,
                        }),
                        None,
                    ),
                    Ok(readback_value) => (
                        false,
                        json!({
                            "protocol": "s7comm",
                            "connection_id": connection_id,
                            "address": variable_address,
                            "data_type": data_type,
                            "value": typed_value,
                            "readback_verified": false,
                            "readback_value": readback_value,
                        }),
                        Some("S7 readback mismatch".to_string()),
                    ),
                    Err(e) => (
                        false,
                        json!(null),
                        Some(format!("S7 readback decode failed: {}", e)),
                    ),
                },
                Err(e) => (
                    false,
                    json!(null),
                    Some(format!("S7 readback failed: {}", e)),
                ),
            },
            Err(e) => (false, json!(null), Some(format!("S7 write failed: {}", e))),
        };

        if let Err(e) = client.disconnect().await {
            warn!("S7 disconnect after write failed: {}", e);
        }
        result
    }
}
