//! Command handler for remote commands
//!
//! Receives and executes commands from the cloud platform.
//! Supports: ping, reboot, get_config, update_config, scripts, etc.

use chrono::Utc;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::mqtt::{CommandMessage, CommandResponse, IncomingMessage};
use crate::scripting::{ScriptDefinition, ScriptStorage};
use crate::AppState;

/// Command handler
pub struct CommandHandler {
    state: Arc<RwLock<AppState>>,
    script_storage: ScriptStorage,
}

impl CommandHandler {
    /// Create a new command handler
    pub fn new(state: Arc<RwLock<AppState>>) -> Self {
        let mut script_storage = ScriptStorage::new(None);
        if let Err(e) = script_storage.init() {
            warn!("Script storage init failed in command handler: {}", e);
        }

        Self {
            state,
            script_storage,
        }
    }

    /// Run the command handler loop
    pub async fn run(mut self) {
        info!("Command handler started");

        loop {
            // Wait a bit before checking for messages
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

            // Check for incoming messages
            let message = {
                let mut state = self.state.write().await;
                if let Some(ref mut mqtt) = state.mqtt_client {
                    mqtt.try_recv()
                } else {
                    None
                }
            };

            if let Some(msg) = message {
                if let Err(e) = self.handle_message(msg).await {
                    error!("Failed to handle message: {}", e);
                }
            }
        }
    }

    /// Handle incoming message
    async fn handle_message(&mut self, message: IncomingMessage) -> anyhow::Result<()> {
        let state = self.state.read().await;
        let topics = state.mqtt_client.as_ref().map(|m| m.topics().clone());
        drop(state);

        let topics = match topics {
            Some(t) => t,
            None => return Ok(()),
        };

        // Check if this is a command message
        if message.topic == topics.commands {
            debug!("Received command message");

            // Parse command
            let command: CommandMessage = match serde_json::from_slice(&message.payload) {
                Ok(cmd) => cmd,
                Err(e) => {
                    warn!("Failed to parse command: {}", e);
                    return Ok(());
                }
            };

            info!(
                "Executing command: {} (id: {})",
                command.command, command.command_id
            );

            // Execute command
            let response = self.execute_command(&command).await;

            // Publish response
            let state = self.state.read().await;
            if let Some(ref mqtt) = state.mqtt_client {
                mqtt.publish_response(response).await?;
            }
        } else if message.topic == topics.config {
            debug!("Received config update");
            self.handle_config_update(&message.payload).await?;
        }

        Ok(())
    }

    /// Execute a command and return response
    async fn execute_command(&mut self, command: &CommandMessage) -> CommandResponse {
        let device_id = {
            let state = self.state.read().await;
            state.config.device_id.clone()
        };

        let (success, result, error) = match command.command.as_str() {
            "ping" => self.cmd_ping().await,
            "get_info" => self.cmd_get_info().await,
            "get_config" => self.cmd_get_config().await,
            "get_hardware" => self.cmd_get_hardware().await,
            "read_modbus" => self.cmd_read_modbus(&command.params).await,
            "write_modbus" => self.cmd_write_modbus(&command.params).await,
            "read_gpio" => self.cmd_read_gpio().await,
            "write_gpio" => self.cmd_write_gpio(&command.params).await,
            // Script commands
            "list_scripts" => self.cmd_list_scripts().await,
            "get_script" => self.cmd_get_script(&command.params).await,
            "deploy_script" => self.cmd_deploy_script(&command.params).await,
            "delete_script" => self.cmd_delete_script(&command.params).await,
            "enable_script" => self.cmd_enable_script(&command.params).await,
            "disable_script" => self.cmd_disable_script(&command.params).await,
            // System commands
            "reboot" => self.cmd_reboot(&command.params).await,
            "restart_agent" => self.cmd_restart_agent().await,
            "set_log_level" => self.cmd_set_log_level(&command.params).await,
            _ => {
                warn!("Unknown command: {}", command.command);
                (
                    false,
                    json!(null),
                    Some(format!("Unknown command: {}", command.command)),
                )
            }
        };

        CommandResponse {
            command_id: command.command_id.clone(),
            device_id,
            success,
            result,
            timestamp: Utc::now().to_rfc3339(),
            error,
        }
    }

    /// Ping command - simple health check
    async fn cmd_ping(&self) -> (bool, Value, Option<String>) {
        info!("Executing ping command");
        (
            true,
            json!({"pong": true, "timestamp": Utc::now().to_rfc3339()}),
            None,
        )
    }

    /// Get device info
    async fn cmd_get_info(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_info command");

        let state = self.state.read().await;

        let info = json!({
            "device_id": state.config.device_id,
            "device_code": state.config.device_code,
            "agent_version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "tenant_id": state.tenant_id,
            "mqtt_broker": state.config.mqtt.broker,
            "is_activated": state.is_activated,
        });

        (true, info, None)
    }

    /// Get current config
    async fn cmd_get_config(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_config command");

        let state = self.state.read().await;

        // Return safe subset of config (no secrets)
        let config = json!({
            "device_id": state.config.device_id,
            "device_code": state.config.device_code,
            "api_url": state.config.api_url,
            "telemetry": {
                "interval_seconds": state.config.telemetry.interval_seconds,
                "include_cpu": state.config.telemetry.include_cpu,
                "include_memory": state.config.telemetry.include_memory,
                "include_disk": state.config.telemetry.include_disk,
                "include_temperature": state.config.telemetry.include_temperature,
            },
            "logging": {
                "level": state.config.logging.level,
            },
            "modbus_devices": state.config.modbus.len(),
            "gpio_pins": state.config.gpio.len(),
        });

        (true, config, None)
    }

    /// Reboot the device
    async fn cmd_reboot(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing reboot command");

        // Check for delay parameter
        let delay_secs = params
            .get("delay_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(5);

        // Schedule reboot
        #[cfg(target_os = "linux")]
        {
            info!("Scheduling reboot in {} seconds", delay_secs);

            // Use tokio spawn to not block the response
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(delay_secs)).await;

                // Execute reboot
                let status = std::process::Command::new("shutdown")
                    .args(["-r", "now"])
                    .status();

                match status {
                    Ok(s) if s.success() => info!("Reboot initiated"),
                    Ok(s) => error!("Reboot command failed with status: {}", s),
                    Err(e) => error!("Failed to execute reboot: {}", e),
                }
            });

            (
                true,
                json!({"scheduled": true, "delay_seconds": delay_secs}),
                None,
            )
        }

        #[cfg(not(target_os = "linux"))]
        {
            warn!("Reboot not supported on this platform");
            (
                false,
                json!(null),
                Some("Reboot not supported on this platform".to_string()),
            )
        }
    }

    /// Restart the agent service
    async fn cmd_restart_agent(&self) -> (bool, Value, Option<String>) {
        info!("Executing restart_agent command");

        #[cfg(target_os = "linux")]
        {
            // Schedule restart
            tokio::spawn(async {
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                let status = std::process::Command::new("systemctl")
                    .args(["restart", "suderra-agent"])
                    .status();

                match status {
                    Ok(s) if s.success() => info!("Agent restart initiated"),
                    Ok(s) => error!("Restart command failed with status: {}", s),
                    Err(e) => error!("Failed to execute restart: {}", e),
                }
            });

            (true, json!({"scheduled": true}), None)
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

    /// Set log level
    async fn cmd_set_log_level(&self, params: &Value) -> (bool, Value, Option<String>) {
        let level = match params.get("level").and_then(|v| v.as_str()) {
            Some(l) => l,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'level' parameter".to_string()),
                )
            }
        };

        // Validate level
        let valid_levels = ["trace", "debug", "info", "warn", "error"];
        if !valid_levels.contains(&level.to_lowercase().as_str()) {
            return (
                false,
                json!(null),
                Some(format!("Invalid level. Valid: {:?}", valid_levels)),
            );
        }

        info!("Setting log level to: {}", level);

        // Update config
        let mut state = self.state.write().await;
        state.config.logging.level = level.to_lowercase();

        // Note: Actually changing the tracing level at runtime requires more setup
        // For now, we just update the config (effective after restart)

        (
            true,
            json!({"level": level, "note": "Effective after agent restart"}),
            None,
        )
    }

    /// Get hardware info - lists all connected devices and sensors
    async fn cmd_get_hardware(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_hardware command");

        let state = self.state.read().await;

        // Collect Modbus device info
        let modbus_devices: Vec<Value> = state
            .config
            .modbus
            .iter()
            .map(|device| {
                json!({
                    "name": device.name,
                    "connection_type": device.connection_type,
                    "address": device.address,
                    "slave_id": device.slave_id,
                    "registers": device.registers.iter().map(|r| {
                        json!({
                            "name": r.name,
                            "address": r.address,
                            "type": r.register_type,
                            "data_type": r.data_type,
                            "unit": r.unit
                        })
                    }).collect::<Vec<_>>()
                })
            })
            .collect();

        // Collect GPIO pin info
        let gpio_pins: Vec<Value> = state
            .config
            .gpio
            .iter()
            .map(|pin| {
                json!({
                    "name": pin.name,
                    "pin": pin.pin,
                    "direction": pin.direction,
                    "pull": pin.pull,
                    "invert": pin.invert
                })
            })
            .collect();

        // Check hardware availability
        let modbus_connected = state.modbus_handle.is_some();
        let gpio_available = state
            .gpio_manager
            .as_ref()
            .map(|g| g.is_available())
            .unwrap_or(false);

        let hardware_info = json!({
            "modbus": {
                "configured": !modbus_devices.is_empty(),
                "connected": modbus_connected,
                "devices": modbus_devices
            },
            "gpio": {
                "configured": !gpio_pins.is_empty(),
                "available": gpio_available,
                "pins": gpio_pins
            },
            "platform": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH
            }
        });

        (true, hardware_info, None)
    }

    /// Read all Modbus registers or specific device
    async fn cmd_read_modbus(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing read_modbus command");

        let _device_name = params.get("device").and_then(|v| v.as_str());

        // Get modbus handle (thread-safe)
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
                )
            }
        };

        // Read all devices (device filtering can be added via handle if needed)
        let results = handle.read_all().await;
        let data: Vec<Value> = results
            .iter()
            .map(|result| {
                json!({
                    "device": result.device_name,
                    "values": result.values.iter().map(|v| {
                        json!({
                            "name": v.name,
                            "address": v.address,
                            "raw_value": v.raw_value,
                            "scaled_value": v.scaled_value,
                            "unit": v.unit,
                            "timestamp": v.timestamp
                        })
                    }).collect::<Vec<_>>(),
                    "errors": result.errors.clone()
                })
            })
            .collect();

        (true, json!({"devices": data}), None)
    }

    /// Write to Modbus register
    async fn cmd_write_modbus(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing write_modbus command");

        let device_name = match params.get("device").and_then(|v| v.as_str()) {
            Some(d) => d,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'device' parameter".to_string()),
                )
            }
        };

        let address = match params.get("address").and_then(|v| v.as_u64()) {
            Some(a) => a as u16,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                )
            }
        };

        let value = match params.get("value").and_then(|v| v.as_u64()) {
            Some(v) => v as u16,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'value' parameter".to_string()),
                )
            }
        };

        // Get modbus handle (thread-safe)
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
                )
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

    /// Read all GPIO pins
    async fn cmd_read_gpio(&self) -> (bool, Value, Option<String>) {
        info!("Executing read_gpio command");

        let state = self.state.read().await;

        let gpio_manager = match state.gpio_manager.as_ref() {
            Some(g) => g,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No GPIO pins configured".to_string()),
                )
            }
        };

        let result = gpio_manager.read_all();

        let pins: Vec<Value> = result
            .values
            .iter()
            .map(|v| {
                json!({
                    "name": v.name,
                    "pin": v.pin,
                    "direction": v.direction,
                    "state": format!("{:?}", v.state).to_lowercase(),
                    "timestamp": v.timestamp
                })
            })
            .collect();

        if result.errors.is_empty() {
            (true, json!({"pins": pins}), None)
        } else {
            (true, json!({"pins": pins, "errors": result.errors}), None)
        }
    }

    /// Write to GPIO pin
    async fn cmd_write_gpio(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing write_gpio command");

        let pin = match params.get("pin").and_then(|v| v.as_u64()) {
            Some(p) => p as u8,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'pin' parameter".to_string()),
                )
            }
        };

        let state_value = match params.get("state").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'state' parameter (high/low)".to_string()),
                )
            }
        };

        let pin_state = match state_value.to_lowercase().as_str() {
            "high" | "1" | "true" | "on" => crate::gpio::PinState::High,
            "low" | "0" | "false" | "off" => crate::gpio::PinState::Low,
            _ => {
                return (
                    false,
                    json!(null),
                    Some("Invalid state. Use 'high' or 'low'".to_string()),
                )
            }
        };

        let mut state = self.state.write().await;

        let gpio_manager = match state.gpio_manager.as_mut() {
            Some(g) => g,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No GPIO pins configured".to_string()),
                )
            }
        };

        match gpio_manager.write_pin(pin, pin_state) {
            Ok(()) => {
                info!("Set GPIO pin {} to {:?}", pin, pin_state);
                (true, json!({"pin": pin, "state": state_value}), None)
            }
            Err(e) => {
                error!("Failed to write GPIO pin: {}", e);
                (false, json!(null), Some(format!("Write failed: {}", e)))
            }
        }
    }

    // === Script Commands ===

    /// List all scripts
    async fn cmd_list_scripts(&self) -> (bool, Value, Option<String>) {
        info!("Executing list_scripts command");

        let scripts: Vec<Value> = self
            .script_storage
            .get_all()
            .iter()
            .map(|s| {
                json!({
                    "id": s.definition.id,
                    "name": s.definition.name,
                    "description": s.definition.description,
                    "enabled": s.definition.enabled,
                    "status": format!("{:?}", s.status).to_lowercase(),
                    "triggers": s.definition.triggers.len(),
                    "actions": s.definition.actions.len(),
                    "last_run": s.last_run,
                    "last_result": s.last_result,
                    "error_count": s.error_count
                })
            })
            .collect();

        (
            true,
            json!({"scripts": scripts, "count": scripts.len()}),
            None,
        )
    }

    /// Get a specific script
    async fn cmd_get_script(&self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                )
            }
        };

        info!("Executing get_script command for: {}", script_id);

        match self.script_storage.get(script_id) {
            Some(script) => {
                let data = json!({
                    "id": script.definition.id,
                    "name": script.definition.name,
                    "description": script.definition.description,
                    "version": script.definition.version,
                    "enabled": script.definition.enabled,
                    "status": format!("{:?}", script.status).to_lowercase(),
                    "triggers": script.definition.triggers,
                    "conditions": script.definition.conditions,
                    "actions": script.definition.actions,
                    "on_error": script.definition.on_error,
                    "last_run": script.last_run,
                    "last_result": script.last_result,
                    "error_count": script.error_count,
                    "created_at": script.created_at,
                    "updated_at": script.updated_at
                });
                (true, data, None)
            }
            None => (
                false,
                json!(null),
                Some(format!("Script '{}' not found", script_id)),
            ),
        }
    }

    /// Deploy (add/update) a script
    async fn cmd_deploy_script(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing deploy_script command");

        // Parse script definition from params
        let definition: ScriptDefinition = match serde_json::from_value(params.clone()) {
            Ok(def) => def,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid script definition: {}", e)),
                );
            }
        };

        let script_id = definition.id.clone();
        let script_name = definition.name.clone();

        match self.script_storage.add_script(definition) {
            Ok(()) => {
                info!("Script deployed: {} ({})", script_name, script_id);
                (
                    true,
                    json!({
                        "id": script_id,
                        "name": script_name,
                        "message": "Script deployed successfully"
                    }),
                    None,
                )
            }
            Err(e) => {
                error!("Failed to deploy script: {}", e);
                (false, json!(null), Some(format!("Deploy failed: {}", e)))
            }
        }
    }

    /// Delete a script
    async fn cmd_delete_script(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                )
            }
        };

        info!("Executing delete_script command for: {}", script_id);

        match self.script_storage.delete(script_id) {
            Ok(true) => (true, json!({"id": script_id, "deleted": true}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!("Script '{}' not found", script_id)),
            ),
            Err(e) => (false, json!(null), Some(format!("Delete failed: {}", e))),
        }
    }

    /// Enable a script
    async fn cmd_enable_script(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                )
            }
        };

        info!("Executing enable_script command for: {}", script_id);

        match self.script_storage.enable(script_id) {
            Ok(true) => (true, json!({"id": script_id, "enabled": true}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!("Script '{}' not found", script_id)),
            ),
            Err(e) => (false, json!(null), Some(format!("Enable failed: {}", e))),
        }
    }

    /// Disable a script
    async fn cmd_disable_script(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                )
            }
        };

        info!("Executing disable_script command for: {}", script_id);

        match self.script_storage.disable(script_id) {
            Ok(true) => (true, json!({"id": script_id, "enabled": false}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!("Script '{}' not found", script_id)),
            ),
            Err(e) => (false, json!(null), Some(format!("Disable failed: {}", e))),
        }
    }

    /// Handle config update from cloud
    async fn handle_config_update(&self, payload: &[u8]) -> anyhow::Result<()> {
        let config_update: Value = serde_json::from_slice(payload)?;
        info!("Received config update: {:?}", config_update);

        // TODO: Apply config updates (telemetry interval, modbus config, etc.)
        // This would require more sophisticated config merging logic

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_response_serialization() {
        let response = CommandResponse {
            command_id: "cmd-123".to_string(),
            device_id: "device-456".to_string(),
            success: true,
            result: json!({"pong": true}),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            error: None,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("command_id"));
        assert!(json.contains("pong"));
        assert!(!json.contains("error")); // None fields skipped
    }
}
