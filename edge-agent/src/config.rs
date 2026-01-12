//! Configuration management for Suderra Edge Agent
//!
//! Handles loading and saving of agent configuration from YAML files.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use anyhow::{Result, Context};
use tracing::info;

/// Default config file path
const DEFAULT_CONFIG_PATH: &str = "/etc/suderra/config.yaml";

/// Agent configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Unique device identifier (UUID)
    pub device_id: String,

    /// Human-readable device code (e.g., "RPI-A1B2C3D4")
    pub device_code: String,

    /// Provisioning token (cleared after activation)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisioning_token: Option<String>,

    /// Cloud API URL
    pub api_url: String,

    /// MQTT configuration
    pub mqtt: MqttConfig,

    /// Telemetry configuration
    #[serde(default)]
    pub telemetry: TelemetryConfig,

    /// Logging configuration
    #[serde(default)]
    pub logging: LoggingConfig,

    /// Tenant ID (set after activation)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,

    /// Modbus configuration
    #[serde(default)]
    pub modbus: Vec<ModbusDeviceConfig>,

    /// GPIO configuration
    #[serde(default)]
    pub gpio: Vec<GpioConfig>,
}

/// MQTT configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    /// MQTT broker hostname
    pub broker: Option<String>,

    /// MQTT broker port
    #[serde(default = "default_mqtt_port")]
    pub port: u16,

    /// MQTT username (set after activation)
    pub username: Option<String>,

    /// MQTT password (set after activation)
    pub password: Option<String>,

    /// Topic patterns (v1.1 - tenant-prefixed)
    #[serde(default)]
    pub topics: MqttTopics,

    /// Keep-alive interval in seconds
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u64,

    /// Clean session flag
    #[serde(default = "default_true")]
    pub clean_session: bool,
}

/// MQTT topic patterns
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttTopics {
    /// Status topic pattern
    #[serde(default = "default_status_topic")]
    pub status: String,

    /// Telemetry topic pattern
    #[serde(default = "default_telemetry_topic")]
    pub telemetry: String,

    /// Responses topic pattern
    #[serde(default = "default_responses_topic")]
    pub responses: String,

    /// Commands topic pattern (subscribe)
    #[serde(default = "default_commands_topic")]
    pub commands: String,

    /// Config topic pattern (subscribe)
    #[serde(default = "default_config_topic")]
    pub config: String,
}

impl Default for MqttTopics {
    fn default() -> Self {
        Self {
            status: default_status_topic(),
            telemetry: default_telemetry_topic(),
            responses: default_responses_topic(),
            commands: default_commands_topic(),
            config: default_config_topic(),
        }
    }
}

impl MqttTopics {
    /// Resolve topic pattern with actual tenant_id and device_id
    pub fn resolve(&self, tenant_id: &str, device_id: &str) -> ResolvedTopics {
        ResolvedTopics {
            status: self.status
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            telemetry: self.telemetry
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            responses: self.responses
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            commands: self.commands
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            config: self.config
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
        }
    }
}

/// Resolved MQTT topics with actual values
#[derive(Debug, Clone)]
pub struct ResolvedTopics {
    pub status: String,
    pub telemetry: String,
    pub responses: String,
    pub commands: String,
    pub config: String,
}

/// Telemetry configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryConfig {
    /// Telemetry interval in seconds
    #[serde(default = "default_telemetry_interval")]
    pub interval_seconds: u64,

    /// Include CPU metrics
    #[serde(default = "default_true")]
    pub include_cpu: bool,

    /// Include memory metrics
    #[serde(default = "default_true")]
    pub include_memory: bool,

    /// Include disk metrics
    #[serde(default = "default_true")]
    pub include_disk: bool,

    /// Include temperature metrics
    #[serde(default = "default_true")]
    pub include_temperature: bool,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            interval_seconds: default_telemetry_interval(),
            include_cpu: true,
            include_memory: true,
            include_disk: true,
            include_temperature: true,
        }
    }
}

/// Logging configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    /// Log level (trace, debug, info, warn, error)
    #[serde(default = "default_log_level")]
    pub level: String,

    /// Log file path
    #[serde(default = "default_log_file")]
    pub file: String,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            file: default_log_file(),
        }
    }
}

/// Modbus device configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusDeviceConfig {
    /// Device name/identifier
    pub name: String,

    /// Connection type: "tcp" or "rtu"
    pub connection_type: String,

    /// TCP: hostname:port, RTU: serial port path
    pub address: String,

    /// Modbus slave ID
    #[serde(default = "default_slave_id")]
    pub slave_id: u8,

    /// Baud rate (RTU only)
    pub baud_rate: Option<u32>,

    /// Registers to poll
    #[serde(default)]
    pub registers: Vec<ModbusRegisterConfig>,
}

/// Byte order for multi-register values
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ByteOrder {
    /// Big Endian (AB CD) - Most common for Modbus
    BigEndian,
    /// Little Endian (CD AB)
    LittleEndian,
    /// Big Endian byte swap (BA DC)
    BigEndianByteSwap,
    /// Little Endian byte swap (DC BA)
    LittleEndianByteSwap,
}

impl Default for ByteOrder {
    fn default() -> Self {
        ByteOrder::BigEndian
    }
}

/// Modbus register configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusRegisterConfig {
    /// Register name/tag
    pub name: String,

    /// Register address
    pub address: u16,

    /// Register type: "holding", "input", "coil", "discrete"
    pub register_type: String,

    /// Data type: "u16", "i16", "u32", "i32", "f32"
    #[serde(default = "default_data_type")]
    pub data_type: String,

    /// Byte order for multi-register values (u32, i32, f32)
    /// Options: big_endian, little_endian, big_endian_byte_swap, little_endian_byte_swap
    #[serde(default)]
    pub byte_order: ByteOrder,

    /// Scale factor
    #[serde(default = "default_scale")]
    pub scale: f64,

    /// Engineering unit
    pub unit: Option<String>,

    /// Poll interval in milliseconds (overrides device default)
    pub poll_interval_ms: Option<u64>,
}

/// GPIO pin configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioConfig {
    /// Pin name/tag
    pub name: String,

    /// GPIO pin number
    pub pin: u8,

    /// Direction: "input" or "output"
    pub direction: String,

    /// Pull-up/down: "up", "down", "none"
    #[serde(default = "default_pull")]
    pub pull: String,

    /// Invert value
    #[serde(default)]
    pub invert: bool,

    /// Debounce time in milliseconds (input only)
    pub debounce_ms: Option<u64>,
}

// Default value functions
fn default_mqtt_port() -> u16 { 1883 }
fn default_keepalive() -> u64 { 30 }
fn default_true() -> bool { true }
fn default_telemetry_interval() -> u64 { 30 }
fn default_log_level() -> String { "info".to_string() }
fn default_log_file() -> String { "/var/log/suderra-agent.log".to_string() }
fn default_slave_id() -> u8 { 1 }
fn default_data_type() -> String { "u16".to_string() }
fn default_scale() -> f64 { 1.0 }
fn default_pull() -> String { "none".to_string() }

// Default topic patterns (v1.1 spec)
fn default_status_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/status".to_string()
}
fn default_telemetry_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/telemetry".to_string()
}
fn default_responses_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/responses".to_string()
}
fn default_commands_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/commands".to_string()
}
fn default_config_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/config".to_string()
}

impl AgentConfig {
    /// Load configuration from file
    pub fn load() -> Result<Self> {
        Self::load_from(DEFAULT_CONFIG_PATH)
    }

    /// Load configuration from specified path
    pub fn load_from(path: &str) -> Result<Self> {
        let path = PathBuf::from(path);

        let content = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read config file: {}", path.display()))?;

        let config: AgentConfig = serde_yaml::from_str(&content)
            .with_context(|| format!("Failed to parse config file: {}", path.display()))?;

        Ok(config)
    }

    /// Save configuration to file
    pub fn save(&self) -> Result<()> {
        self.save_to(DEFAULT_CONFIG_PATH)
    }

    /// Save configuration to specified path
    pub fn save_to(&self, path: &str) -> Result<()> {
        let path = PathBuf::from(path);

        let content = serde_yaml::to_string(self)
            .context("Failed to serialize config")?;

        fs::write(&path, content)
            .with_context(|| format!("Failed to write config file: {}", path.display()))?;

        info!("Configuration saved to {}", path.display());
        Ok(())
    }

    /// Get resolved MQTT topics
    pub fn get_resolved_topics(&self) -> Option<ResolvedTopics> {
        let tenant_id = self.tenant_id.as_ref()?;
        Some(self.mqtt.topics.resolve(tenant_id, &self.device_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_topic_resolution() {
        let topics = MqttTopics::default();
        let resolved = topics.resolve("tenant-123", "device-456");

        assert_eq!(resolved.status, "tenants/tenant-123/devices/device-456/status");
        assert_eq!(resolved.telemetry, "tenants/tenant-123/devices/device-456/telemetry");
        assert_eq!(resolved.commands, "tenants/tenant-123/devices/device-456/commands");
    }
}
