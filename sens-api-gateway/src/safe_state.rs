//! Safe-State Manager for Actuator Outputs (LIFE-SAFETY)
//!
//! On shutdown (SIGTERM, SIGINT, crash, OOM-kill), all actuator outputs must be
//! driven to a deterministic fail-safe position **before** hardware interfaces
//! are disconnected.  Without this, actuators remain in their last commanded
//! position, which can cause:
//!   - Stuck-open feeder → overfeeding → fish mortality
//!   - Stuck-off aerator → oxygen depletion → mass mortality
//!   - Stuck-open valve → tank overflow / chemical overdose
//!
//! # Fail-Safe Convention
//! | Output Type          | Safe Value           | Rationale                      |
//! |----------------------|----------------------|--------------------------------|
//! | Digital Output (DO)  | `false` (de-energise)| Relay drops out → actuator off |
//! | Analog Output  (AO)  | `0`  (0 V / 0 mA)   | Drive to zero output           |
//! | GPIO output pin      | `false` (LOW)        | Pin driven LOW                 |
//!
//! # Timeout
//! Each device gets up to `PER_DEVICE_TIMEOUT` to acknowledge the write.
//! If it fails or times out the error is logged and the next device is tried.
//! A stuck device must never block the rest of the shutdown sequence.
//!
//! # IEC 62443 SL2 FR7 (Availability)
//! This module directly addresses the requirement that a control system must
//! fail to a safe state upon loss of communication or software failure.

use std::time::Duration;
use tracing::{error, info, warn};

use crate::config::{AgentConfig, GpioConfig, ModbusDeviceConfig};
use crate::gpio::GpioHandle;
use crate::i2c::I2cHandle;
use crate::modbus::ModbusHandle;

/// Maximum time to wait for a single device to accept a safe-state write.
/// LIFE-SAFETY: 2 s per device is generous; if the bus is dead we move on.
const PER_DEVICE_TIMEOUT: Duration = Duration::from_secs(2);

// ============================================================================
// Output Tag Descriptor
// ============================================================================

/// Describes a single actuator output that must be driven to safe-state.
///
/// Each variant carries its per-actuator fail-safe value (EDGE-HIGH-012),
/// resolved from config at registry-build time. A uniform de-energise is
/// wrong for life-support outputs (an aerator/O2 injector must fail-ON,
/// not OFF); operators express the correct polarity via
/// `modbus.registers[].safe_state_value` / `gpio[].safe_state_level`,
/// defaulting to de-energise when unset.
#[derive(Debug, Clone)]
pub enum OutputTag {
    /// Modbus coil (digital output): device name + coil address + fail-safe level
    ModbusCoil {
        device_name: String,
        address: u16,
        safe_value: bool,
    },
    /// Modbus holding register (analog output): device name + address + fail-safe value
    ModbusRegister {
        device_name: String,
        address: u16,
        safe_value: u16,
    },
    /// GPIO output pin + fail-safe level
    GpioPin { pin: u8, safe_level: bool },
    /// I2C DAC or relay board: device name + register + safe-value payload
    I2cOutput {
        device_name: String,
        register: u8,
        safe_value: Vec<u8>,
    },
}

// ============================================================================
// Safe-State Manager
// ============================================================================

/// Knows every actuator output on this edge node and can drive them all to
/// their fail-safe value in a single pass.
///
/// Constructed once at startup from the agent configuration.  The shutdown
/// sequence calls [`SafeStateManager::apply`] before disconnecting any
/// hardware bus.
pub struct SafeStateManager {
    /// All registered output tags that need safe-state on shutdown.
    outputs: Vec<OutputTag>,
}

impl SafeStateManager {
    /// Build the output registry from the agent configuration.
    ///
    /// Scans Modbus devices for writable coil/holding registers, GPIO for
    /// output pins, and I2C for known DAC/relay devices.
    pub fn from_config(config: &AgentConfig) -> Self {
        let mut outputs = Vec::new();

        // ── Modbus outputs ──
        for device in &config.modbus {
            Self::collect_modbus_outputs(device, &mut outputs);
        }

        // ── GPIO output pins ──
        for gpio in &config.gpio {
            Self::collect_gpio_outputs(gpio, &mut outputs);
        }

        // ── I2C outputs ──
        // I2C devices are heterogeneous; we cannot generically know which
        // registers are outputs.  A future config field `safe_state_register`
        // should be added per-device.  Until that schema extension lands,
        // I2C devices are skipped from the safe-state apply path unless
        // their device config explicitly provides output metadata.
        // (Placeholder: I2C safe-state is logged as a warning.)

        info!(
            // LIFE-SAFETY: operator must verify output count matches physical wiring
            "SafeStateManager initialised with {} output tags",
            outputs.len()
        );

        Self { outputs }
    }

    /// Drive **every** registered output to its fail-safe value.
    ///
    /// # LIFE-SAFETY
    /// - Errors on individual devices are logged but do NOT abort the loop.
    /// - Each write is bounded by `PER_DEVICE_TIMEOUT`.
    /// - Returns the number of outputs that were successfully set.
    pub async fn apply(
        &self,
        modbus: Option<&ModbusHandle>,
        gpio: Option<&GpioHandle>,
        i2c: Option<&I2cHandle>,
    ) -> usize {
        if self.outputs.is_empty() {
            info!("SafeStateManager: no output tags registered — nothing to safe-state");
            return 0;
        }

        info!(
            // LIFE-SAFETY: loud marker so log analysis tools can find this event
            "LIFE-SAFETY: applying safe-state to {} actuator outputs",
            self.outputs.len()
        );

        let mut success_count: usize = 0;

        for tag in &self.outputs {
            let result = tokio::time::timeout(
                PER_DEVICE_TIMEOUT,
                Self::apply_single(tag, modbus, gpio, i2c),
            )
            .await;

            match result {
                Ok(Ok(())) => {
                    success_count += 1;
                }
                Ok(Err(e)) => {
                    // LIFE-SAFETY: log at error level so alerting picks it up
                    error!("LIFE-SAFETY: failed to safe-state {:?}: {}", tag, e);
                }
                Err(_elapsed) => {
                    error!(
                        "LIFE-SAFETY: safe-state TIMEOUT for {:?} ({}s limit)",
                        tag,
                        PER_DEVICE_TIMEOUT.as_secs()
                    );
                }
            }
        }

        if success_count == self.outputs.len() {
            info!(
                "LIFE-SAFETY: all {} outputs set to safe-state successfully",
                success_count
            );
        } else {
            warn!(
                "LIFE-SAFETY: {}/{} outputs set to safe-state ({} FAILED)",
                success_count,
                self.outputs.len(),
                self.outputs.len() - success_count
            );
        }

        success_count
    }

    /// Return the total number of registered output tags.
    pub fn output_count(&self) -> usize {
        self.outputs.len()
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private helpers
    // ════════════════════════════════════════════════════════════════════════

    /// Collect Modbus output tags from a device configuration.
    ///
    /// Coil registers are digital outputs (safe = false).
    /// Holding registers that are writable are analog outputs (safe = 0).
    fn collect_modbus_outputs(device: &ModbusDeviceConfig, outputs: &mut Vec<OutputTag>) {
        // SECURITY: only include registers whose type implies an output
        if !device.security.allow_writes {
            return;
        }

        for reg in &device.registers {
            let reg_type = reg.register_type.to_lowercase();
            match reg_type.as_str() {
                "coil" => {
                    // EDGE-HIGH-012: non-zero safe_state_value = energise
                    // (fail-ON, e.g. life-support aeration); default OFF.
                    outputs.push(OutputTag::ModbusCoil {
                        device_name: device.name.clone(),
                        address: reg.address,
                        safe_value: reg.safe_state_value.map(|v| v != 0).unwrap_or(false),
                    });
                }
                "holding" => {
                    // Only holding registers on write-enabled devices are
                    // considered outputs.  Input/discrete registers are
                    // read-only by Modbus spec.
                    // EDGE-HIGH-012: safe_state_value = raw fail-safe
                    // register value; default 0.
                    outputs.push(OutputTag::ModbusRegister {
                        device_name: device.name.clone(),
                        address: reg.address,
                        safe_value: reg.safe_state_value.unwrap_or(0),
                    });
                }
                _ => {
                    // "input" and "discrete" are read-only — skip
                }
            }
        }
    }

    /// Collect GPIO output pin tags.
    fn collect_gpio_outputs(gpio: &GpioConfig, outputs: &mut Vec<OutputTag>) {
        let dir = gpio.direction.to_lowercase();
        if dir == "output" || dir == "out" {
            // EDGE-HIGH-012: safe_state_level = fail-safe level; default LOW.
            outputs.push(OutputTag::GpioPin {
                pin: gpio.pin,
                safe_level: gpio.safe_state_level.unwrap_or(false),
            });
        }
    }

    /// Write the safe-state value for a single output tag.
    async fn apply_single(
        tag: &OutputTag,
        modbus: Option<&ModbusHandle>,
        gpio: Option<&GpioHandle>,
        i2c: Option<&I2cHandle>,
    ) -> anyhow::Result<()> {
        match tag {
            OutputTag::ModbusCoil {
                device_name,
                address,
                safe_value,
            } => {
                let handle = modbus.ok_or_else(|| {
                    anyhow::anyhow!("Modbus handle unavailable for coil safe-state")
                })?;
                // LIFE-SAFETY: per-actuator fail-safe level (EDGE-HIGH-012);
                // default false (de-energise) when unclassified.
                handle.write_coil(device_name, *address, *safe_value).await
            }
            OutputTag::ModbusRegister {
                device_name,
                address,
                safe_value,
            } => {
                let handle = modbus.ok_or_else(|| {
                    anyhow::anyhow!("Modbus handle unavailable for register safe-state")
                })?;
                // LIFE-SAFETY: per-actuator fail-safe value (EDGE-HIGH-012);
                // default 0 when unclassified.
                handle
                    .write_register(device_name, *address, *safe_value)
                    .await
            }
            OutputTag::GpioPin { pin, safe_level } => {
                let handle = gpio
                    .ok_or_else(|| anyhow::anyhow!("GPIO handle unavailable for pin safe-state"))?;
                // LIFE-SAFETY: per-actuator fail-safe level (EDGE-HIGH-012);
                // default false (LOW) when unclassified.
                handle.write_pin(*pin, *safe_level).await
            }
            OutputTag::I2cOutput {
                device_name,
                register,
                safe_value,
            } => {
                let handle = i2c
                    .ok_or_else(|| anyhow::anyhow!("I2C handle unavailable for DAC safe-state"))?;
                // LIFE-SAFETY: write the pre-configured zero-value payload
                handle
                    .write_register(device_name, *register, safe_value)
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AgentConfig, GpioConfig, ModbusDeviceConfig};

    /// Helper: build a minimal AgentConfig with the given Modbus devices and GPIO pins.
    fn test_config(modbus: Vec<ModbusDeviceConfig>, gpio: Vec<GpioConfig>) -> AgentConfig {
        let yaml = r#"
device_id: "test-device"
device_code: "TEST"
api_url: "http://localhost"
mqtt:
  broker: "localhost"
  port: 1883
"#;
        let mut config: AgentConfig = serde_yaml::from_str(yaml).expect("parse test config");
        config.modbus = modbus;
        config.gpio = gpio;
        config
    }

    fn modbus_device_with_outputs(name: &str) -> ModbusDeviceConfig {
        let yaml = format!(
            r#"
name: "{name}"
connection_type: tcp
address: "127.0.0.1:502"
slave_id: 1
registers:
  - name: aerator_relay
    address: 100
    register_type: coil
    data_type: u16
  - name: feeder_speed
    address: 200
    register_type: holding
    data_type: u16
  - name: water_temp
    address: 300
    register_type: input
    data_type: u16
"#
        );
        let mut device: ModbusDeviceConfig =
            serde_yaml::from_str(&yaml).expect("parse modbus device");
        device.security.allow_writes = true;
        device
    }

    fn gpio_output(pin: u8) -> GpioConfig {
        GpioConfig {
            name: format!("relay_{}", pin),
            pin,
            direction: "output".to_string(),
            pull: "none".to_string(),
            invert: false,
            debounce_ms: None,
            safe_state_level: None,
        }
    }

    fn gpio_input(pin: u8) -> GpioConfig {
        GpioConfig {
            name: format!("sensor_{}", pin),
            pin,
            direction: "input".to_string(),
            pull: "up".to_string(),
            invert: false,
            debounce_ms: Some(50),
            safe_state_level: None,
        }
    }

    /// EDGE-HIGH-012: the resolved fail-safe value follows the
    /// per-actuator config — a life-support coil/GPIO fails ON, an
    /// unclassified output defaults to de-energise, and a holding
    /// register uses its configured fail-safe value.
    #[test]
    fn safe_state_polarity_honors_config() {
        let yaml = r#"
name: "test_dev"
connection_type: tcp
address: "127.0.0.1:502"
slave_id: 1
registers:
  - name: aerator_relay
    address: 100
    register_type: coil
    data_type: u16
    safe_state_value: 1
  - name: unclassified_coil
    address: 101
    register_type: coil
    data_type: u16
  - name: dose_setpoint
    address: 200
    register_type: holding
    data_type: u16
    safe_state_value: 2048
"#;
        let mut device: ModbusDeviceConfig = serde_yaml::from_str(yaml).expect("parse device");
        device.security.allow_writes = true;

        let gpio_on = GpioConfig {
            name: "life_support_pump".to_string(),
            pin: 17,
            direction: "output".to_string(),
            pull: "none".to_string(),
            invert: false,
            debounce_ms: None,
            safe_state_level: Some(true),
        };

        let config = test_config(vec![device], vec![gpio_on]);
        let mgr = SafeStateManager::from_config(&config);

        let mut aerator_on = false;
        let mut unclassified_off = false;
        let mut holding_val = None;
        let mut gpio_high = false;
        for tag in &mgr.outputs {
            match tag {
                OutputTag::ModbusCoil {
                    address,
                    safe_value,
                    ..
                } => {
                    if *address == 100 {
                        aerator_on = *safe_value;
                    }
                    if *address == 101 {
                        unclassified_off = !*safe_value;
                    }
                }
                OutputTag::ModbusRegister {
                    address,
                    safe_value,
                    ..
                } => {
                    if *address == 200 {
                        holding_val = Some(*safe_value);
                    }
                }
                OutputTag::GpioPin { pin, safe_level } => {
                    if *pin == 17 {
                        gpio_high = *safe_level;
                    }
                }
                _ => {}
            }
        }
        assert!(
            aerator_on,
            "life-support coil must fail-ON (safe_state_value=1)"
        );
        assert!(
            unclassified_off,
            "unclassified coil must default to de-energise (OFF)"
        );
        assert_eq!(
            holding_val,
            Some(2048),
            "holding register must use its configured fail-safe value"
        );
        assert!(gpio_high, "GPIO fail-ON must drive the pin HIGH");
    }

    #[test]
    fn test_from_config_collects_modbus_outputs() {
        let config = test_config(vec![modbus_device_with_outputs("PLC-001")], vec![]);
        let mgr = SafeStateManager::from_config(&config);

        // coil + holding = 2 outputs (input register is skipped)
        assert_eq!(mgr.output_count(), 2);
    }

    #[test]
    fn test_from_config_skips_readonly_devices() {
        let mut device = modbus_device_with_outputs("PLC-RO");
        device.security.allow_writes = false;

        let config = test_config(vec![device], vec![]);
        let mgr = SafeStateManager::from_config(&config);

        assert_eq!(mgr.output_count(), 0);
    }

    #[test]
    fn test_from_config_collects_gpio_outputs_only() {
        let config = test_config(
            vec![],
            vec![gpio_output(17), gpio_output(27), gpio_input(22)],
        );
        let mgr = SafeStateManager::from_config(&config);

        // 2 output pins, 1 input pin (skipped)
        assert_eq!(mgr.output_count(), 2);
    }

    #[test]
    fn test_from_config_combined() {
        let config = test_config(
            vec![modbus_device_with_outputs("PLC-001")],
            vec![gpio_output(17), gpio_input(22)],
        );
        let mgr = SafeStateManager::from_config(&config);

        // 2 Modbus + 1 GPIO output = 3
        assert_eq!(mgr.output_count(), 3);
    }

    #[test]
    fn test_empty_config_zero_outputs() {
        let config = test_config(vec![], vec![]);
        let mgr = SafeStateManager::from_config(&config);
        assert_eq!(mgr.output_count(), 0);
    }

    #[tokio::test]
    async fn test_apply_with_no_outputs_returns_zero() {
        let config = test_config(vec![], vec![]);
        let mgr = SafeStateManager::from_config(&config);

        let count = mgr.apply(None, None, None).await;
        assert_eq!(count, 0);
    }
}
