//! I/O polling loop — reads all tags, updates process image, publishes io_data
//!
//! Runs as a spawned tokio task. Polls GPIO, Modbus, and I2C at configurable intervals.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{self, MissedTickBehavior};
use serde::Serialize;
use tracing::{debug, warn, info};

use crate::AppState;
use crate::atlas_ezo::AtlasEzoDriver;
use crate::gpio::PinState;
use crate::process_image::{TagQuality, TagSource, ProtocolConfig, I2cDriverType, IoType};

/// Payload published to MQTT io_data topic
#[derive(Debug, Serialize)]
pub struct IoDataPayload {
    pub timestamp: String,
    pub tags: HashMap<String, IoTagData>,
}

/// Single tag data in io_data payload
#[derive(Debug, Serialize)]
pub struct IoTagData {
    pub value: serde_json::Value,
    pub quality: String,
}

/// Main I/O polling loop
pub async fn io_poll_loop(state: Arc<RwLock<AppState>>) {
    let interval_ms = {
        let s = state.read().await;
        s.config.telemetry.io_data_interval_ms
    };

    info!("Starting I/O poll loop (interval: {}ms)", interval_ms);

    let mut interval = time::interval(time::Duration::from_millis(interval_ms));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        interval.tick().await;

        if let Err(e) = poll_cycle(&state).await {
            warn!("I/O poll cycle error: {}", e);
        }
    }
}

async fn poll_cycle(state: &Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    let s = state.read().await;

    // Skip if not activated or no MQTT
    if !s.is_activated || s.mqtt_client.is_none() {
        return Ok(());
    }

    let process_image = s.process_image.clone();

    let configs = process_image.get_configs().await;

    if configs.is_empty() {
        return Ok(());
    }

    // --- GPIO reads ---
    if let Some(ref gpio) = s.gpio_handle {
        let result = gpio.read_all().await;
        for pin_value in &result.values {
            // Find matching tag config for this GPIO pin
            for cfg in &configs {
                if let ProtocolConfig::Gpio { pin, .. } = &cfg.protocol_config {
                    if *pin == pin_value.pin {
                        let value = if matches!(pin_value.state, PinState::High) { 1.0 } else { 0.0 };
                        process_image.update_tag(&cfg.tag_name, value, TagQuality::Good, TagSource::Gpio).await;
                    }
                }
            }
        }
    }

    // --- Modbus reads (parallel per device) ---
    if let Some(ref modbus) = s.modbus_handle {
        let results = modbus.read_all_parallel().await;
        for device_result in &results {
            for reg_value in &device_result.values {
                // Match register to tag config by tag name
                for cfg in &configs {
                    if let ProtocolConfig::Modbus { .. } = &cfg.protocol_config {
                        if reg_value.name == cfg.tag_name {
                            process_image.update_tag(&cfg.tag_name, reg_value.scaled_value, TagQuality::Good, TagSource::Modbus).await;
                        }
                    }
                }
            }
        }
    }

    // --- I2C reads (SEQUENTIAL - shared bus!) ---
    if let Some(ref i2c) = s.i2c_handle {
        let ezo_driver = AtlasEzoDriver::new(i2c.clone());

        for cfg in &configs {
            if let ProtocolConfig::I2c { driver_type, .. } = &cfg.protocol_config {
                match driver_type {
                    I2cDriverType::AtlasEzo { sensor_type } => {
                        let (value, quality) = ezo_driver.read_measurement(&cfg.tag_name, sensor_type).await;
                        process_image.update_tag_raw(&cfg.tag_name, value, quality, TagSource::I2c).await;
                    }
                    I2cDriverType::GenericRegister { read_register, read_length } => {
                        let result = i2c.read_register(&cfg.tag_name, *read_register, *read_length as usize).await;
                        if result.success {
                            let value = bytes_to_f64(&result.data);
                            process_image.update_tag(&cfg.tag_name, value, TagQuality::Good, TagSource::I2c).await;
                        } else {
                            warn!("I2C register read failed for '{}': {}", cfg.tag_name, result.error.as_deref().unwrap_or("unknown"));
                            process_image.update_tag(&cfg.tag_name, 0.0, TagQuality::CommFailure, TagSource::I2c).await;
                        }
                    }
                    I2cDriverType::GenericDirect { read_length } => {
                        let result = i2c.read_direct(&cfg.tag_name, *read_length as usize).await;
                        if result.success {
                            let value = bytes_to_f64(&result.data);
                            process_image.update_tag(&cfg.tag_name, value, TagQuality::Good, TagSource::I2c).await;
                        } else {
                            warn!("I2C direct read failed for '{}': {}", cfg.tag_name, result.error.as_deref().unwrap_or("unknown"));
                            process_image.update_tag(&cfg.tag_name, 0.0, TagQuality::CommFailure, TagSource::I2c).await;
                        }
                    }
                }
            }
        }
    }

    // --- Alarm evaluation ---
    {
        let all_tags = process_image.get_all_tags().await;
        let mut alarm_events = Vec::new();

        {
            let mut mgr = s.alarm_manager.write().await;
            for (tag_name, tag_value) in &all_tags {
                let events = mgr.process_source(tag_name, tag_value.value);
                alarm_events.extend(events);
            }
        }

        // Publish alarm events if any
        if !alarm_events.is_empty() {
            if let Some(ref mqtt) = s.mqtt_client {
                let payload = serde_json::json!({
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                    "alarms": alarm_events.iter().map(|e| serde_json::to_value(e).unwrap_or_default()).collect::<Vec<_>>(),
                });

                if let Err(e) = mqtt.publish_alarms(&payload).await {
                    warn!("Failed to publish alarms: {}", e);
                }
            }
        }
    }

    // --- Build and publish io_data ---
    let all_tags = process_image.get_all_tags().await;
    let mut io_tags = HashMap::new();

    for (name, tag) in &all_tags {
        let cfg = configs.iter().find(|c| c.tag_name == *name);
        let value = match cfg.map(|c| &c.io_type) {
            Some(IoType::DI) | Some(IoType::DO) => {
                serde_json::Value::Bool(tag.value != 0.0)
            }
            _ => serde_json::json!(tag.value),
        };

        io_tags.insert(name.clone(), IoTagData {
            value,
            quality: format!("{:?}", tag.quality).to_lowercase(),
        });
    }

    if !io_tags.is_empty() {
        let payload = IoDataPayload {
            timestamp: chrono::Utc::now().to_rfc3339(),
            tags: io_tags,
        };

        if let Some(ref mqtt) = s.mqtt_client {
            if let Err(e) = mqtt.publish_io_data(&payload).await {
                warn!("Failed to publish io_data: {}", e);
            } else {
                debug!("Published io_data ({} tags)", all_tags.len());
            }
        }
    }

    Ok(())
}

/// Convert raw bytes to f64 (big-endian, supports 2 or 4 byte values)
fn bytes_to_f64(data: &[u8]) -> f64 {
    match data.len() {
        2 => {
            let value = u16::from_be_bytes([data[0], data[1]]);
            value as f64
        }
        4 => {
            let value = f32::from_be_bytes([data[0], data[1], data[2], data[3]]);
            value as f64
        }
        8 => f64::from_be_bytes([data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7]]),
        _ => {
            warn!("Unexpected I2C data length: {}", data.len());
            0.0
        }
    }
}
