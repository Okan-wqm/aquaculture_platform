//! Telemetry collection for system metrics
//!
//! Collects CPU, memory, disk, temperature, network metrics,
//! and hardware data (Modbus, GPIO) and publishes them to the cloud via MQTT.

use std::sync::Arc;
use std::time::{Duration, Instant};
use sysinfo::{Components, Disks, Networks, System};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::AppState;
use crate::gpio::PinState;
use crate::interning::{intern_register_name, resolve};
use crate::mqtt::{GpioPinData, ModbusDeviceData, ModbusRegisterData, TelemetryMetrics};

/// Telemetry collector
pub struct TelemetryCollector {
    state: Arc<RwLock<AppState>>,
    system: System,
    networks: Networks,
    disks: Disks,
    components: Components,
    start_time: Instant,
}

impl TelemetryCollector {
    /// Create a new telemetry collector
    pub fn new(state: Arc<RwLock<AppState>>) -> Self {
        Self {
            state,
            system: System::new_all(),
            networks: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list(),
            components: Components::new_with_refreshed_list(),
            start_time: Instant::now(),
        }
    }

    /// Run the telemetry collection loop
    pub async fn run(mut self) {
        info!("Telemetry collector started");

        let interval = {
            let state = self.state.read().await;
            Duration::from_secs(state.config.telemetry.interval_seconds)
        };

        let mut status_counter = 0u32;

        // MissedTickBehavior::Skip prevents burst catch-up after a sleep overrun
        // (e.g., slow Modbus device causing the cycle to exceed interval).
        // Without Skip, tokio would fire multiple ticks back-to-back to compensate,
        // which on constrained edge hardware can cause CPU spikes and MQTT floods.
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;

            // Collect and publish telemetry
            if let Err(e) = self.collect_and_publish().await {
                warn!("Failed to publish telemetry: {}", e);
            }

            // Publish status every 3rd telemetry cycle (to reduce traffic)
            status_counter += 1;
            if status_counter >= 3 {
                status_counter = 0;
                if let Err(e) = self.publish_status().await {
                    warn!("Failed to publish status: {}", e);
                }
            }
        }
    }

    /// Collect metrics and publish via MQTT
    async fn collect_and_publish(&mut self) -> anyhow::Result<()> {
        // Refresh system info
        self.system.refresh_all();
        // v1.2.4: sysinfo 0.33 API - false = don't remove unlisted entries
        self.networks.refresh(false);
        self.disks.refresh(false);
        self.components.refresh(false);

        // Get config for what to include
        let config = {
            let state = self.state.read().await;
            state.config.telemetry.clone()
        };

        // Build metrics
        let mut metrics = TelemetryMetrics::default();

        // CPU metrics
        if config.include_cpu {
            let cpus = self.system.cpus();
            if !cpus.is_empty() {
                let total_usage: f32 = cpus.iter().map(|c| c.cpu_usage()).sum();
                metrics.cpu_usage_percent = Some(total_usage / cpus.len() as f32);
            }
        }

        // Memory metrics
        if config.include_memory {
            let total_mem = self.system.total_memory();
            let used_mem = self.system.used_memory();

            if total_mem > 0 {
                metrics.memory_usage_percent = Some((used_mem as f32 / total_mem as f32) * 100.0);
                metrics.memory_used_mb = Some(used_mem / 1024 / 1024);
                metrics.memory_total_mb = Some(total_mem / 1024 / 1024);
            }
        }

        // Disk metrics (root partition)
        if config.include_disk {
            if let Some(disk) = self.disks.list().first() {
                let total = disk.total_space();
                let available = disk.available_space();
                let used = total.saturating_sub(available);

                if total > 0 {
                    metrics.disk_usage_percent = Some((used as f32 / total as f32) * 100.0);
                    metrics.disk_used_gb = Some(used as f64 / 1024.0 / 1024.0 / 1024.0);
                    metrics.disk_total_gb = Some(total as f64 / 1024.0 / 1024.0 / 1024.0);
                }
            }
        }

        // Temperature (CPU temp if available)
        if config.include_temperature {
            metrics.temperature_celsius = self.get_cpu_temperature();
        }

        // Network metrics (aggregate all interfaces)
        // LOW-42: Convert raw bytes to MB for JSON safety (avoids f64 precision loss
        // when byte counters exceed 2^53 on high-throughput interfaces).
        let (rx_bytes, tx_bytes) = self.get_network_bytes();
        if rx_bytes > 0 || tx_bytes > 0 {
            metrics.network_rx_mb = Some(rx_bytes as f64 / 1024.0 / 1024.0);
            metrics.network_tx_mb = Some(tx_bytes as f64 / 1024.0 / 1024.0);
        }

        // Detect outbound IP address (routing table only, no DNS)
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    metrics.ip_address = Some(addr.ip().to_string());
                }
            }
        }

        // Collect hardware data (Modbus, GPIO)
        self.collect_hardware_data(&mut metrics).await;

        // Publish via MQTT — Batch #261 ARC-002 migration.
        // Telemetry observability data — Normal priority. Drains
        // AFTER alarms (Critical) + status (High) on reconnect.
        // Pre-Batch-261 the legacy `MqttClient::publish_telemetry`
        // built the TelemetryMessage envelope internally (needed
        // private access to device_id + device_code). Batch #255
        // added public accessors for those fields, unblocking the
        // helper-based migration done here.
        let state = self.state.read().await;
        let mqtt = match state.mqtt_client.as_ref() {
            Some(m) => m,
            None => return Ok(()),
        };
        let payload = serde_json::json!({
            "device_id": mqtt.device_id(),
            "device_code": mqtt.device_code(),
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "agent_version": env!("CARGO_PKG_VERSION"),
            "metrics": metrics,
        });
        crate::publish_helpers::publish_telemetry(&state, &payload).await;
        debug!("Telemetry published");

        Ok(())
    }

    /// Publish device status — Batch #255 ARC-002 migration:
    /// status transitions are operator-actionable (cloud
    /// alerting on stale-device gauges), so route through
    /// `OutboundPublisher` at High priority. Status persists
    /// during broker outage + replays after alarms (Critical)
    /// but before telemetry (Normal) on reconnect.
    async fn publish_status(&self) -> anyhow::Result<()> {
        use crate::mqtt::DeviceStatus;
        let uptime = self.start_time.elapsed().as_secs();

        // Build the same StatusMessage envelope the legacy
        // `MqttClient::publish_status` emits — keeps the wire
        // shape identical for cloud consumers.
        let state = self.state.read().await;
        let mqtt = match state.mqtt_client.as_ref() {
            Some(m) => m,
            None => return Ok(()),
        };
        let payload = serde_json::json!({
            "device_id": mqtt.device_id(),
            "device_code": mqtt.device_code(),
            "status": DeviceStatus::Online,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "agent_version": env!("CARGO_PKG_VERSION"),
            "uptime_seconds": uptime,
        });
        crate::publish_helpers::publish_status(&state, &payload).await;
        debug!("Status published");

        Ok(())
    }

    /// Get CPU temperature (Linux-specific)
    fn get_cpu_temperature(&self) -> Option<f32> {
        // Try using sysinfo components
        // v1.2.4: sysinfo 0.33 - temperature() now returns Option<f32>
        for component in self.components.iter() {
            let label = component.label().to_lowercase();
            if label.contains("cpu") || label.contains("core") || label.contains("package") {
                if let Some(temp) = component.temperature() {
                    return Some(temp);
                }
            }
        }

        // Fallback: Try reading from thermal zone (Raspberry Pi, etc.)
        #[cfg(target_os = "linux")]
        {
            if let Ok(content) = std::fs::read_to_string("/sys/class/thermal/thermal_zone0/temp") {
                if let Ok(millidegrees) = content.trim().parse::<i32>() {
                    return Some(millidegrees as f32 / 1000.0);
                }
            }
        }

        None
    }

    /// Get network bytes (rx, tx) for all interfaces
    fn get_network_bytes(&self) -> (u64, u64) {
        let mut total_rx = 0u64;
        let mut total_tx = 0u64;

        for (interface_name, data) in self.networks.iter() {
            // Skip loopback and virtual interfaces
            if interface_name.starts_with("lo")
                || interface_name.starts_with("veth")
                || interface_name.starts_with("docker")
                || interface_name.starts_with("br-")
            {
                continue;
            }

            total_rx += data.total_received();
            total_tx += data.total_transmitted();
        }

        (total_rx, total_tx)
    }

    /// Collect hardware data (Modbus, GPIO) into metrics
    ///
    /// v2.0: Uses actor pattern for both GPIO and Modbus
    async fn collect_hardware_data(&self, metrics: &mut TelemetryMetrics) {
        // Collect GPIO data via actor handle (v2.0)
        let gpio_handle = {
            let state = self.state.read().await;
            state.gpio_handle.clone()
        };

        if let Some(handle) = gpio_handle {
            let gpio_result = handle.read_all().await;
            // LOW-38: Use string interning for repeated GPIO names/directions/states
            // to avoid heap-allocating the same strings every telemetry cycle.
            // intern_register_name() returns a Spur key; resolve() gives &'static str.
            let gpio_data: Vec<GpioPinData> = gpio_result
                .values
                .iter()
                .map(|v| GpioPinData {
                    name: resolve(intern_register_name(&v.name)).to_string(),
                    pin: v.pin,
                    direction: resolve(intern_register_name(&v.direction)).to_string(),
                    state: match v.state {
                        PinState::High => resolve(intern_register_name("high")).to_string(),
                        PinState::Low => resolve(intern_register_name("low")).to_string(),
                    },
                })
                .collect();

            if !gpio_data.is_empty() {
                metrics.gpio = Some(gpio_data);
            }

            // Log GPIO errors if any
            for error in &gpio_result.errors {
                warn!("GPIO error: {}", error);
            }
        }

        // Collect Modbus data via thread-safe handle (actor pattern)
        let modbus_handle = {
            let state = self.state.read().await;
            state.modbus_handle.clone()
        };

        if let Some(handle) = modbus_handle {
            // v1.2.2: Use parallel reads for lower latency
            let modbus_results = handle.read_all_parallel().await;
            let mut modbus_data = Vec::new();

            for result in modbus_results {
                // LOW-38: Intern register names and device names (polled every cycle)
                let registers: Vec<ModbusRegisterData> = result
                    .values
                    .iter()
                    .map(|v| ModbusRegisterData {
                        name: resolve(intern_register_name(&v.name)).to_string(),
                        address: v.address,
                        value: v.scaled_value,
                        unit: v.unit.clone(),
                    })
                    .collect();

                modbus_data.push(ModbusDeviceData {
                    device_name: resolve(intern_register_name(&result.device_name)).to_string(),
                    registers,
                    errors: result.errors,
                });
            }

            if !modbus_data.is_empty() {
                metrics.modbus = Some(modbus_data);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_telemetry_metrics_serialization() {
        let metrics = TelemetryMetrics {
            cpu_usage_percent: Some(45.5),
            memory_usage_percent: Some(62.3),
            memory_used_mb: Some(4096),
            memory_total_mb: Some(8192),
            disk_usage_percent: None,
            disk_used_gb: None,
            disk_total_gb: None,
            temperature_celsius: Some(55.0),
            network_rx_mb: None,
            network_tx_mb: None,
            ip_address: None,
            modbus: None,
            gpio: None,
        };

        let json = serde_json::to_string(&metrics).unwrap();
        assert!(json.contains("cpu_usage_percent"));
        assert!(json.contains("45.5"));
        assert!(!json.contains("disk_usage_percent")); // None fields skipped
        assert!(!json.contains("modbus")); // None fields skipped
    }

    #[test]
    fn test_telemetry_with_hardware_data() {
        let metrics = TelemetryMetrics {
            cpu_usage_percent: Some(50.0),
            memory_usage_percent: None,
            memory_used_mb: None,
            memory_total_mb: None,
            disk_usage_percent: None,
            disk_used_gb: None,
            disk_total_gb: None,
            temperature_celsius: None,
            network_rx_mb: None,
            network_tx_mb: None,
            ip_address: None,
            modbus: Some(vec![ModbusDeviceData {
                device_name: "PLC-1".to_string(),
                registers: vec![ModbusRegisterData {
                    name: "water_temp".to_string(),
                    address: 100,
                    value: 22.5,
                    unit: Some("°C".to_string()),
                }],
                errors: vec![],
            }]),
            gpio: Some(vec![GpioPinData {
                name: "pump_status".to_string(),
                pin: 17,
                direction: "input".to_string(),
                state: "high".to_string(),
            }]),
        };

        let json = serde_json::to_string(&metrics).unwrap();
        assert!(json.contains("modbus"));
        assert!(json.contains("PLC-1"));
        assert!(json.contains("water_temp"));
        assert!(json.contains("gpio"));
        assert!(json.contains("pump_status"));
    }
}
