//! I2C (Inter-Integrated Circuit) support for Raspberry Pi
//!
//! Provides I2C communication capabilities for sensors, displays,
//! and other I2C peripherals.
//!
//! ## Raspberry Pi I2C Buses
//! - I2C1: GPIO 2 (SDA), GPIO 3 (SCL) - primary bus
//! - I2C0: GPIO 0 (SDA), GPIO 1 (SCL) - reserved for HAT EEPROM
//!
//! ## Common I2C Devices
//! - BME280: Temperature, humidity, pressure (0x76/0x77)
//! - SHT31: Temperature, humidity (0x44/0x45)
//! - ADS1115: 16-bit ADC (0x48-0x4B)
//! - PCA9685: 16-channel PWM (0x40-0x7F)
//!
//! ## v1.2.4 Features
//! - Actor pattern for thread safety
//! - Read/write operations
//! - Block read/write support
//! - Device scanning

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
#[cfg(all(target_os = "linux", feature = "gpio"))]
use tracing::{debug, error};
use tracing::{info, warn};

use crate::degraded::ControlGate;
#[cfg(not(all(target_os = "linux", feature = "gpio")))]
use crate::degraded::{Backend, BackendNotCompiled};
use crate::safe_state::SafeStateWrite;

// ============================================================================
// Configuration
// ============================================================================

/// Default I2C channel buffer size
const DEFAULT_I2C_CHANNEL_SIZE: usize = 64;

/// I2C device configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct I2cDeviceConfig {
    /// Device name (for identification)
    pub name: String,
    /// I2C address (7-bit, typically 0x00-0x7F)
    pub address: u8,
    /// I2C bus number (default: 1 for Raspberry Pi)
    #[serde(default = "default_bus")]
    pub bus: u8,
    /// Clock speed in Hz (default: 100000)
    #[serde(default = "default_clock_speed")]
    pub clock_speed_hz: u32,
    /// Device description
    #[serde(default)]
    pub description: String,
}

fn default_bus() -> u8 {
    1
}

fn default_clock_speed() -> u32 {
    100_000 // 100 kHz standard mode
}

impl Default for I2cDeviceConfig {
    fn default() -> Self {
        Self {
            name: "i2c_device".to_string(),
            address: 0x00,
            bus: 1,
            clock_speed_hz: 100_000,
            description: String::new(),
        }
    }
}

/// I2C read result.
///
/// Batch 21 ARC-006: `simulated` field added so the io_poll path
/// can route sim reads to `TagQuality::Simulated` and MQTT
/// publish can attach `"simulated": true` to the outgoing tag
/// value. Serde-skipped when false so real-hardware reads don't
/// carry an unused field in every payload.
#[derive(Debug, Clone, Serialize)]
pub struct I2cReadResult {
    pub device: String,
    pub address: u8,
    pub register: u8,
    pub data: Vec<u8>,
    pub success: bool,
    pub error: Option<String>,
    /// True when this read came from the simulation branch
    /// (default build or missing `gpio` feature). Real-hardware
    /// reads always set this to `false`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub simulated: bool,
}

/// I2C scan result
#[derive(Debug, Clone, Serialize)]
pub struct I2cScanResult {
    pub bus: u8,
    pub devices: Vec<u8>,
}

// ============================================================================
// Actor Pattern Types
// ============================================================================

/// Commands sent to the I2C actor
#[derive(Debug)]
pub enum I2cCommand {
    /// Initialize I2C bus
    Init {
        response: oneshot::Sender<Result<()>>,
    },
    /// Read bytes from a register
    ReadRegister {
        device: String,
        register: u8,
        length: usize,
        response: oneshot::Sender<I2cReadResult>,
    },
    /// Write bytes to a register
    WriteRegister {
        device: String,
        register: u8,
        data: Vec<u8>,
        response: oneshot::Sender<Result<()>>,
    },
    /// Read bytes directly (no register)
    ReadDirect {
        device: String,
        length: usize,
        response: oneshot::Sender<I2cReadResult>,
    },
    /// Write bytes directly (no register)
    WriteDirect {
        device: String,
        data: Vec<u8>,
        response: oneshot::Sender<Result<()>>,
    },
    /// Scan I2C bus for devices
    Scan {
        bus: u8,
        response: oneshot::Sender<I2cScanResult>,
    },
    /// Check if device is present
    Probe {
        device: String,
        response: oneshot::Sender<bool>,
    },
    /// Shutdown
    Shutdown,
}

// ============================================================================
// I2C Handle (Public API)
// ============================================================================

/// Thread-safe handle to communicate with the I2C actor
#[derive(Clone)]
pub struct I2cHandle {
    sender: mpsc::Sender<I2cCommand>,
    /// Refuses actuator writes while the agent is degraded (DEC-6.3).
    gate: ControlGate,
}

impl I2cHandle {
    /// Create a new handle and spawn the actor
    pub fn new(devices: Vec<I2cDeviceConfig>, gate: ControlGate) -> Self {
        let (sender, receiver) = mpsc::channel(DEFAULT_I2C_CHANNEL_SIZE);

        // Spawn the actor
        tokio::spawn(async move {
            let mut actor = I2cActor::new(devices, receiver);
            actor.run().await;
        });

        Self { sender, gate }
    }

    /// Initialize I2C bus
    pub async fn init(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send_command(I2cCommand::Init { response: tx }).await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("Actor disconnected"))?
    }

    /// Read bytes from a device register
    pub async fn read_register(&self, device: &str, register: u8, length: usize) -> I2cReadResult {
        let (tx, rx) = oneshot::channel();
        if self
            .send_command(I2cCommand::ReadRegister {
                device: device.to_string(),
                register,
                length,
                response: tx,
            })
            .await
            .is_err()
        {
            return I2cReadResult {
                device: device.to_string(),
                address: 0,
                register,
                data: vec![],
                success: false,
                error: Some("Failed to send command".to_string()),
                simulated: false,
            };
        }
        rx.await.unwrap_or_else(|_| I2cReadResult {
            device: device.to_string(),
            address: 0,
            register,
            data: vec![],
            success: false,
            error: Some("Actor disconnected".to_string()),
            simulated: false,
        })
    }

    /// Write bytes to a device register (a DAC or relay output). Refused
    /// while the agent is degraded.
    pub async fn write_register(&self, device: &str, register: u8, data: &[u8]) -> Result<()> {
        self.gate.permit()?;
        self.send_register_write(device, register, data).await
    }

    /// Write an output register's fail-safe payload; allowed while control is
    /// disabled, for the safe-state writer only.
    pub async fn write_register_safe_state(
        &self,
        device: &str,
        register: u8,
        data: &[u8],
        _: &SafeStateWrite,
    ) -> Result<()> {
        self.send_register_write(device, register, data).await
    }

    async fn send_register_write(&self, device: &str, register: u8, data: &[u8]) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send_command(I2cCommand::WriteRegister {
            device: device.to_string(),
            register,
            data: data.to_vec(),
            response: tx,
        })
        .await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("Actor disconnected"))?
    }

    /// Read bytes directly from device (no register address)
    pub async fn read_direct(&self, device: &str, length: usize) -> I2cReadResult {
        let (tx, rx) = oneshot::channel();
        if self
            .send_command(I2cCommand::ReadDirect {
                device: device.to_string(),
                length,
                response: tx,
            })
            .await
            .is_err()
        {
            return I2cReadResult {
                device: device.to_string(),
                address: 0,
                register: 0,
                data: vec![],
                success: false,
                error: Some("Failed to send command".to_string()),
                simulated: false,
            };
        }
        rx.await.unwrap_or_else(|_| I2cReadResult {
            device: device.to_string(),
            address: 0,
            register: 0,
            data: vec![],
            success: false,
            error: Some("Actor disconnected".to_string()),
            simulated: false,
        })
    }

    /// Write bytes directly to a device as an output value (no register
    /// address). Refused while the agent is degraded.
    pub async fn write_direct(&self, device: &str, data: &[u8]) -> Result<()> {
        self.gate.permit()?;
        self.send_direct(device, data).await
    }

    /// Send a sensor protocol command (Atlas EZO `R`, calibration). It is a
    /// request to a sensor, not an actuator write, so degraded mode — which
    /// keeps monitoring — does not refuse it.
    pub async fn send_sensor_command(&self, device: &str, data: &[u8]) -> Result<()> {
        self.send_direct(device, data).await
    }

    async fn send_direct(&self, device: &str, data: &[u8]) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.send_command(I2cCommand::WriteDirect {
            device: device.to_string(),
            data: data.to_vec(),
            response: tx,
        })
        .await?;
        rx.await
            .map_err(|_| anyhow::anyhow!("Actor disconnected"))?
    }

    /// Scan I2C bus for devices
    pub async fn scan(&self, bus: u8) -> I2cScanResult {
        let (tx, rx) = oneshot::channel();
        if self
            .send_command(I2cCommand::Scan { bus, response: tx })
            .await
            .is_err()
        {
            return I2cScanResult {
                bus,
                devices: vec![],
            };
        }
        rx.await.unwrap_or_else(|_| I2cScanResult {
            bus,
            devices: vec![],
        })
    }

    /// Check if a device is present
    pub async fn probe(&self, device: &str) -> bool {
        let (tx, rx) = oneshot::channel();
        if self
            .send_command(I2cCommand::Probe {
                device: device.to_string(),
                response: tx,
            })
            .await
            .is_err()
        {
            return false;
        }
        rx.await.unwrap_or(false)
    }

    /// Actor'u durdur
    pub async fn shutdown(&self) {
        let _ = self.sender.send(I2cCommand::Shutdown).await;
    }

    /// Send command to actor (blocking until channel has space)
    async fn send_command(&self, cmd: I2cCommand) -> Result<()> {
        self.sender
            .send(cmd)
            .await
            .map_err(|_| anyhow::anyhow!("I2C actor disconnected"))
    }
}

// ============================================================================
// I2C Actor Implementation
// ============================================================================

/// I2C actor that manages I2C bus communication
struct I2cActor {
    devices: Vec<I2cDeviceConfig>,
    receiver: mpsc::Receiver<I2cCommand>,
    device_map: HashMap<String, I2cDeviceConfig>,
    #[cfg(all(target_os = "linux", feature = "gpio"))]
    i2c_buses: HashMap<u8, rppal::i2c::I2c>,
}

impl I2cActor {
    fn new(devices: Vec<I2cDeviceConfig>, receiver: mpsc::Receiver<I2cCommand>) -> Self {
        let mut device_map = HashMap::new();
        for device in &devices {
            device_map.insert(device.name.clone(), device.clone());
        }

        Self {
            devices,
            receiver,
            device_map,
            #[cfg(all(target_os = "linux", feature = "gpio"))]
            i2c_buses: HashMap::new(),
        }
    }

    async fn run(&mut self) {
        info!(
            "I2C actor started with {} devices configured",
            self.devices.len()
        );

        while let Some(cmd) = self.receiver.recv().await {
            match cmd {
                I2cCommand::Init { response } => {
                    let result = self.init_buses();
                    let _ = response.send(result);
                }
                I2cCommand::ReadRegister {
                    device,
                    register,
                    length,
                    response,
                } => {
                    let result = self.read_register(&device, register, length);
                    let _ = response.send(result);
                }
                I2cCommand::WriteRegister {
                    device,
                    register,
                    data,
                    response,
                } => {
                    let result = self.write_register(&device, register, &data);
                    let _ = response.send(result);
                }
                I2cCommand::ReadDirect {
                    device,
                    length,
                    response,
                } => {
                    let result = self.read_direct(&device, length);
                    let _ = response.send(result);
                }
                I2cCommand::WriteDirect {
                    device,
                    data,
                    response,
                } => {
                    let result = self.write_direct(&device, &data);
                    let _ = response.send(result);
                }
                I2cCommand::Scan { bus, response } => {
                    let result = self.scan_bus(bus);
                    let _ = response.send(result);
                }
                I2cCommand::Probe { device, response } => {
                    let result = self.probe_device(&device);
                    let _ = response.send(result);
                }
                I2cCommand::Shutdown => {
                    info!("I2C actor shutting down");
                    break;
                }
            }
        }

        info!("I2C actor stopped");
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn init_buses(&mut self) -> Result<()> {
        use rppal::i2c::I2c;

        // Collect unique bus numbers
        let buses: std::collections::HashSet<u8> = self.devices.iter().map(|d| d.bus).collect();

        for bus in buses {
            match I2c::with_bus(bus) {
                Ok(i2c) => {
                    info!("Initialized I2C bus {}", bus);
                    self.i2c_buses.insert(bus, i2c);
                }
                Err(e) => {
                    error!("Failed to initialize I2C bus {}: {}", bus, e);
                    return Err(anyhow::anyhow!(
                        "Failed to initialize I2C bus {}: {}",
                        bus,
                        e
                    ));
                }
            }
        }

        Ok(())
    }

    /// ADR-048 DEC-6.3 / INFRA-CRITICAL-236: no simulation backend; a
    /// configured I2C without the driver fails closed.
    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn init_buses(&mut self) -> Result<()> {
        Err(anyhow::Error::new(BackendNotCompiled(Backend::I2c)))
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn unavailable_read(&self, device: &str, register: u8) -> I2cReadResult {
        I2cReadResult {
            device: device.to_string(),
            address: self.device_map.get(device).map(|c| c.address).unwrap_or(0),
            register,
            data: vec![],
            success: false,
            error: Some(BackendNotCompiled(Backend::I2c).to_string()),
            simulated: false,
        }
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn read_register(&mut self, device: &str, register: u8, length: usize) -> I2cReadResult {
        let config = match self.device_map.get(device) {
            Some(c) => c.clone(),
            None => {
                return I2cReadResult {
                    device: device.to_string(),
                    address: 0,
                    register,
                    data: vec![],
                    success: false,
                    error: Some(format!("Device '{}' not found", device)),
                    simulated: false,
                };
            }
        };

        let i2c = match self.i2c_buses.get_mut(&config.bus) {
            Some(i) => i,
            None => {
                return I2cReadResult {
                    device: device.to_string(),
                    address: config.address,
                    register,
                    data: vec![],
                    success: false,
                    error: Some(format!("I2C bus {} not initialized", config.bus)),
                    simulated: false,
                };
            }
        };

        // Set slave address
        if let Err(e) = i2c.set_slave_address(config.address as u16) {
            return I2cReadResult {
                device: device.to_string(),
                address: config.address,
                register,
                data: vec![],
                success: false,
                error: Some(format!("Failed to set address: {}", e)),
                simulated: false,
            };
        }

        let mut buffer = vec![0u8; length];
        match i2c.block_read(register, &mut buffer) {
            Ok(_) => {
                debug!(
                    "I2C read from '{}' reg 0x{:02X}: {:02X?}",
                    device, register, buffer
                );
                I2cReadResult {
                    device: device.to_string(),
                    address: config.address,
                    register,
                    data: buffer,
                    success: true,
                    error: None,
                    simulated: false,
                }
            }
            Err(e) => I2cReadResult {
                device: device.to_string(),
                address: config.address,
                register,
                data: vec![],
                success: false,
                error: Some(format!("Read failed: {}", e)),
                simulated: false,
            },
        }
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn read_register(&mut self, device: &str, register: u8, _length: usize) -> I2cReadResult {
        self.unavailable_read(device, register)
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn write_register(&mut self, device: &str, register: u8, data: &[u8]) -> Result<()> {
        let config = self
            .device_map
            .get(device)
            .ok_or_else(|| anyhow::anyhow!("Device '{}' not found", device))?
            .clone();

        let i2c = self
            .i2c_buses
            .get_mut(&config.bus)
            .ok_or_else(|| anyhow::anyhow!("I2C bus {} not initialized", config.bus))?;

        i2c.set_slave_address(config.address as u16)?;
        i2c.block_write(register, data)?;

        debug!(
            "I2C write to '{}' reg 0x{:02X}: {:02X?}",
            device, register, data
        );
        Ok(())
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn write_register(&mut self, _device: &str, _register: u8, _data: &[u8]) -> Result<()> {
        Err(anyhow::Error::new(BackendNotCompiled(Backend::I2c)))
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn read_direct(&mut self, device: &str, length: usize) -> I2cReadResult {
        let config = match self.device_map.get(device) {
            Some(c) => c.clone(),
            None => {
                return I2cReadResult {
                    device: device.to_string(),
                    address: 0,
                    register: 0,
                    data: vec![],
                    success: false,
                    error: Some(format!("Device '{}' not found", device)),
                    simulated: false,
                };
            }
        };

        let i2c = match self.i2c_buses.get_mut(&config.bus) {
            Some(i) => i,
            None => {
                return I2cReadResult {
                    device: device.to_string(),
                    address: config.address,
                    register: 0,
                    data: vec![],
                    success: false,
                    error: Some(format!("I2C bus {} not initialized", config.bus)),
                    simulated: false,
                };
            }
        };

        if let Err(e) = i2c.set_slave_address(config.address as u16) {
            return I2cReadResult {
                device: device.to_string(),
                address: config.address,
                register: 0,
                data: vec![],
                success: false,
                error: Some(format!("Failed to set address: {}", e)),
                simulated: false,
            };
        }

        let mut buffer = vec![0u8; length];
        match i2c.read(&mut buffer) {
            Ok(_) => I2cReadResult {
                device: device.to_string(),
                address: config.address,
                register: 0,
                data: buffer,
                success: true,
                error: None,
                simulated: false,
            },
            Err(e) => I2cReadResult {
                device: device.to_string(),
                address: config.address,
                register: 0,
                data: vec![],
                success: false,
                error: Some(format!("Read failed: {}", e)),
                simulated: false,
            },
        }
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn read_direct(&mut self, device: &str, _length: usize) -> I2cReadResult {
        self.unavailable_read(device, 0)
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn write_direct(&mut self, device: &str, data: &[u8]) -> Result<()> {
        let config = self
            .device_map
            .get(device)
            .ok_or_else(|| anyhow::anyhow!("Device '{}' not found", device))?
            .clone();

        let i2c = self
            .i2c_buses
            .get_mut(&config.bus)
            .ok_or_else(|| anyhow::anyhow!("I2C bus {} not initialized", config.bus))?;

        i2c.set_slave_address(config.address as u16)?;
        i2c.write(data)?;

        Ok(())
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn write_direct(&mut self, _device: &str, _data: &[u8]) -> Result<()> {
        Err(anyhow::Error::new(BackendNotCompiled(Backend::I2c)))
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn scan_bus(&mut self, bus: u8) -> I2cScanResult {
        use rppal::i2c::I2c;

        let mut devices = Vec::new();

        match I2c::with_bus(bus) {
            Ok(mut i2c) => {
                // Scan addresses 0x03 to 0x77 (valid 7-bit addresses)
                for addr in 0x03..=0x77 {
                    if i2c.set_slave_address(addr).is_ok() {
                        // Try a quick read to detect device
                        let mut buf = [0u8; 1];
                        if i2c.read(&mut buf).is_ok() {
                            devices.push(addr as u8);
                            debug!("I2C device found at 0x{:02X}", addr);
                        }
                    }
                }
            }
            Err(e) => {
                warn!("Failed to scan I2C bus {}: {}", bus, e);
            }
        }

        I2cScanResult { bus, devices }
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn scan_bus(&mut self, bus: u8) -> I2cScanResult {
        warn!(
            "I2C scan on bus {} found nothing: {}",
            bus,
            BackendNotCompiled(Backend::I2c)
        );
        I2cScanResult {
            bus,
            devices: vec![],
        }
    }

    fn probe_device(&mut self, device: &str) -> bool {
        let result = self.read_direct(device, 1);
        result.success
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_i2c_device_config_default() {
        let config = I2cDeviceConfig::default();
        assert_eq!(config.bus, 1);
        assert_eq!(config.clock_speed_hz, 100_000);
    }

    #[test]
    fn test_i2c_device_config_serialization() {
        let config = I2cDeviceConfig {
            name: "bme280".to_string(),
            address: 0x76,
            bus: 1,
            clock_speed_hz: 400_000,
            description: "Temperature sensor".to_string(),
        };

        let yaml = serde_yaml::to_string(&config).unwrap();
        assert!(yaml.contains("address: 118")); // 0x76 = 118
        assert!(yaml.contains("bus: 1"));

        let parsed: I2cDeviceConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.address, 0x76);
    }

    #[tokio::test]
    async fn test_i2c_handle_creation() {
        let devices = vec![I2cDeviceConfig {
            name: "test_sensor".to_string(),
            address: 0x48,
            bus: 1,
            ..Default::default()
        }];

        let dir = tempfile::tempdir().expect("tempdir");
        let degraded = crate::degraded::DegradedMode::new(dir.path().join("h.json"));
        let handle = I2cHandle::new(devices, degraded.control_gate());

        // ADR-048 DEC-6.3 / INFRA-CRITICAL-236: without the driver there is
        // no simulation. Init fails closed, reads report the missing backend
        // instead of zero-filled "successful" data, and writes are refused.
        #[cfg(not(all(target_os = "linux", feature = "gpio")))]
        {
            let err = handle.init().await.expect_err("init must fail closed");
            assert!(
                err.downcast_ref::<crate::degraded::BackendNotCompiled>()
                    .is_some(),
                "{err:#}"
            );
            let read_result = handle.read_register("test_sensor", 0x00, 2).await;
            assert!(!read_result.success);
            assert!(!read_result.simulated);
            assert!(read_result.data.is_empty());
            assert!(read_result.error.is_some());
            assert!(
                handle
                    .write_register("test_sensor", 0x01, &[1])
                    .await
                    .is_err()
            );
            assert!(handle.write_direct("test_sensor", &[1]).await.is_err());
            assert!(!handle.read_direct("test_sensor", 4).await.success);
        }

        // Degraded mode refuses actuator writes before they reach the bus.
        degraded.enter(crate::degraded::DegradedReason::IoBudgetExceeded {
            configured: 1,
            cap: 0,
        });
        for err in [
            handle.write_register("test_sensor", 0x01, &[1]).await,
            handle.write_direct("test_sensor", &[1]).await,
        ] {
            let err = err.expect_err("refused while degraded");
            assert!(
                err.downcast_ref::<crate::degraded::ControlDisabled>()
                    .is_some(),
                "{err:#}"
            );
        }
    }

    #[test]
    fn test_common_i2c_addresses() {
        // Common I2C device addresses
        let bme280 = 0x76_u8;
        let sht31 = 0x44_u8;
        let ads1115 = 0x48_u8;
        let pca9685 = 0x40_u8;

        assert!(bme280 >= 0x03 && bme280 <= 0x77);
        assert!(sht31 >= 0x03 && sht31 <= 0x77);
        assert!(ads1115 >= 0x03 && ads1115 <= 0x77);
        assert!(pca9685 >= 0x03 && pca9685 <= 0x77);
    }
}
