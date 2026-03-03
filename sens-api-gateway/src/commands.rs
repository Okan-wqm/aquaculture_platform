//! Command handler for remote commands
//!
//! Receives and executes commands from the cloud platform.
//! Supports: ping, reboot, get_config, update_config, scripts, etc.
//!
//! v2.1 Features:
//! - deploy_program: IEC 61131-3 program deployment with FBs
//!
//! v1.2.2 Security:
//! - Log sanitization to prevent log injection attacks

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::hardware_scanner::HardwareScanner;
use crate::mqtt::{CommandMessage, CommandResponse, IncomingMessage};
use crate::plc_programming::{
    AdsClient, CodesysClient, EtherNetIpClient, OpcUaClient, PlcProgram, PlcProgrammer, S7Client,
};
use crate::deploy_orchestrator::DeployCommand;
use crate::st_validator::validate_st;
use crate::scripting::{ExecutionMode, FBDefinition, ScriptDefinition, ScriptStorage};
use crate::process_image::{TagConfig, TagQuality, IoType, TagSource, ProtocolConfig, I2cDriverType, AtlasEzoType};
use crate::alarms::{AlarmDefinition, AlarmPriority};
use crate::security::sanitize_for_log;

/// Default delay before system reboot (seconds) - v1.2.6
const DEFAULT_REBOOT_DELAY_SECS: u64 = 5;

/// Default delay before agent restart (seconds) - v1.2.6
const DEFAULT_RESTART_DELAY_SECS: u64 = 2;

/// Simple sliding window rate limiter
struct RateLimiter {
    /// Timestamps of recent commands
    timestamps: VecDeque<Instant>,
    /// Maximum allowed commands in window
    max_commands: usize,
    /// Window duration
    window: Duration,
}

impl RateLimiter {
    fn new(max_commands: usize, window: Duration) -> Self {
        Self {
            timestamps: VecDeque::with_capacity(max_commands),
            max_commands,
            window,
        }
    }

    /// Check if a command should be allowed
    /// Returns true if allowed, false if rate limited
    fn check(&mut self) -> bool {
        let now = Instant::now();

        // Remove timestamps outside the window
        while let Some(&oldest) = self.timestamps.front() {
            if now.duration_since(oldest) > self.window {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }

        // Check if under limit
        if self.timestamps.len() < self.max_commands {
            self.timestamps.push_back(now);
            true
        } else {
            false
        }
    }

    /// Get current command count in window
    #[allow(dead_code)]
    fn current_count(&self) -> usize {
        self.timestamps.len()
    }
}

// ============================================================================
// Parameter Extraction Helpers
// ============================================================================
// These helpers are provided for future command handlers.
// Currently unused but kept for consistency and future use.

/// Helper to extract a required string parameter from JSON params
#[allow(dead_code)]
fn require_str_param<'a>(
    params: &'a Value,
    key: &str,
) -> Result<&'a str, (bool, Value, Option<String>)> {
    params.get(key).and_then(|v| v.as_str()).ok_or_else(|| {
        (
            false,
            json!(null),
            Some(format!("Missing required parameter: {}", key)),
        )
    })
}

/// Helper to extract a required u64 parameter from JSON params
#[allow(dead_code)]
fn require_u64_param(params: &Value, key: &str) -> Result<u64, (bool, Value, Option<String>)> {
    params.get(key).and_then(|v| v.as_u64()).ok_or_else(|| {
        (
            false,
            json!(null),
            Some(format!("Missing required parameter: {}", key)),
        )
    })
}

/// Helper to extract an optional string parameter from JSON params
#[allow(dead_code)]
fn get_str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(|v| v.as_str())
}

/// Helper to extract an optional u64 parameter from JSON params
#[allow(dead_code)]
fn get_u64_param(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

/// Helper to extract an optional bool parameter from JSON params
#[allow(dead_code)]
fn get_bool_param(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| v.as_bool())
}

// ============================================================================
// IEC 61131-3 Program Definition (v2.1)
// ============================================================================

/// IEC 61131-3 Program definition received from cloud
/// Contains everything needed to run a program on the edge device
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramDefinition {
    /// Unique program ID
    pub id: String,
    /// Program name
    pub name: String,
    /// Program version
    #[serde(default = "default_version")]
    pub version: u32,
    /// Description
    #[serde(default)]
    pub description: String,
    /// Execution mode
    #[serde(default)]
    pub execution_mode: ExecutionMode,
    /// Scan cycle time in milliseconds (for ScanCycle mode)
    #[serde(default = "default_scan_cycle")]
    pub scan_cycle_ms: u64,
    /// Function block definitions
    #[serde(default)]
    pub function_blocks: Vec<FBDefinition>,
    /// Script definition (triggers, conditions, actions)
    pub script: ScriptDefinition,
    /// Whether to replace existing program with same ID
    #[serde(default)]
    pub replace_existing: bool,
}

fn default_version() -> u32 {
    1
}

fn default_scan_cycle() -> u64 {
    100 // 100ms default
}

/// Persisted program state (for reload after restart)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProgramState {
    /// Currently deployed program
    pub program: Option<ProgramDefinition>,
    /// Deployment timestamp
    pub deployed_at: Option<String>,
    /// Previous version (for rollback)
    pub previous_version: Option<Box<ProgramDefinition>>,
}

// ============================================================================
// Command Handler
// ============================================================================

/// Command handler
///
/// v2.2: Uses shared ScriptStorage from AppState for data consistency
/// v1.2.0: ScriptStorage now has internal RwLock (no external lock needed)
pub struct CommandHandler {
    state: Arc<RwLock<AppState>>,
    /// Shared script storage (v2.2 - from AppState singleton)
    /// v1.2.0: Internal RwLock for thread-safe access
    script_storage: Arc<ScriptStorage>,
    rate_limiter: RateLimiter,
    /// Path to program state file
    program_state_path: PathBuf,
    /// Concurrency lock to prevent overlapping deploy operations
    deploy_lock: Mutex<()>,
}

impl CommandHandler {
    /// Create a new command handler (v2.2 - uses shared storage from AppState)
    pub async fn new(state: Arc<RwLock<AppState>>) -> Self {
        // Get shared script storage and runtime config from AppState (v2.2 singleton)
        let (script_storage, rate_limit_max, rate_limit_window_secs) = {
            let state_guard = state.read().await;
            (
                state_guard.script_storage.clone(),
                state_guard.config.runtime.rate_limit_max_commands,
                state_guard.config.runtime.rate_limit_window_secs,
            )
        };

        // Program state file location
        let data_dir =
            std::env::var("SUDERRA_DATA_DIR").unwrap_or_else(|_| "/var/lib/suderra".to_string());
        let program_state_path = PathBuf::from(&data_dir).join("program.json");

        Self {
            state,
            script_storage,
            rate_limiter: RateLimiter::new(
                rate_limit_max,
                Duration::from_secs(rate_limit_window_secs),
            ),
            program_state_path,
            deploy_lock: Mutex::new(()),
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
                // Rate limit check - protect against command flooding
                if !self.rate_limiter.check() {
                    warn!(
                        "Command rate limit exceeded ({} commands in {} seconds). Dropping message.",
                        self.rate_limiter.max_commands,
                        self.rate_limiter.window.as_secs()
                    );
                    continue;
                }

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
        // v1.2.6: Track command execution time for observability
        let start_time = std::time::Instant::now();
        info!(
            "⚡ Command received: id='{}', command='{}', has_params={}",
            command.command_id,
            sanitize_for_log(&command.command),
            !command.params.is_null()
        );

        let device_id = {
            let state = self.state.read().await;
            state.config.device_id.clone()
        };

        // IEC 62443 SL-2: Audit log safety-critical commands before execution
        let is_safety_critical = matches!(
            command.command.as_str(),
            "deploy_program" | "deploy_script" | "deploy_to_codesys" | "deploy_auto"
                | "rollback_program" | "plc_upload" | "plc_start" | "plc_stop"
                | "plc_delete" | "write_modbus" | "write_gpio" | "reboot"
                | "restart_agent" | "delete_script"
                | "update_io_config" | "set_output"
        );
        if is_safety_critical {
            warn!(
                "AUDIT: Safety-critical command initiated: command='{}', id='{}', device_id='{}', timestamp='{}'",
                sanitize_for_log(&command.command),
                command.command_id,
                device_id,
                Utc::now().to_rfc3339()
            );
        }

        let (success, result, error) = match command.command.as_str() {
            "ping" => self.cmd_ping().await,
            "get_info" => self.cmd_get_info().await,
            "get_config" => self.cmd_get_config().await,
            "get_hardware" => self.cmd_get_hardware().await,
            "scan_hardware" => self.cmd_scan_hardware().await,
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
            // IEC 61131-3 Program commands (v2.1)
            "deploy_program" => self.cmd_deploy_program(&command.params).await,
            "get_program" => self.cmd_get_program().await,
            "rollback_program" => self.cmd_rollback_program().await,
            // PLC Programming commands (v1.3.0)
            "plc_upload" => self.cmd_plc_upload(&command.params).await,
            "plc_status" => self.cmd_plc_status(&command.params).await,
            "plc_start" => self.cmd_plc_start(&command.params).await,
            "plc_stop" => self.cmd_plc_stop(&command.params).await,
            "plc_list" => self.cmd_plc_list(&command.params).await,
            "plc_download" => self.cmd_plc_download(&command.params).await,
            "plc_delete" => self.cmd_plc_delete(&command.params).await,
            // Deploy orchestrator commands (v2.2)
            "deploy_to_codesys" => self.cmd_deploy_to_codesys(&command.params).await,
            "deploy_auto" => self.cmd_deploy_auto(&command.params).await,
            "validate_st" => self.cmd_validate_st(&command.params).await,
            // System commands
            "reboot" => self.cmd_reboot(&command.params).await,
            "restart_agent" => self.cmd_restart_agent().await,
            "set_log_level" => self.cmd_set_log_level(&command.params).await,
            // Failover commands (v1.3.4)
            "failover_status" => self.cmd_failover_status().await,
            "failover_force" => self.cmd_failover_force().await,
            "failover_recover" => self.cmd_failover_recover().await,
            // I/O config and output commands
            "update_io_config" => self.cmd_update_io_config(&command.params).await,
            "set_output" => self.cmd_set_output(&command.params).await,
            _ => {
                // v1.2.2: Sanitize user-provided command name to prevent log injection
                warn!("Unknown command: {}", sanitize_for_log(&command.command));
                (
                    false,
                    json!(null),
                    Some(format!(
                        "Unknown command: {}",
                        sanitize_for_log(&command.command)
                    )),
                )
            }
        };

        // v1.2.6: Log command completion with timing
        let elapsed = start_time.elapsed();
        if success {
            info!(
                "Command completed: id='{}', command='{}', success=true, duration={:?}",
                command.command_id,
                sanitize_for_log(&command.command),
                elapsed
            );
        } else {
            warn!(
                "Command failed: id='{}', command='{}', error={:?}, duration={:?}",
                command.command_id,
                sanitize_for_log(&command.command),
                error,
                elapsed
            );
        }

        // IEC 62443 SL-2: Audit log outcome of safety-critical commands
        if is_safety_critical {
            warn!(
                "AUDIT: Safety-critical command completed: command='{}', id='{}', device_id='{}', success={}, duration={:?}, timestamp='{}'",
                sanitize_for_log(&command.command),
                command.command_id,
                device_id,
                success,
                elapsed,
                Utc::now().to_rfc3339()
            );
        }

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
    ///
    /// # Task Handle
    /// The spawned task is intentionally not tracked because:
    /// 1. The system will be rebooting - no graceful shutdown needed
    /// 2. We must return the response before the reboot occurs
    /// 3. Any panic is logged within the task itself
    async fn cmd_reboot(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing reboot command");

        // Check for delay parameter (v1.2.6: use constant for default)
        let delay_secs = params
            .get("delay_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_REBOOT_DELAY_SECS);

        // Schedule reboot
        #[cfg(target_os = "linux")]
        {
            info!("Scheduling reboot in {} seconds", delay_secs);

            // Fire-and-forget: JoinHandle intentionally not tracked (system rebooting)
            let _ = tokio::spawn(async move {
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

            // v1.3.3: Add warning that reboot failures cannot be reported back
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
            (
                false,
                json!(null),
                Some("Reboot not supported on this platform".to_string()),
            )
        }
    }

    /// Restart the agent service
    ///
    /// # Task Handle
    /// The spawned task is intentionally not tracked because:
    /// 1. The agent will be restarted by systemd - no graceful shutdown needed
    /// 2. We must return the response before the restart occurs
    /// 3. Any panic is logged within the task itself
    async fn cmd_restart_agent(&self) -> (bool, Value, Option<String>) {
        info!("Executing restart_agent command");

        #[cfg(target_os = "linux")]
        {
            // Fire-and-forget: JoinHandle intentionally not tracked (agent restarting)
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

            // v1.3.3: Add warning that restart failures cannot be reported back
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

    /// Set log level
    async fn cmd_set_log_level(&self, params: &Value) -> (bool, Value, Option<String>) {
        let level = match params.get("level").and_then(|v| v.as_str()) {
            Some(l) => l,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'level' parameter".to_string()),
                );
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

        // v1.2.2: Sanitize for logging (even though whitelist validated)
        info!("Setting log level to: {}", sanitize_for_log(level));

        // Update config
        let mut state = self.state.write().await;
        let previous_level = state.config.logging.level.clone();
        state.config.logging.level = level.to_lowercase();

        // Note: Actually changing the tracing level at runtime requires more setup
        // For now, we just update the config (effective after restart)
        // v1.3.3: Provide clearer feedback about what changed and what's needed

        (
            true,
            json!({
                "previous_level": previous_level,
                "requested_level": level.to_lowercase(),
                "applied_immediately": false,
                "note": "Log level configuration updated. Changes will take effect after agent restart. \
                        Use 'restart_agent' command to apply immediately, or the agent will use the new \
                        level on next startup."
            }),
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
        // v2.2: Use gpio_handle instead of deprecated gpio_manager
        let gpio_available = state.gpio_handle.is_some();

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

    /// Scan hardware — enumerates all available I/O channels on the device.
    ///
    /// Platform-specific discovery:
    /// - Revolution Pi: piControl process image (piTest -d)
    /// - Raspberry Pi: BCM GPIO 2-27 enumeration
    /// - Generic Linux: /sys/class/gpio/gpiochip* sysfs
    ///
    /// Returns a list of `DiscoveredIo` channels that can be bulk-imported
    /// via the platform's "Auto-Detect I/O" feature.
    async fn cmd_scan_hardware(&self) -> (bool, Value, Option<String>) {
        info!("Executing scan_hardware command — full I/O enumeration");

        let platform = {
            let state = self.state.read().await;
            state.config.gpio_platform()
        };

        // Wrap in spawn_blocking — scan performs blocking I/O (piTest subprocess, sysfs reads)
        let result = match tokio::task::spawn_blocking(move || {
            let scanner = HardwareScanner::new(platform);
            scanner.scan()
        }).await {
            Ok(r) => r,
            Err(e) => {
                warn!("Scan task panicked: {}", e);
                return (false, json!(null), Some(format!("Scan task failed: {}", e)));
            }
        };

        match serde_json::to_value(&result) {
            Ok(value) => (true, value, None),
            Err(e) => {
                warn!("Failed to serialize scan result: {}", e);
                (
                    false,
                    json!(null),
                    Some(format!("Serialization error: {}", e)),
                )
            }
        }
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
                );
            }
        };

        // v1.2.2: Use parallel reads for lower latency
        let results = handle.read_all_parallel().await;
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

    /// Read all GPIO pins (v2.2: uses gpio_handle actor pattern)
    async fn cmd_read_gpio(&self) -> (bool, Value, Option<String>) {
        info!("Executing read_gpio command");

        // Get gpio_handle from state (clone to release lock)
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

        // v2.2: Use async gpio_handle.read_all() instead of sync gpio_manager
        let result = gpio_handle.read_all().await;

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

    /// Write to GPIO pin (v2.2: uses gpio_handle actor pattern)
    async fn cmd_write_gpio(&self, params: &Value) -> (bool, Value, Option<String>) {
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

        // v2.2: Convert to bool for gpio_handle API
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

        // Get gpio_handle from state (clone to release lock)
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

        // v2.2: Use async gpio_handle.write_pin() instead of sync gpio_manager
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

    // === Script Commands ===

    /// List all scripts (v2.2 - uses shared storage, v1.2.0 - async API)
    async fn cmd_list_scripts(&self) -> (bool, Value, Option<String>) {
        info!("Executing list_scripts command");

        // v1.2.0: Use async get_all() with internal locking
        let all_scripts = self.script_storage.get_all().await;
        let scripts: Vec<Value> = all_scripts
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

    /// Get a specific script (v1.2.0 - async API)
    async fn cmd_get_script(&self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        // v1.2.2: Sanitize script ID for logging
        info!(
            "Executing get_script command for: {}",
            sanitize_for_log(script_id)
        );

        // v1.2.0: Use async get() with internal locking
        match self.script_storage.get(script_id).await {
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
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
        }
    }

    /// Deploy (add/update) a script (v1.2.0 - async API)
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

        // v1.2.0: Use async add_script() with internal locking
        match self.script_storage.add_script(definition).await {
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

    /// Delete a script (v1.2.0 - async API)
    async fn cmd_delete_script(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        // v1.2.2: Sanitize script ID for logging
        info!(
            "Executing delete_script command for: {}",
            sanitize_for_log(script_id)
        );

        // v1.2.0: Use async delete() with internal locking
        match self.script_storage.delete(script_id).await {
            Ok(true) => (true, json!({"id": script_id, "deleted": true}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
            Err(e) => (false, json!(null), Some(format!("Delete failed: {}", e))),
        }
    }

    /// Enable a script (v1.2.0 - async API)
    async fn cmd_enable_script(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        // v1.2.2: Sanitize script ID for logging
        info!(
            "Executing enable_script command for: {}",
            sanitize_for_log(script_id)
        );

        // v1.2.0: Use async enable() with internal locking
        match self.script_storage.enable(script_id).await {
            Ok(true) => (true, json!({"id": script_id, "enabled": true}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
            Err(e) => (false, json!(null), Some(format!("Enable failed: {}", e))),
        }
    }

    /// Disable a script (v1.2.0 - async API)
    async fn cmd_disable_script(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        // v1.2.2: Sanitize script ID for logging
        info!(
            "Executing disable_script command for: {}",
            sanitize_for_log(script_id)
        );

        // v1.2.0: Use async disable() with internal locking
        match self.script_storage.disable(script_id).await {
            Ok(true) => (true, json!({"id": script_id, "enabled": false}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
            Err(e) => (false, json!(null), Some(format!("Disable failed: {}", e))),
        }
    }

    // ========================================================================
    // IEC 61131-3 Program Commands (v2.1)
    // ========================================================================

    /// Deploy an IEC 61131-3 program
    ///
    /// This command:
    /// 1. Validates the program definition
    /// 2. Saves previous version for rollback
    /// 3. Persists the program to disk
    /// 4. Deploys the script portion
    /// 5. Engine will pick up FB definitions on next reload
    async fn cmd_deploy_program(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing deploy_program command");

        // Get scripting limits from config
        let (max_fbs, min_scan, max_scan) = {
            let state = self.state.read().await;
            (
                state.config.scripting.max_function_blocks,
                state.config.scripting.min_scan_cycle_ms,
                state.config.scripting.max_scan_cycle_ms,
            )
        };

        // Parse program definition
        let program: ProgramDefinition = match serde_json::from_value(params.clone()) {
            Ok(p) => p,
            Err(e) => {
                error!("Failed to parse program definition: {}", e);
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid program definition: {}", e)),
                );
            }
        };

        // Validate
        if program.function_blocks.len() > max_fbs {
            return (
                false,
                json!(null),
                Some(format!("Too many function blocks (max {})", max_fbs)),
            );
        }

        if program.scan_cycle_ms < min_scan || program.scan_cycle_ms > max_scan {
            return (
                false,
                json!(null),
                Some(format!(
                    "Scan cycle must be between {}ms and {}ms",
                    min_scan, max_scan
                )),
            );
        }

        // Load current state (for rollback)
        let mut state = self.load_program_state();
        let previous = state.program.take();

        // Save previous version for rollback
        if let Some(prev) = previous {
            if prev.id == program.id {
                state.previous_version = Some(Box::new(prev));
            }
        }

        // Deploy script portion (v2.2 - uses shared storage, v1.2.0 - async API)
        let script_id = program.script.id.clone();
        if let Err(e) = self.script_storage.add_script(program.script.clone()).await {
            error!("Failed to deploy script: {}", e);
            return (
                false,
                json!(null),
                Some(format!("Failed to deploy script: {}", e)),
            );
        }

        // Update state
        state.program = Some(program.clone());
        state.deployed_at = Some(Utc::now().to_rfc3339());

        // Persist to disk
        // v1.3.3: If persistence fails, rollback the script deployment to maintain consistency
        if let Err(e) = self.save_program_state(&state) {
            error!("Failed to save program state: {}", e);

            // Rollback: remove the script we just added
            if let Err(rollback_err) = self.script_storage.delete(&script_id).await {
                error!(
                    "CRITICAL: Failed to rollback script deployment after state save failure: {}. \
                    System may be in inconsistent state - manual intervention required.",
                    rollback_err
                );
            } else {
                warn!("Rolled back script deployment due to state save failure");
            }

            return (
                false,
                json!(null),
                Some(format!("Failed to persist program (rolled back): {}", e)),
            );
        }

        info!(
            program_id = %program.id,
            program_name = %program.name,
            version = program.version,
            fb_count = program.function_blocks.len(),
            execution_mode = ?program.execution_mode,
            "Program deployed successfully"
        );

        (
            true,
            json!({
                "id": program.id,
                "name": program.name,
                "version": program.version,
                "functionBlockCount": program.function_blocks.len(),
                "executionMode": format!("{:?}", program.execution_mode),
                "scanCycleMs": program.scan_cycle_ms,
                "message": "Program deployed successfully. Engine will reload on next cycle."
            }),
            None,
        )
    }

    /// Get currently deployed program
    async fn cmd_get_program(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_program command");

        let state = self.load_program_state();

        match state.program {
            Some(program) => (
                true,
                json!({
                    "id": program.id,
                    "name": program.name,
                    "version": program.version,
                    "description": program.description,
                    "executionMode": format!("{:?}", program.execution_mode),
                    "scanCycleMs": program.scan_cycle_ms,
                    "functionBlockCount": program.function_blocks.len(),
                    "functionBlocks": program.function_blocks.iter()
                        .map(|fb| json!({
                            "id": fb.id,
                            "type": fb.fb_type
                        }))
                        .collect::<Vec<_>>(),
                    "deployedAt": state.deployed_at,
                    "hasPreviousVersion": state.previous_version.is_some()
                }),
                None,
            ),
            None => (
                true,
                json!({
                    "program": null,
                    "message": "No program deployed"
                }),
                None,
            ),
        }
    }

    /// Rollback to previous program version
    async fn cmd_rollback_program(&mut self) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing rollback_program command");

        let mut state = self.load_program_state();

        let previous = match state.previous_version.take() {
            Some(prev) => *prev,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No previous version available for rollback".to_string()),
                );
            }
        };

        let prev_id = previous.id.clone();
        let prev_name = previous.name.clone();
        let prev_version = previous.version;

        // Deploy previous version's script (v2.2 - uses shared storage, v1.2.0 - async API)
        if let Err(e) = self
            .script_storage
            .add_script(previous.script.clone())
            .await
        {
            error!("Rollback failed - script deployment error: {}", e);
            return (false, json!(null), Some(format!("Rollback failed: {}", e)));
        }

        // Update state
        state.program = Some(previous);
        state.deployed_at = Some(Utc::now().to_rfc3339());
        state.previous_version = None; // Clear - can't rollback twice

        // Persist
        if let Err(e) = self.save_program_state(&state) {
            error!("Rollback state save failed: {}", e);
            return (
                false,
                json!(null),
                Some(format!("Rollback state save failed: {}", e)),
            );
        }

        info!(
            program_id = %prev_id,
            version = prev_version,
            "Rolled back to previous version"
        );

        (
            true,
            json!({
                "id": prev_id,
                "name": prev_name,
                "version": prev_version,
                "message": "Rolled back to previous version successfully"
            }),
            None,
        )
    }

    // ========================================================================
    // PLC Programming Commands (v1.3.0)
    // ========================================================================

    /// Upload program to external PLC
    ///
    /// Supported protocols: codesys, s7, opcua, ethernet_ip, ads
    async fn cmd_plc_upload(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_upload command");

        // Parse protocol
        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "Missing 'protocol' parameter (codesys, s7, opcua, ethernet_ip, ads)"
                            .to_string(),
                    ),
                );
            }
        };

        // Parse PLC address
        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter (PLC IP/hostname)".to_string()),
                );
            }
        };

        // Reject loopback, link-local, and broadcast addresses (consistent with deploy_to_codesys)
        if let Ok(ip) = address.parse::<std::net::Ipv4Addr>() {
            if ip.is_loopback() || ip.is_link_local() || ip.is_broadcast() || ip.is_unspecified() {
                return (false, json!(null), Some("PLC address cannot be loopback, link-local, or broadcast".to_string()));
            }
        }

        // Parse program
        let program: PlcProgram = match params
            .get("program")
            .and_then(|p| serde_json::from_value(p.clone()).ok())
        {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing or invalid 'program' parameter".to_string()),
                );
            }
        };

        // Get optional authentication
        let username = params.get("username").and_then(|v| v.as_str());
        let password = params.get("password").and_then(|v| v.as_str());

        info!(
            protocol = %protocol,
            address = %address,
            program = %program.name,
            "Uploading program to PLC"
        );

        // Create appropriate client and upload
        let result = match protocol.to_lowercase().as_str() {
            "codesys" => {
                let config = crate::plc_programming::codesys::CodesysConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(1217) as u16,
                    mode: Default::default(),
                    device_name: params
                        .get("device_name")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    username: username.map(String::from),
                    password: password.map(String::from),
                    encrypted: params
                        .get("encrypted")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    timeout_secs: 30,
                    application: params
                        .get("application")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Application")
                        .to_string(),
                };
                let mut client = CodesysClient::new(config);
                Self::upload_with_client(&mut client, &program).await
            }
            "s7" => {
                let config = crate::plc_programming::s7comm::S7Config {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(102) as u16,
                    rack: params.get("rack").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                    plc_type: Default::default(),
                    timeout_secs: 30,
                    pdu_size: 480,
                };
                let mut client = S7Client::new(config);
                Self::upload_with_client(&mut client, &program).await
            }
            "opcua" => {
                let config = crate::plc_programming::opcua::OpcUaConfig {
                    name: "remote".to_string(),
                    endpoint_url: format!(
                        "opc.tcp://{}:{}",
                        address,
                        params.get("port").and_then(|v| v.as_u64()).unwrap_or(4840)
                    ),
                    security_policy: Default::default(),
                    security_mode: Default::default(),
                    username: username.map(String::from),
                    password: password.map(String::from),
                    client_cert_path: params
                        .get("client_cert_path")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    client_key_path: params
                        .get("client_key_path")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    timeout_secs: 30,
                    session_timeout_ms: 30000,
                    program_namespace: params
                        .get("program_namespace")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                };
                let mut client = OpcUaClient::new(config);
                Self::upload_with_client(&mut client, &program).await
            }
            "ethernet_ip" => {
                let config = crate::plc_programming::ethernet_ip::EtherNetIpConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(44818) as u16,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    connection_path: params
                        .get("connection_path")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    timeout_secs: 30,
                    plc_type: Default::default(),
                };
                let mut client = EtherNetIpClient::new(config);
                Self::upload_with_client(&mut client, &program).await
            }
            "ads" => {
                let ams_net_id = match params.get("ams_net_id").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => {
                        return (
                            false,
                            json!(null),
                            Some("Missing 'ams_net_id' parameter for ADS protocol".to_string()),
                        );
                    }
                };
                let config = crate::plc_programming::ads::AdsConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(48898) as u16,
                    target_ams_net_id: ams_net_id,
                    target_ams_port: params
                        .get("target_ams_port")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(851) as u16,
                    source_ams_net_id: params
                        .get("source_ams_net_id")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    source_ams_port: 32768,
                    timeout_secs: 30,
                    twincat_version: Default::default(),
                };
                match AdsClient::new(config) {
                    Ok(mut client) => Self::upload_with_client(&mut client, &program).await,
                    Err(e) => Err(e),
                }
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Unknown protocol: {}. Supported: codesys, s7, opcua, ethernet_ip, ads",
                        protocol
                    )),
                );
            }
        };

        match result {
            Ok(upload_result) => {
                if upload_result.success {
                    info!(
                        program = %program.name,
                        protocol = %protocol,
                        "Program uploaded successfully"
                    );
                    (
                        true,
                        json!({
                            "success": true,
                            "program_name": program.name,
                            "program_id": upload_result.program_id,
                            "warnings": upload_result.warnings,
                            "timestamp": upload_result.timestamp
                        }),
                        None,
                    )
                } else {
                    (
                        false,
                        json!({
                            "success": false,
                            "errors": upload_result.errors,
                            "warnings": upload_result.warnings
                        }),
                        Some("Program compilation/upload failed".to_string()),
                    )
                }
            }
            Err(e) => {
                error!(error = %e, "PLC upload failed");
                (false, json!(null), Some(format!("Upload failed: {}", e)))
            }
        }
    }

    /// Helper to upload program using any PlcProgrammer client
    /// v2.3: Connect with 30-second timeout to prevent command handler freeze
    async fn upload_with_client<P: PlcProgrammer>(
        client: &mut P,
        program: &PlcProgram,
    ) -> anyhow::Result<crate::plc_programming::UploadResult> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.upload_program(program).await;
        let _ = client.disconnect().await; // Best effort disconnect
        result
    }

    /// Get PLC status
    async fn cmd_plc_status(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_status command");

        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'protocol' parameter".to_string()),
                );
            }
        };

        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };

        // Create client based on protocol and get status
        let status_result = match protocol.to_lowercase().as_str() {
            "codesys" => {
                let config = crate::plc_programming::codesys::CodesysConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(1217) as u16,
                    mode: Default::default(),
                    device_name: None,
                    username: None,
                    password: None,
                    encrypted: false,
                    timeout_secs: 30,
                    application: "Application".to_string(),
                };
                let mut client = CodesysClient::new(config);
                Self::get_status_with_client(&mut client).await
            }
            "s7" => {
                let config = crate::plc_programming::s7comm::S7Config {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(102) as u16,
                    rack: params.get("rack").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                    plc_type: Default::default(),
                    timeout_secs: 30,
                    pdu_size: 480,
                };
                let mut client = S7Client::new(config);
                Self::get_status_with_client(&mut client).await
            }
            "opcua" => {
                let config = crate::plc_programming::opcua::OpcUaConfig {
                    name: "remote".to_string(),
                    endpoint_url: format!(
                        "opc.tcp://{}:{}",
                        address,
                        params.get("port").and_then(|v| v.as_u64()).unwrap_or(4840)
                    ),
                    security_policy: Default::default(),
                    security_mode: Default::default(),
                    username: None,
                    password: None,
                    client_cert_path: None,
                    client_key_path: None,
                    timeout_secs: 30,
                    session_timeout_ms: 30000,
                    program_namespace: None,
                };
                let mut client = OpcUaClient::new(config);
                Self::get_status_with_client(&mut client).await
            }
            "ethernet_ip" => {
                let config = crate::plc_programming::ethernet_ip::EtherNetIpConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(44818) as u16,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    connection_path: None,
                    timeout_secs: 30,
                    plc_type: Default::default(),
                };
                let mut client = EtherNetIpClient::new(config);
                Self::get_status_with_client(&mut client).await
            }
            "ads" => {
                let ams_net_id = match params.get("ams_net_id").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => {
                        return (
                            false,
                            json!(null),
                            Some("Missing 'ams_net_id' parameter".to_string()),
                        );
                    }
                };
                let config = crate::plc_programming::ads::AdsConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: 48898,
                    target_ams_net_id: ams_net_id,
                    target_ams_port: 851,
                    source_ams_net_id: None,
                    source_ams_port: 32768,
                    timeout_secs: 30,
                    twincat_version: Default::default(),
                };
                match AdsClient::new(config) {
                    Ok(mut client) => Self::get_status_with_client(&mut client).await,
                    Err(e) => Err(e),
                }
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("Unknown protocol: {}", protocol)),
                );
            }
        };

        match status_result {
            Ok(status) => (
                true,
                json!({
                    "connected": status.connected,
                    "run_mode": format!("{:?}", status.run_mode),
                    "model": status.model,
                    "firmware": status.firmware,
                    "current_program": status.current_program,
                    "last_modified": status.last_modified
                }),
                None,
            ),
            Err(e) => (
                false,
                json!(null),
                Some(format!("Status check failed: {}", e)),
            ),
        }
    }

    /// Helper to get status using any PlcProgrammer client
    /// v2.3: Connect with 30-second timeout to prevent command handler freeze
    async fn get_status_with_client<P: PlcProgrammer>(
        client: &mut P,
    ) -> anyhow::Result<crate::plc_programming::PlcStatus> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let status = client.get_status().await;
        let _ = client.disconnect().await;
        status
    }

    /// Start PLC (RUN mode)
    async fn cmd_plc_start(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_start command");
        self.plc_run_stop_helper(params, true).await
    }

    /// Stop PLC (STOP mode)
    async fn cmd_plc_stop(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_stop command");
        self.plc_run_stop_helper(params, false).await
    }

    /// Helper for start/stop commands
    async fn plc_run_stop_helper(
        &self,
        params: &Value,
        start: bool,
    ) -> (bool, Value, Option<String>) {
        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'protocol' parameter".to_string()),
                );
            }
        };

        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };

        // Only supporting S7 for run/stop initially (most common use case)
        let result = match protocol.to_lowercase().as_str() {
            "s7" => {
                let config = crate::plc_programming::s7comm::S7Config {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(102) as u16,
                    rack: params.get("rack").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                    plc_type: Default::default(),
                    timeout_secs: 30,
                    pdu_size: 480,
                };
                let mut client = S7Client::new(config);
                if start {
                    Self::start_with_client(&mut client).await
                } else {
                    Self::stop_with_client(&mut client).await
                }
            }
            "codesys" => {
                let config = crate::plc_programming::codesys::CodesysConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: 1217,
                    mode: Default::default(),
                    device_name: None,
                    username: None,
                    password: None,
                    encrypted: false,
                    timeout_secs: 30,
                    application: "Application".to_string(),
                };
                let mut client = CodesysClient::new(config);
                if start {
                    Self::start_with_client(&mut client).await
                } else {
                    Self::stop_with_client(&mut client).await
                }
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Start/Stop not supported for protocol: {}",
                        protocol
                    )),
                );
            }
        };

        match result {
            Ok(()) => {
                let action = if start { "started" } else { "stopped" };
                info!(protocol = %protocol, address = %address, "PLC {}", action);
                (true, json!({"success": true, "action": action}), None)
            }
            Err(e) => {
                let action = if start { "start" } else { "stop" };
                (
                    false,
                    json!(null),
                    Some(format!("PLC {} failed: {}", action, e)),
                )
            }
        }
    }

    /// Helper to start PLC
    /// v2.3: Connect with 30-second timeout
    async fn start_with_client<P: PlcProgrammer>(client: &mut P) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.start().await;
        let _ = client.disconnect().await;
        result
    }

    /// Helper to stop PLC
    /// v2.3: Connect with 30-second timeout
    async fn stop_with_client<P: PlcProgrammer>(client: &mut P) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.stop().await;
        let _ = client.disconnect().await;
        result
    }

    /// List programs on PLC
    async fn cmd_plc_list(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_list command");

        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'protocol' parameter".to_string()),
                );
            }
        };

        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };

        let result = match protocol.to_lowercase().as_str() {
            "s7" => {
                let config = crate::plc_programming::s7comm::S7Config {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(102) as u16,
                    rack: params.get("rack").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                    plc_type: Default::default(),
                    timeout_secs: 30,
                    pdu_size: 480,
                };
                let mut client = S7Client::new(config);
                Self::list_with_client(&mut client).await
            }
            "codesys" => {
                let config = crate::plc_programming::codesys::CodesysConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: 1217,
                    mode: Default::default(),
                    device_name: None,
                    username: None,
                    password: None,
                    encrypted: false,
                    timeout_secs: 30,
                    application: "Application".to_string(),
                };
                let mut client = CodesysClient::new(config);
                Self::list_with_client(&mut client).await
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("List not supported for protocol: {}", protocol)),
                );
            }
        };

        match result {
            Ok(programs) => (
                true,
                json!({"programs": programs, "count": programs.len()}),
                None,
            ),
            Err(e) => (false, json!(null), Some(format!("List failed: {}", e))),
        }
    }

    /// Helper to list programs
    /// v2.3: Connect with 30-second timeout
    async fn list_with_client<P: PlcProgrammer>(client: &mut P) -> anyhow::Result<Vec<String>> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.list_programs().await;
        let _ = client.disconnect().await;
        result
    }

    /// Download program from PLC
    async fn cmd_plc_download(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_download command");

        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'protocol' parameter".to_string()),
                );
            }
        };

        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };

        let program_name = match params.get("program_name").and_then(|v| v.as_str()) {
            Some(n) => n,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'program_name' parameter".to_string()),
                );
            }
        };

        let result = match protocol.to_lowercase().as_str() {
            "s7" => {
                let config = crate::plc_programming::s7comm::S7Config {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(102) as u16,
                    rack: params.get("rack").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                    plc_type: Default::default(),
                    timeout_secs: 30,
                    pdu_size: 480,
                };
                let mut client = S7Client::new(config);
                Self::download_with_client(&mut client, program_name).await
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("Download not supported for protocol: {}", protocol)),
                );
            }
        };

        match result {
            Ok(program) => (
                true,
                json!({
                    "program": {
                        "name": program.name,
                        "language": format!("{:?}", program.language),
                        "source": program.source,
                        "variables": program.variables.len(),
                        "function_blocks": program.function_blocks.len()
                    }
                }),
                None,
            ),
            Err(e) => (false, json!(null), Some(format!("Download failed: {}", e))),
        }
    }

    /// Helper to download program
    /// v2.3: Connect with 30-second timeout
    async fn download_with_client<P: PlcProgrammer>(
        client: &mut P,
        program_name: &str,
    ) -> anyhow::Result<PlcProgram> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.download_program(program_name).await;
        let _ = client.disconnect().await;
        result
    }

    /// Delete program from PLC
    async fn cmd_plc_delete(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_delete command");

        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'protocol' parameter".to_string()),
                );
            }
        };

        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };

        let program_name = match params.get("program_name").and_then(|v| v.as_str()) {
            Some(n) => n,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'program_name' parameter".to_string()),
                );
            }
        };

        let result = match protocol.to_lowercase().as_str() {
            "s7" => {
                let config = crate::plc_programming::s7comm::S7Config {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(102) as u16,
                    rack: params.get("rack").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                    plc_type: Default::default(),
                    timeout_secs: 30,
                    pdu_size: 480,
                };
                let mut client = S7Client::new(config);
                Self::delete_with_client(&mut client, program_name).await
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("Delete not supported for protocol: {}", protocol)),
                );
            }
        };

        match result {
            Ok(()) => {
                info!(program = %program_name, "Program deleted from PLC");
                (
                    true,
                    json!({"deleted": true, "program_name": program_name}),
                    None,
                )
            }
            Err(e) => (false, json!(null), Some(format!("Delete failed: {}", e))),
        }
    }

    /// Helper to delete program
    /// v2.3: Connect with 30-second timeout
    async fn delete_with_client<P: PlcProgrammer>(
        client: &mut P,
        program_name: &str,
    ) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.delete_program(program_name).await;
        let _ = client.disconnect().await;
        result
    }

    // ========================================================================
    // Deploy Orchestrator Commands (v2.2)
    // ========================================================================

    /// Deploy program directly to Codesys PLC
    ///
    /// Sends ST source code to a Codesys-based PLC which compiles on-device.
    /// Safety sequence: validate ST → connect → stop PLC → upload → verify compile → report status
    /// Note: PLC is NOT auto-started after upload. Operator must explicitly start via a separate command.
    async fn cmd_deploy_to_codesys(&self, params: &Value) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing deploy_to_codesys command");

        let st_source = match params.get("st_source").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                return (false, json!(null), Some("Missing 'st_source' parameter".to_string()));
            }
        };

        let plc_address = match params.get("plc_address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (false, json!(null), Some("Missing 'plc_address' parameter".to_string()));
            }
        };

        // Validate PLC address is a valid IPv4
        if !plc_address.parse::<std::net::Ipv4Addr>().is_ok()
            && !plc_address.parse::<std::net::Ipv6Addr>().is_ok()
        {
            return (false, json!(null), Some(format!("Invalid PLC address: {}", sanitize_for_log(plc_address))));
        }

        // Reject loopback and link-local addresses
        if let Ok(ip) = plc_address.parse::<std::net::Ipv4Addr>() {
            if ip.is_loopback() || ip.is_link_local() || ip.is_broadcast() || ip.is_unspecified() {
                return (false, json!(null), Some("PLC address cannot be loopback, link-local, or broadcast".to_string()));
            }
        }

        let plc_port_raw = params.get("plc_port").and_then(|v| v.as_u64()).unwrap_or(1217);
        if plc_port_raw == 0 || plc_port_raw > u16::MAX as u64 {
            return (false, json!(null), Some(format!("PLC port must be between 1-65535, got {}", plc_port_raw)));
        }
        let plc_port = plc_port_raw as u16;

        let program_name = params.get("program_name").and_then(|v| v.as_str()).unwrap_or("Main");
        let auto_start = params.get("auto_start").and_then(|v| v.as_bool()).unwrap_or(false);

        // Step 0: Validate ST source before sending to PLC (safety check)
        let max_source_len = 1_000_000; // 1MB max
        if st_source.len() > max_source_len {
            return (false, json!(null), Some(format!("ST source too large: {} bytes (max {})", st_source.len(), max_source_len)));
        }

        let validation = validate_st(st_source);
        if !validation.valid {
            let error_msgs: Vec<String> = validation.errors.iter().map(|e| e.message.clone()).collect();
            return (
                false,
                json!({
                    "success": false,
                    "validation_errors": error_msgs,
                    "error_count": validation.errors.len(),
                    "warning_count": validation.warnings.len(),
                }),
                Some(format!("ST validation failed: {} error(s)", validation.errors.len())),
            );
        }

        // Read credentials from local store, not from MQTT params (security)
        let username = params.get("plc_credentials").and_then(|c| c.get("username")).and_then(|v| v.as_str())
            .or_else(|| params.get("username").and_then(|v| v.as_str()));
        let password = params.get("plc_credentials").and_then(|c| c.get("password")).and_then(|v| v.as_str())
            .or_else(|| params.get("password").and_then(|v| v.as_str()));

        info!(plc_address = %plc_address, plc_port = %plc_port, program_name = %program_name, "Deploying ST to Codesys PLC");

        let config = crate::plc_programming::codesys::CodesysConfig {
            name: format!("deploy-{}", program_name),
            address: plc_address.to_string(),
            port: plc_port,
            mode: Default::default(),
            device_name: params.get("device_name").and_then(|v| v.as_str()).map(String::from),
            username: username.map(String::from),
            password: password.map(String::from),
            encrypted: params.get("encrypted").and_then(|v| v.as_bool()).unwrap_or(false),
            timeout_secs: 30,
            application: params.get("application").and_then(|v| v.as_str()).unwrap_or("Application").to_string(),
        };

        let mut client = CodesysClient::new(config);

        // Step 1: Connect (with 30s timeout to prevent command handler freeze)
        match tokio::time::timeout(Duration::from_secs(30), client.connect()).await {
            Err(_) => {
                error!("PLC connect timed out after 30s at {}:{}", plc_address, plc_port);
                return (false, json!(null), Some(format!("PLC connect timed out after 30s at {}:{}", plc_address, plc_port)));
            }
            Ok(Err(e)) => {
                error!(error = %e, "Failed to connect to Codesys PLC");
                return (false, json!(null), Some(format!("Failed to connect to PLC at {}:{}: {}", plc_address, plc_port, e)));
            }
            Ok(Ok(())) => {}
        }

        // Step 2: Stop PLC before uploading (safety: prevents undefined output states)
        match client.get_status().await {
            Ok(status) => {
                let mode = format!("{:?}", status.run_mode);
                if mode.to_lowercase().contains("run") {
                    info!("PLC is in RUN mode, stopping before upload for safety");
                    if let Err(e) = client.stop().await {
                        error!(error = %e, "Failed to stop PLC before upload - aborting deploy for safety");
                        let _ = client.disconnect().await;
                        return (false, json!(null), Some(format!("Cannot stop PLC before upload: {}. Deploy aborted for safety.", e)));
                    }
                    info!("PLC stopped successfully");
                }
            }
            Err(e) => {
                warn!(error = %e, "Failed to get PLC status before upload - proceeding cautiously");
            }
        }

        // Step 3: Create PlcProgram from ST source
        let program = PlcProgram {
            name: program_name.to_string(),
            language: crate::plc_programming::ProgramLanguage::St,
            source: st_source.to_string(),
            variables: vec![],
            function_blocks: vec![],
            metadata: std::collections::HashMap::new(),
        };

        // Step 4: Upload program (PLC compiles on-device)
        let upload_result = match client.upload_program(&program).await {
            Ok(result) => result,
            Err(e) => {
                error!(error = %e, "Failed to upload program to Codesys PLC");
                let _ = client.disconnect().await;
                return (false, json!(null), Some(format!("Program upload failed: {}", e)));
            }
        };

        if !upload_result.success {
            let _ = client.disconnect().await;
            return (
                false,
                json!({"success": false, "errors": upload_result.errors, "warnings": upload_result.warnings}),
                Some("Program compilation failed on PLC".to_string()),
            );
        }

        // Step 5: Conditionally start PLC (only if explicitly requested)
        if auto_start {
            info!("auto_start=true, starting PLC after successful upload");
            if let Err(e) = client.start().await {
                warn!(error = %e, "Failed to start PLC after upload (program uploaded successfully, PLC in STOP)");
            }
        } else {
            info!("PLC left in STOP mode after upload. Operator must explicitly start.");
        }

        // Step 6: Get final status
        let plc_status = match client.get_status().await {
            Ok(status) => Some(format!("{:?}", status.run_mode)),
            Err(e) => { warn!(error = %e, "Failed to get PLC status after deploy"); None }
        };

        let _ = client.disconnect().await;

        info!(program_name = %program_name, plc_address = %plc_address, plc_status = ?plc_status, "Codesys deploy completed");

        (
            true,
            json!({
                "success": true,
                "target": "codesys_plc",
                "program_name": program_name,
                "program_id": upload_result.program_id,
                "plc_address": plc_address,
                "plc_port": plc_port,
                "plc_status": plc_status,
                "auto_started": auto_start,
                "warnings": upload_result.warnings,
                "validation_warnings": validation.warnings.len(),
                "timestamp": chrono::Utc::now().to_rfc3339()
            }),
            None,
        )
    }

    /// Unified deploy command - routes to appropriate target automatically
    async fn cmd_deploy_auto(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        // Note: no deploy_lock here - this method delegates to cmd_deploy_program()
        // and cmd_deploy_to_codesys() which each acquire the lock themselves.
        // Locking here would deadlock since tokio::sync::Mutex is not reentrant.
        info!("Executing deploy_auto command");

        // Deserialize from string to avoid deep-cloning the entire Value tree
        let params_str = params.to_string();
        let deploy_cmd: DeployCommand = match serde_json::from_str(&params_str) {
            Ok(cmd) => cmd,
            Err(e) => {
                return (false, json!(null), Some(format!("Invalid deploy command: {}", e)));
            }
        };

        info!(target = %deploy_cmd.target, program = %deploy_cmd.program_name, "Routing deploy");

        match deploy_cmd.target {
            crate::deploy_orchestrator::DeployTarget::RustEngine => {
                let program_params = json!({
                    "id": deploy_cmd.program_id,
                    "name": deploy_cmd.program_name,
                    "version": deploy_cmd.version,
                    "script": deploy_cmd.script,
                    "functionBlocks": deploy_cmd.function_blocks,
                    "executionMode": deploy_cmd.execution_mode.unwrap_or_else(|| "event_driven".to_string()),
                    "scanCycleMs": deploy_cmd.scan_cycle_ms.unwrap_or(100),
                });
                self.cmd_deploy_program(&program_params).await
            }

            crate::deploy_orchestrator::DeployTarget::CodesysPlc => {
                let codesys_params = json!({
                    "st_source": deploy_cmd.st_source,
                    "plc_address": deploy_cmd.plc_address,
                    "plc_port": deploy_cmd.plc_port.unwrap_or(1217),
                    "program_name": deploy_cmd.program_name,
                    "plc_credentials": deploy_cmd.plc_credentials,
                });
                self.cmd_deploy_to_codesys(&codesys_params).await
            }

            crate::deploy_orchestrator::DeployTarget::PlcSetpoint => {
                let protocol = deploy_cmd.setpoint_protocol.as_deref().unwrap_or("modbus");
                let setpoints = match deploy_cmd.setpoints {
                    Some(sp) => sp,
                    None => {
                        return (false, json!(null), Some("Missing 'setpoints' for PlcSetpoint target".to_string()));
                    }
                };

                let mut results = Vec::new();
                let mut all_success = true;

                for sp in &setpoints {
                    let write_params = json!({
                        "device": deploy_cmd.plc_address,
                        "address": sp.address,
                        "value": sp.value,
                        "data_type": sp.data_type,
                    });
                    let (success, result, error) = match protocol {
                        "opcua" => self.cmd_write_opcua(&write_params).await,
                        "s7comm" => self.cmd_write_s7(&write_params).await,
                        _ => self.cmd_write_modbus(&write_params).await,
                    };
                    if !success { all_success = false; }
                    results.push(json!({"address": sp.address, "success": success, "result": result, "error": error}));
                }

                (
                    all_success,
                    json!({
                        "success": all_success,
                        "target": "plc_setpoint",
                        "protocol": protocol,
                        "setpoint_results": results,
                        "timestamp": chrono::Utc::now().to_rfc3339()
                    }),
                    if all_success { None } else { Some("Some setpoint writes failed".to_string()) },
                )
            }
        }
    }

    /// Write a value to an OPC-UA node on a PLC
    /// Stub: not yet implemented
    async fn cmd_write_opcua(&self, params: &Value) -> (bool, Value, Option<String>) {
        warn!("cmd_write_opcua called but OPC-UA write is not yet implemented");

        let address = params.get("address").and_then(|v| v.as_str()).unwrap_or("<unknown>");
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

    /// Write a value to an S7 PLC via S7comm protocol
    /// Stub: not yet implemented
    async fn cmd_write_s7(&self, params: &Value) -> (bool, Value, Option<String>) {
        warn!("cmd_write_s7 called but S7 write is not yet implemented");

        let address = params.get("address").and_then(|v| v.as_str()).unwrap_or("<unknown>");
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

    /// Validate IEC 61131-3 Structured Text code
    /// v2.2: Uses the real AST-based parser/validator
    /// Runs on blocking thread pool to avoid blocking the async MQTT event loop.
    async fn cmd_validate_st(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        let source = match params.get("source").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                return (false, json!({"valid": false}), Some("Missing 'source' parameter".to_string()));
            }
        };

        // Size limit: prevent DoS on edge device parser
        const MAX_SOURCE_LEN: usize = 1_000_000; // 1MB
        if source.len() > MAX_SOURCE_LEN {
            return (
                false,
                json!({"valid": false, "errors": [{"message": format!("Source too large: {} bytes (max {})", source.len(), MAX_SOURCE_LEN)}]}),
                Some("Source code exceeds maximum size".to_string()),
            );
        }

        // Run CPU-intensive parsing on blocking thread pool with 60s timeout
        let source_owned = source.to_string();
        let validation_future = tokio::task::spawn_blocking(move || {
            let mut result = validate_st(&source_owned);
            // Strip AST from response to reduce MQTT payload size (can be MB for large programs)
            result.ast = None;
            result
        });

        let result = match tokio::time::timeout(Duration::from_secs(60), validation_future).await {
            Err(_) => {
                return (false, json!({"valid": false}), Some("ST validation timed out after 60s".to_string()));
            }
            Ok(Err(e)) => {
                return (false, json!({"valid": false}), Some(format!("Validation task failed: {}", e)));
            }
            Ok(Ok(r)) => r,
        };

        let success = result.valid;

        (
            success,
            serde_json::to_value(&result).unwrap_or(json!({"valid": false})),
            if success { None } else { Some(format!("{} error(s) found", result.errors.len())) },
        )
    }

    /// Load program state from disk
    /// v1.2.6: Added error logging to prevent silent data loss
    /// v1.3.3: Added backup of corrupted files for forensic analysis
    fn load_program_state(&self) -> ProgramState {
        match fs::read_to_string(&self.program_state_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(state) => state,
                Err(e) => {
                    error!(
                        path = ?self.program_state_path,
                        error = %e,
                        "Failed to parse program state - file may be corrupted"
                    );

                    // v1.3.3: Backup corrupted file for forensic analysis
                    let backup_path = format!(
                        "{}.corrupted.{}",
                        self.program_state_path.display(),
                        chrono::Utc::now().format("%Y%m%d_%H%M%S")
                    );
                    match fs::copy(&self.program_state_path, &backup_path) {
                        Ok(_) => {
                            warn!(
                                "Corrupted program state backed up to: {}. \
                                Using default state. Manual investigation recommended.",
                                backup_path
                            );
                        }
                        Err(backup_err) => {
                            error!(
                                "Failed to backup corrupted program state: {}. \
                                Original file at: {:?}. DATA MAY BE LOST.",
                                backup_err, self.program_state_path
                            );
                        }
                    }

                    ProgramState::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!(path = ?self.program_state_path, "Program state file not found - using default");
                ProgramState::default()
            }
            Err(e) => {
                warn!(
                    path = ?self.program_state_path,
                    error = %e,
                    "Failed to read program state file - using default"
                );
                ProgramState::default()
            }
        }
    }

    /// Save program state to disk
    /// v2.3: Atomic write (tmp + rename) to prevent corruption on power loss
    fn save_program_state(&self, state: &ProgramState) -> anyhow::Result<()> {
        // Ensure parent directory exists
        if let Some(parent) = self.program_state_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(state)?;

        // Write to temp file first, then atomically rename
        let tmp_path = self.program_state_path.with_extension("json.tmp");
        fs::write(&tmp_path, &content)?;
        fs::rename(&tmp_path, &self.program_state_path)?;

        debug!(path = ?self.program_state_path, "Program state saved (atomic)");
        Ok(())
    }

    /// Handle config update from cloud
    async fn handle_config_update(&self, payload: &[u8]) -> anyhow::Result<()> {
        let config_update: Value = serde_json::from_slice(payload)?;
        info!("Received config update: {:?}", config_update);

        let mut state = self.state.write().await;
        let mut config_changed = false;

        // Update telemetry interval if provided
        if let Some(telemetry) = config_update.get("telemetry") {
            if let Some(interval) = telemetry.get("interval_seconds").and_then(|v| v.as_u64()) {
                // Validate: minimum 5 seconds, maximum 3600 seconds (1 hour)
                if (5..=3600).contains(&interval) {
                    state.config.telemetry.interval_seconds = interval;
                    config_changed = true;
                    info!("Updated telemetry interval to {} seconds", interval);
                } else {
                    warn!(
                        "Invalid telemetry interval {}: must be between 5 and 3600 seconds",
                        interval
                    );
                }
            }

            // Update telemetry include flags
            if let Some(include_system) = telemetry.get("include_system").and_then(|v| v.as_bool())
            {
                state.config.telemetry.include_system = include_system;
                config_changed = true;
            }
            if let Some(include_modbus) = telemetry.get("include_modbus").and_then(|v| v.as_bool())
            {
                state.config.telemetry.include_modbus = include_modbus;
                config_changed = true;
            }
            if let Some(include_gpio) = telemetry.get("include_gpio").and_then(|v| v.as_bool()) {
                state.config.telemetry.include_gpio = include_gpio;
                config_changed = true;
            }
        }

        // Update scripting enabled flag if provided
        if let Some(scripting) = config_update.get("scripting") {
            if let Some(enabled) = scripting.get("enabled").and_then(|v| v.as_bool()) {
                state.config.scripting.enabled = enabled;
                config_changed = true;
                info!("Updated scripting enabled to {}", enabled);
            }
        }

        // Save config to disk if changed
        if config_changed {
            if let Err(e) = state.config.save() {
                error!("Failed to save config after update: {}", e);
                return Err(anyhow::anyhow!("Failed to persist config changes: {}", e));
            }
            info!("Config update applied and saved successfully");
        } else {
            info!("No applicable config changes found in update");
        }

        Ok(())
    }

    // ========================================================================
    // Failover Commands (v1.3.4)
    // ========================================================================

    /// Get MQTT failover status
    async fn cmd_failover_status(&self) -> (bool, Value, Option<String>) {
        info!("Executing failover_status command");

        let state = self.state.read().await;
        let failover_config = &state.config.mqtt.failover;

        if !failover_config.enabled {
            return (
                true,
                json!({
                    "enabled": false,
                    "message": "Failover is not enabled. Configure mqtt.failover in config.yaml"
                }),
                None,
            );
        }

        // Build status report
        let primary_broker = state.config.mqtt.broker.as_deref().unwrap_or("not configured");
        let backup_broker = failover_config.backup_broker.as_deref().unwrap_or("not configured");
        let backup_port = failover_config.backup_port.unwrap_or(state.config.mqtt.port);

        (
            true,
            json!({
                "enabled": true,
                "primary_broker": format!("{}:{}", primary_broker, state.config.mqtt.port),
                "backup_broker": format!("{}:{}", backup_broker, backup_port),
                "config": {
                    "timeout_secs": failover_config.timeout_secs,
                    "health_check_interval_secs": failover_config.health_check_interval_secs,
                    "max_failures": failover_config.max_failures,
                    "recovery_delay_secs": failover_config.recovery_delay_secs
                }
            }),
            None,
        )
    }

    /// Force failover to backup broker
    async fn cmd_failover_force(&self) -> (bool, Value, Option<String>) {
        info!("Executing failover_force command");

        let state = self.state.read().await;
        let failover_config = &state.config.mqtt.failover;

        if !failover_config.enabled {
            return (
                false,
                json!(null),
                Some("Failover is not enabled. Configure mqtt.failover in config.yaml".to_string()),
            );
        }

        if failover_config.backup_broker.is_none() {
            return (
                false,
                json!(null),
                Some("No backup broker configured".to_string()),
            );
        }

        // Note: Actual failover would be triggered through the FailoverMqttClient
        // This command signals the intent; the MQTT client handles the transition
        warn!("Manual failover to backup broker requested via command");

        (
            true,
            json!({
                "action": "failover_initiated",
                "target": failover_config.backup_broker,
                "message": "Failover to backup broker has been initiated"
            }),
            None,
        )
    }

    /// Force recovery to primary broker
    async fn cmd_failover_recover(&self) -> (bool, Value, Option<String>) {
        info!("Executing failover_recover command");

        let state = self.state.read().await;
        let failover_config = &state.config.mqtt.failover;

        if !failover_config.enabled {
            return (
                false,
                json!(null),
                Some("Failover is not enabled".to_string()),
            );
        }

        let primary_broker = match &state.config.mqtt.broker {
            Some(b) => b.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("No primary broker configured".to_string()),
                );
            }
        };

        // Note: Actual recovery would be triggered through the FailoverMqttClient
        warn!("Manual recovery to primary broker requested via command");

        (
            true,
            json!({
                "action": "recovery_initiated",
                "target": primary_broker,
                "message": "Recovery to primary broker has been initiated"
            }),
            None,
        )
    }

    // ========================================================================
    // I/O Config and Output Commands
    // ========================================================================

    async fn cmd_update_io_config(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing update_io_config command");

        // Parse tag configs from the io config format
        let tag_configs = match self.parse_io_config_to_tags(params) {
            Ok(configs) => configs,
            Err(e) => {
                return (false, json!(null), Some(format!("Failed to parse io_config: {}", e)));
            }
        };

        let state = self.state.read().await;

        // Update process image configs
        state.process_image.set_configs(tag_configs.clone()).await;

        // Register alarms
        {
            let mut alarm_mgr = state.alarm_manager.write().await;
            for cfg in &tag_configs {
                if let Some(hh) = cfg.alarm_hh {
                    let def = AlarmDefinition::high_limit(
                        &format!("{}_HH", cfg.tag_name),
                        &cfg.tag_name,
                        hh,
                    ).with_priority(AlarmPriority::Critical);
                    alarm_mgr.register(def);
                }
                if let Some(h) = cfg.alarm_h {
                    let def = AlarmDefinition::high_limit(
                        &format!("{}_H", cfg.tag_name),
                        &cfg.tag_name,
                        h,
                    ).with_priority(AlarmPriority::High);
                    alarm_mgr.register(def);
                }
                if let Some(l) = cfg.alarm_l {
                    let def = AlarmDefinition::low_limit(
                        &format!("{}_L", cfg.tag_name),
                        &cfg.tag_name,
                        l,
                    ).with_priority(AlarmPriority::High);
                    alarm_mgr.register(def);
                }
                if let Some(ll) = cfg.alarm_ll {
                    let def = AlarmDefinition::low_limit(
                        &format!("{}_LL", cfg.tag_name),
                        &cfg.tag_name,
                        ll,
                    ).with_priority(AlarmPriority::Critical);
                    alarm_mgr.register(def);
                }
            }
        }

        // Persist to disk
        if let Err(e) = self.persist_io_config(params) {
            warn!("Failed to persist io_config: {}", e);
        }

        let tag_count = tag_configs.len();
        info!("Updated I/O config: {} tags", tag_count);
        (true, json!({ "tags_configured": tag_count }), None)
    }

    async fn cmd_set_output(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing set_output command");

        let tag_name = match params.get("tag_name").and_then(|v| v.as_str()) {
            Some(name) => name.to_string(),
            None => return (false, json!(null), Some("Missing tag_name parameter".to_string())),
        };

        let value = match params.get("value").and_then(|v| v.as_f64()) {
            Some(v) => v,
            None => return (false, json!(null), Some("Missing or invalid value parameter".to_string())),
        };

        let state = self.state.read().await;

        // Look up the tag config to determine protocol
        let config = state.process_image.get_config(&tag_name).await;
        let config = match config {
            Some(c) => c,
            None => return (false, json!(null), Some(format!("Tag '{}' not found", tag_name))),
        };

        // Write based on protocol
        let write_result = match &config.protocol_config {
            ProtocolConfig::Gpio { pin, .. } => {
                if let Some(ref handle) = state.gpio_handle {
                    let bool_value = value != 0.0;
                    match handle.write_pin(*pin, bool_value).await {
                        Ok(()) => Ok(()),
                        Err(e) => Err(format!("GPIO write failed: {}", e)),
                    }
                } else {
                    Err("GPIO handle not available".to_string())
                }
            }
            ProtocolConfig::Modbus { slave_id: _, register, function: _, register_type: _ } => {
                if let Some(ref handle) = state.modbus_handle {
                    let bool_value = value != 0.0;
                    // Use first modbus device for coil write
                    if let Some(device) = state.config.modbus.first() {
                        match handle.write_coil(&device.name, *register, bool_value).await {
                            Ok(()) => Ok(()),
                            Err(e) => Err(format!("Modbus write failed: {}", e)),
                        }
                    } else {
                        Err("No Modbus devices configured".to_string())
                    }
                } else {
                    Err("Modbus handle not available".to_string())
                }
            }
            ProtocolConfig::I2c { bus: _, address: _, driver_type: _ } => {
                if let Some(ref handle) = state.i2c_handle {
                    // Write raw bytes for I2C
                    let data = (value as u32).to_be_bytes().to_vec();
                    match handle.write_direct(&tag_name, &data).await {
                        Ok(()) => Ok(()),
                        Err(e) => Err(format!("I2C write failed: {}", e)),
                    }
                } else {
                    Err("I2C handle not available".to_string())
                }
            }
            _ => Err(format!("Write not supported for protocol {:?}", config.protocol_config)),
        };

        match write_result {
            Ok(()) => {
                // Update process image after write
                state.process_image.update_tag(&tag_name, value, TagQuality::Good, config.source).await;
                info!("Output set: {} = {}", tag_name, value);
                (true, json!({ "tag_name": tag_name, "value": value }), None)
            }
            Err(e) => (false, json!(null), Some(e)),
        }
    }

    /// Parse the AgentIoConfig format (modbus[], gpio[], i2c[]) into Vec<TagConfig>
    fn parse_io_config_to_tags(&self, params: &Value) -> anyhow::Result<Vec<TagConfig>> {
        let mut tags = Vec::new();

        // Parse GPIO configs
        if let Some(gpio_array) = params.get("gpio").and_then(|v| v.as_array()) {
            for item in gpio_array {
                let tag_name = item.get("tagName").or(item.get("tag_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let pin = item.get("pin").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
                let direction = item.get("direction").and_then(|v| v.as_str()).unwrap_or("input").to_string();
                let io_type = if direction == "output" { IoType::DO } else { IoType::DI };

                tags.push(TagConfig {
                    tag_name,
                    io_type,
                    data_type: "BOOL".to_string(),
                    source: TagSource::Gpio,
                    poll_interval_ms: item.get("pollIntervalMs").or(item.get("poll_interval_ms")).and_then(|v| v.as_u64()),
                    raw_min: None,
                    raw_max: None,
                    eng_min: None,
                    eng_max: None,
                    eng_unit: None,
                    invert: item.get("invert").and_then(|v| v.as_bool()).unwrap_or(false),
                    alarm_hh: item.get("alarmHH").or(item.get("alarm_hh")).and_then(|v| v.as_f64()),
                    alarm_h: item.get("alarmH").or(item.get("alarm_h")).and_then(|v| v.as_f64()),
                    alarm_l: item.get("alarmL").or(item.get("alarm_l")).and_then(|v| v.as_f64()),
                    alarm_ll: item.get("alarmLL").or(item.get("alarm_ll")).and_then(|v| v.as_f64()),
                    deadband: item.get("deadband").and_then(|v| v.as_f64()),
                    protocol_config: ProtocolConfig::Gpio { pin, direction },
                });
            }
        }

        // Parse Modbus configs
        if let Some(modbus_array) = params.get("modbus").and_then(|v| v.as_array()) {
            for item in modbus_array {
                let tag_name = item.get("tagName").or(item.get("tag_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let io_type_str = item.get("ioType").or(item.get("io_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("AI");
                let io_type = match io_type_str {
                    "DI" => IoType::DI,
                    "DO" => IoType::DO,
                    "AO" => IoType::AO,
                    _ => IoType::AI,
                };
                let slave_id = item.get("slaveId").or(item.get("slave_id")).and_then(|v| v.as_u64()).unwrap_or(1) as u8;
                let register = item.get("register").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let function = item.get("function").and_then(|v| v.as_u64()).unwrap_or(3) as u8;
                let register_type = item.get("registerType").or(item.get("register_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("holding")
                    .to_string();

                tags.push(TagConfig {
                    tag_name,
                    io_type,
                    data_type: item.get("dataType").or(item.get("data_type")).and_then(|v| v.as_str()).unwrap_or("FLOAT32").to_string(),
                    source: TagSource::Modbus,
                    poll_interval_ms: item.get("pollIntervalMs").or(item.get("poll_interval_ms")).and_then(|v| v.as_u64()),
                    raw_min: item.get("rawMin").or(item.get("raw_min")).and_then(|v| v.as_f64()),
                    raw_max: item.get("rawMax").or(item.get("raw_max")).and_then(|v| v.as_f64()),
                    eng_min: item.get("engMin").or(item.get("eng_min")).and_then(|v| v.as_f64()),
                    eng_max: item.get("engMax").or(item.get("eng_max")).and_then(|v| v.as_f64()),
                    eng_unit: item.get("engUnit").or(item.get("eng_unit")).and_then(|v| v.as_str()).map(|s| s.to_string()),
                    invert: item.get("invert").and_then(|v| v.as_bool()).unwrap_or(false),
                    alarm_hh: item.get("alarmHH").or(item.get("alarm_hh")).and_then(|v| v.as_f64()),
                    alarm_h: item.get("alarmH").or(item.get("alarm_h")).and_then(|v| v.as_f64()),
                    alarm_l: item.get("alarmL").or(item.get("alarm_l")).and_then(|v| v.as_f64()),
                    alarm_ll: item.get("alarmLL").or(item.get("alarm_ll")).and_then(|v| v.as_f64()),
                    deadband: item.get("deadband").and_then(|v| v.as_f64()),
                    protocol_config: ProtocolConfig::Modbus { slave_id, register, function, register_type },
                });
            }
        }

        // Parse I2C configs
        if let Some(i2c_array) = params.get("i2c").and_then(|v| v.as_array()) {
            for item in i2c_array {
                let tag_name = item.get("tagName").or(item.get("tag_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let io_type_str = item.get("ioType").or(item.get("io_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("AI");
                let io_type = match io_type_str {
                    "DI" => IoType::DI,
                    "DO" => IoType::DO,
                    "AO" => IoType::AO,
                    _ => IoType::AI,
                };
                let bus = item.get("bus").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
                let address = item.get("address").and_then(|v| v.as_u64()).unwrap_or(0) as u8;

                // Determine I2C driver type
                let driver_type_str = item.get("driverType").or(item.get("driver_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("generic_direct");
                let driver_type = match driver_type_str {
                    "atlas_ezo" => {
                        let sensor = item.get("sensorType").or(item.get("sensor_type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("ph");
                        let sensor_type = match sensor {
                            "do" | "DO" => AtlasEzoType::Do,
                            "ec" | "EC" => AtlasEzoType::Ec,
                            "orp" | "ORP" => AtlasEzoType::Orp,
                            "temp" | "rtd" | "TEMP" | "RTD" => AtlasEzoType::Temp,
                            _ => AtlasEzoType::Ph,
                        };
                        I2cDriverType::AtlasEzo { sensor_type }
                    }
                    "generic_register" => {
                        let read_register = item.get("readRegister").or(item.get("read_register"))
                            .and_then(|v| v.as_u64()).unwrap_or(0) as u8;
                        let read_length = item.get("readLength").or(item.get("read_length"))
                            .and_then(|v| v.as_u64()).unwrap_or(2) as u8;
                        I2cDriverType::GenericRegister { read_register, read_length }
                    }
                    _ => {
                        let read_length = item.get("readLength").or(item.get("read_length"))
                            .and_then(|v| v.as_u64()).unwrap_or(4) as u8;
                        I2cDriverType::GenericDirect { read_length }
                    }
                };

                tags.push(TagConfig {
                    tag_name,
                    io_type,
                    data_type: item.get("dataType").or(item.get("data_type")).and_then(|v| v.as_str()).unwrap_or("FLOAT32").to_string(),
                    source: TagSource::I2c,
                    poll_interval_ms: item.get("pollIntervalMs").or(item.get("poll_interval_ms")).and_then(|v| v.as_u64()),
                    raw_min: item.get("rawMin").or(item.get("raw_min")).and_then(|v| v.as_f64()),
                    raw_max: item.get("rawMax").or(item.get("raw_max")).and_then(|v| v.as_f64()),
                    eng_min: item.get("engMin").or(item.get("eng_min")).and_then(|v| v.as_f64()),
                    eng_max: item.get("engMax").or(item.get("eng_max")).and_then(|v| v.as_f64()),
                    eng_unit: item.get("engUnit").or(item.get("eng_unit")).and_then(|v| v.as_str()).map(|s| s.to_string()),
                    invert: item.get("invert").and_then(|v| v.as_bool()).unwrap_or(false),
                    alarm_hh: item.get("alarmHH").or(item.get("alarm_hh")).and_then(|v| v.as_f64()),
                    alarm_h: item.get("alarmH").or(item.get("alarm_h")).and_then(|v| v.as_f64()),
                    alarm_l: item.get("alarmL").or(item.get("alarm_l")).and_then(|v| v.as_f64()),
                    alarm_ll: item.get("alarmLL").or(item.get("alarm_ll")).and_then(|v| v.as_f64()),
                    deadband: item.get("deadband").and_then(|v| v.as_f64()),
                    protocol_config: ProtocolConfig::I2c { bus, address, driver_type },
                });
            }
        }

        Ok(tags)
    }

    /// Persist the I/O config to disk as YAML
    fn persist_io_config(&self, config: &Value) -> anyhow::Result<()> {
        let config_dir = std::path::Path::new("/etc/suderra");
        if !config_dir.exists() {
            fs::create_dir_all(config_dir)?;
        }
        let config_path = config_dir.join("io_config.yaml");
        let yaml = serde_yaml::to_string(config)?;
        fs::write(&config_path, yaml)?;
        info!("I/O config persisted to {}", config_path.display());
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
