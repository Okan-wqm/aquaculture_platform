//! I/O config + output-value command handlers (Batch 20i ARC-008
//! split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. This module handles
//! the `AgentIoConfig` schema (modbus[] / gpio[] / i2c[] arrays
//! with alarm thresholds + engineering-unit scaling) + generic
//! value-to-output dispatch across protocol boundaries. Extracting
//! from mod.rs surfaces the tag-lifecycle dependency graph:
//! ProcessImage.set_configs + AlarmManager.register + YAML
//! persistence + protocol-specific write fan-out.
//!
//! WHAT: `impl CommandHandler` block with 2 handlers + 2 private
//! helpers:
//! - `cmd_update_io_config` — deploy a new IO config.
//!   Parses params → `Vec<TagConfig>` → updates ProcessImage →
//!   registers HH/H/L/LL alarms per configured tag → persists to
//!   /etc/suderra/io_config.yaml (best-effort; warn on failure).
//! - `cmd_set_output` — write a single value to any configured
//!   output tag. Looks up the tag's protocol_config in the
//!   ProcessImage and dispatches to the appropriate handle
//!   (GPIO / Modbus / I2C); unsupported protocols return a
//!   specific error.
//! - `parse_io_config_to_tags` helper — converts the
//!   AgentIoConfig JSON schema to `Vec<TagConfig>`. Accepts both
//!   camelCase (tagName, ioType) and snake_case (tag_name,
//!   io_type) to support legacy + modern cloud payloads.
//! - `persist_io_config` helper — writes the raw params JSON to
//!   /etc/suderra/io_config.yaml as YAML; creates the directory
//!   if absent.
//!
//! WHY BEST-EFFORT PERSIST: `cmd_update_io_config` succeeds the
//! command even if `persist_io_config` fails (warn-log only).
//! Rationale: the in-memory ProcessImage update is the
//! authoritative state; a persist failure means the config won't
//! survive restart, but the current session still benefits. The
//! Sprint 6.x hardening target is fail-closed persist, gated by
//! an operator ack that they accept the non-persistent session.

use serde_json::{Value, json};
use std::fs;
use tracing::{info, warn};

use crate::alarms::{AlarmDefinition, AlarmPriority};
use crate::process_image::{
    AtlasEzoType, I2cDriverType, IoType, ProtocolConfig, TagConfig, TagQuality, TagSource,
};

use super::CommandHandler;

impl CommandHandler {
    /// Update the active I/O config (modbus + gpio + i2c arrays
    /// with alarm thresholds + engineering units). Registers
    /// HH/H/L/LL alarms as each tag's thresholds are declared.
    /// Persists to /etc/suderra/io_config.yaml (best-effort).
    pub(super) async fn cmd_update_io_config(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing update_io_config command");

        let tag_configs = match self.parse_io_config_to_tags(params) {
            Ok(configs) => configs,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!("Failed to parse io_config: {}", e)),
                );
            }
        };

        let state = self.state.read().await;

        state.process_image.set_configs(tag_configs.clone()).await;

        {
            let mut alarm_mgr = state.alarm_manager.write().await;
            for cfg in &tag_configs {
                if let Some(hh) = cfg.alarm_hh {
                    let def = AlarmDefinition::high_limit(
                        &format!("{}_HH", cfg.tag_name),
                        &cfg.tag_name,
                        hh,
                    )
                    .with_priority(AlarmPriority::Critical);
                    alarm_mgr.register(def);
                }
                if let Some(h) = cfg.alarm_h {
                    let def = AlarmDefinition::high_limit(
                        &format!("{}_H", cfg.tag_name),
                        &cfg.tag_name,
                        h,
                    )
                    .with_priority(AlarmPriority::High);
                    alarm_mgr.register(def);
                }
                if let Some(l) = cfg.alarm_l {
                    let def = AlarmDefinition::low_limit(
                        &format!("{}_L", cfg.tag_name),
                        &cfg.tag_name,
                        l,
                    )
                    .with_priority(AlarmPriority::High);
                    alarm_mgr.register(def);
                }
                if let Some(ll) = cfg.alarm_ll {
                    let def = AlarmDefinition::low_limit(
                        &format!("{}_LL", cfg.tag_name),
                        &cfg.tag_name,
                        ll,
                    )
                    .with_priority(AlarmPriority::Critical);
                    alarm_mgr.register(def);
                }
            }
        }

        if let Err(e) = self.persist_io_config(params) {
            warn!("Failed to persist io_config: {}", e);
        }

        let tag_count = tag_configs.len();
        info!("Updated I/O config: {} tags", tag_count);
        (true, json!({ "tags_configured": tag_count }), None)
    }

    /// Set a single output tag's value. Looks up the tag's
    /// protocol in the ProcessImage and dispatches to the
    /// appropriate handle (GPIO / Modbus / I2C). After a
    /// successful physical write, the ProcessImage is updated so
    /// subsequent reads see the commanded value with
    /// `TagQuality::Good`.
    pub(super) async fn cmd_set_output(&mut self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing set_output command");

        let tag_name = match params.get("tag_name").and_then(|v| v.as_str()) {
            Some(name) => name.to_string(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing tag_name parameter".to_string()),
                );
            }
        };

        let value = match params.get("value").and_then(|v| v.as_f64()) {
            Some(v) => v,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing or invalid value parameter".to_string()),
                );
            }
        };

        let state = self.state.read().await;

        let config = state.process_image.get_config(&tag_name).await;
        let config = match config {
            Some(c) => c,
            None => {
                return (
                    false,
                    json!(null),
                    Some(format!("Tag '{}' not found", tag_name)),
                );
            }
        };

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
            ProtocolConfig::Modbus {
                slave_id,
                register,
                function: _,
                register_type: _,
            } => {
                if let Some(ref handle) = state.modbus_handle {
                    let bool_value = value != 0.0;
                    if let Some(device) = state
                        .config
                        .modbus
                        .iter()
                        .find(|device| device.slave_id == *slave_id)
                    {
                        match handle.write_coil(&device.name, *register, bool_value).await {
                            Ok(()) => Ok(()),
                            Err(e) => Err(format!("Modbus write failed: {}", e)),
                        }
                    } else {
                        Err(format!(
                            "No Modbus device configured for slave_id {}",
                            slave_id
                        ))
                    }
                } else {
                    Err("Modbus handle not available".to_string())
                }
            }
            ProtocolConfig::I2c {
                bus: _,
                address: _,
                driver_type: _,
            } => {
                if let Some(ref handle) = state.i2c_handle {
                    let data = (value as u32).to_be_bytes().to_vec();
                    match handle.write_direct(&tag_name, &data).await {
                        Ok(()) => Ok(()),
                        Err(e) => Err(format!("I2C write failed: {}", e)),
                    }
                } else {
                    Err("I2C handle not available".to_string())
                }
            }
            _ => Err(format!(
                "Write not supported for protocol {:?}",
                config.protocol_config
            )),
        };

        match write_result {
            Ok(()) => {
                state
                    .process_image
                    .update_tag(&tag_name, value, TagQuality::Good, config.source)
                    .await;
                info!("Output set: {} = {}", tag_name, value);
                (true, json!({ "tag_name": tag_name, "value": value }), None)
            }
            Err(e) => (false, json!(null), Some(e)),
        }
    }

    /// Parse the AgentIoConfig format (modbus[], gpio[], i2c[])
    /// into `Vec<TagConfig>`. Accepts BOTH camelCase (tagName,
    /// ioType) and snake_case (tag_name, io_type) keys — legacy
    /// cloud payloads use snake_case; modern GraphQL mutation
    /// serializes to camelCase.
    fn parse_io_config_to_tags(&self, params: &Value) -> anyhow::Result<Vec<TagConfig>> {
        let mut tags = Vec::new();

        if let Some(gpio_array) = params.get("gpio").and_then(|v| v.as_array()) {
            for item in gpio_array {
                let tag_name = item
                    .get("tagName")
                    .or(item.get("tag_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let pin = item.get("pin").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
                let direction = item
                    .get("direction")
                    .and_then(|v| v.as_str())
                    .unwrap_or("input")
                    .to_string();
                let io_type = if direction == "output" {
                    IoType::DO
                } else {
                    IoType::DI
                };

                tags.push(TagConfig {
                    tag_name,
                    io_type,
                    data_type: "BOOL".to_string(),
                    source: TagSource::Gpio,
                    poll_interval_ms: item
                        .get("pollIntervalMs")
                        .or(item.get("poll_interval_ms"))
                        .and_then(|v| v.as_u64()),
                    raw_min: None,
                    raw_max: None,
                    eng_min: None,
                    eng_max: None,
                    eng_unit: None,
                    invert: item
                        .get("invert")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    alarm_hh: item
                        .get("alarmHH")
                        .or(item.get("alarm_hh"))
                        .and_then(|v| v.as_f64()),
                    alarm_h: item
                        .get("alarmH")
                        .or(item.get("alarm_h"))
                        .and_then(|v| v.as_f64()),
                    alarm_l: item
                        .get("alarmL")
                        .or(item.get("alarm_l"))
                        .and_then(|v| v.as_f64()),
                    alarm_ll: item
                        .get("alarmLL")
                        .or(item.get("alarm_ll"))
                        .and_then(|v| v.as_f64()),
                    deadband: item.get("deadband").and_then(|v| v.as_f64()),
                    protocol_config: ProtocolConfig::Gpio { pin, direction },
                });
            }
        }

        if let Some(modbus_array) = params.get("modbus").and_then(|v| v.as_array()) {
            for item in modbus_array {
                let tag_name = item
                    .get("tagName")
                    .or(item.get("tag_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let io_type_str = item
                    .get("ioType")
                    .or(item.get("io_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("AI");
                let io_type = match io_type_str {
                    "DI" => IoType::DI,
                    "DO" => IoType::DO,
                    "AO" => IoType::AO,
                    _ => IoType::AI,
                };
                let slave_id = item
                    .get("slaveId")
                    .or(item.get("slave_id"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1) as u8;
                let register = item.get("register").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                let function = item.get("function").and_then(|v| v.as_u64()).unwrap_or(3) as u8;
                let register_type = item
                    .get("registerType")
                    .or(item.get("register_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("holding")
                    .to_string();

                tags.push(TagConfig {
                    tag_name,
                    io_type,
                    data_type: item
                        .get("dataType")
                        .or(item.get("data_type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("FLOAT32")
                        .to_string(),
                    source: TagSource::Modbus,
                    poll_interval_ms: item
                        .get("pollIntervalMs")
                        .or(item.get("poll_interval_ms"))
                        .and_then(|v| v.as_u64()),
                    raw_min: item
                        .get("rawMin")
                        .or(item.get("raw_min"))
                        .and_then(|v| v.as_f64()),
                    raw_max: item
                        .get("rawMax")
                        .or(item.get("raw_max"))
                        .and_then(|v| v.as_f64()),
                    eng_min: item
                        .get("engMin")
                        .or(item.get("eng_min"))
                        .and_then(|v| v.as_f64()),
                    eng_max: item
                        .get("engMax")
                        .or(item.get("eng_max"))
                        .and_then(|v| v.as_f64()),
                    eng_unit: item
                        .get("engUnit")
                        .or(item.get("eng_unit"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    invert: item
                        .get("invert")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    alarm_hh: item
                        .get("alarmHH")
                        .or(item.get("alarm_hh"))
                        .and_then(|v| v.as_f64()),
                    alarm_h: item
                        .get("alarmH")
                        .or(item.get("alarm_h"))
                        .and_then(|v| v.as_f64()),
                    alarm_l: item
                        .get("alarmL")
                        .or(item.get("alarm_l"))
                        .and_then(|v| v.as_f64()),
                    alarm_ll: item
                        .get("alarmLL")
                        .or(item.get("alarm_ll"))
                        .and_then(|v| v.as_f64()),
                    deadband: item.get("deadband").and_then(|v| v.as_f64()),
                    protocol_config: ProtocolConfig::Modbus {
                        slave_id,
                        register,
                        function,
                        register_type,
                    },
                });
            }
        }

        if let Some(i2c_array) = params.get("i2c").and_then(|v| v.as_array()) {
            for item in i2c_array {
                let tag_name = item
                    .get("tagName")
                    .or(item.get("tag_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let io_type_str = item
                    .get("ioType")
                    .or(item.get("io_type"))
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

                let driver_type_str = item
                    .get("driverType")
                    .or(item.get("driver_type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("generic_direct");
                let driver_type = match driver_type_str {
                    "atlas_ezo" => {
                        let sensor = item
                            .get("sensorType")
                            .or(item.get("sensor_type"))
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
                        let read_register = item
                            .get("readRegister")
                            .or(item.get("read_register"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u8;
                        let read_length = item
                            .get("readLength")
                            .or(item.get("read_length"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(2) as u8;
                        I2cDriverType::GenericRegister {
                            read_register,
                            read_length,
                        }
                    }
                    _ => {
                        let read_length = item
                            .get("readLength")
                            .or(item.get("read_length"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(4) as u8;
                        I2cDriverType::GenericDirect { read_length }
                    }
                };

                tags.push(TagConfig {
                    tag_name,
                    io_type,
                    data_type: item
                        .get("dataType")
                        .or(item.get("data_type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("FLOAT32")
                        .to_string(),
                    source: TagSource::I2c,
                    poll_interval_ms: item
                        .get("pollIntervalMs")
                        .or(item.get("poll_interval_ms"))
                        .and_then(|v| v.as_u64()),
                    raw_min: item
                        .get("rawMin")
                        .or(item.get("raw_min"))
                        .and_then(|v| v.as_f64()),
                    raw_max: item
                        .get("rawMax")
                        .or(item.get("raw_max"))
                        .and_then(|v| v.as_f64()),
                    eng_min: item
                        .get("engMin")
                        .or(item.get("eng_min"))
                        .and_then(|v| v.as_f64()),
                    eng_max: item
                        .get("engMax")
                        .or(item.get("eng_max"))
                        .and_then(|v| v.as_f64()),
                    eng_unit: item
                        .get("engUnit")
                        .or(item.get("eng_unit"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    invert: item
                        .get("invert")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    alarm_hh: item
                        .get("alarmHH")
                        .or(item.get("alarm_hh"))
                        .and_then(|v| v.as_f64()),
                    alarm_h: item
                        .get("alarmH")
                        .or(item.get("alarm_h"))
                        .and_then(|v| v.as_f64()),
                    alarm_l: item
                        .get("alarmL")
                        .or(item.get("alarm_l"))
                        .and_then(|v| v.as_f64()),
                    alarm_ll: item
                        .get("alarmLL")
                        .or(item.get("alarm_ll"))
                        .and_then(|v| v.as_f64()),
                    deadband: item.get("deadband").and_then(|v| v.as_f64()),
                    protocol_config: ProtocolConfig::I2c {
                        bus,
                        address,
                        driver_type,
                    },
                });
            }
        }

        Ok(tags)
    }

    /// Persist the I/O config to disk as YAML at
    /// /etc/suderra/io_config.yaml. Creates the directory if
    /// absent. Called from cmd_update_io_config as best-effort.
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
