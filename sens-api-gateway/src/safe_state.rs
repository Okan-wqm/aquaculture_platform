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
//! Each output gets up to `PER_DEVICE_TIMEOUT` (longer than the Modbus
//! layer's own in-flight bound) to acknowledge the write.
//! If it fails or times out the error is logged and the next device is tried.
//! A stuck device must never block the rest of the shutdown sequence.
//!
//! # IEC 62443 SL2 FR7 (Availability)
//! This module directly addresses the requirement that a control system must
//! fail to a safe state upon loss of communication or software failure.

use std::time::Duration;
use tracing::{debug, error, info, warn};

use crate::config::{AgentConfig, GpioConfig, ModbusDeviceConfig};
use crate::degraded::{DegradedReason, SafeStateSummary};
use crate::gpio::GpioHandle;
use crate::i2c::I2cHandle;
use crate::modbus::ModbusHandle;
use crate::picontrol::PiControlHandle;

/// Capability to drive an output to its safe value while control is
/// disabled (ADR-048 DEC-6.3).
///
/// The hardware handles refuse every actuator write while the agent is
/// degraded (`degraded::ControlGate`); their `*_safe_state` methods take this
/// token instead. Its field is private to this module, so only
/// [`SafeStateManager::apply`] can construct one: no other code path can use
/// the bypass, and the safe-state writer is the only actuator writer in
/// degraded mode (tier 1).
pub struct SafeStateWrite(());

/// A capability for the tests of the hardware handles, which drive their
/// `*_safe_state` methods directly; production code cannot call this.
#[cfg(test)]
pub(crate) fn test_capability() -> SafeStateWrite {
    SafeStateWrite(())
}

/// One output the safe-state pass could not drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeStateFailure {
    /// Which output (`modbus coil PLC-1/100`, `gpio pin 17`, ...).
    pub output: String,
    /// Why (handle missing, write error, timeout).
    pub error: String,
}

/// Outcome of one safe-state pass (EDGE-HIGH-061, EDGE-MEDIUM-075).
///
/// "No outputs registered" and "every output failed" were both a bare `0`
/// before; the report keeps them apart, so a sensor-only node boots
/// (registered 0, complete) and a partial failure is visible as one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeStateReport {
    pub registered: usize,
    pub applied: usize,
    pub failures: Vec<SafeStateFailure>,
}

impl SafeStateReport {
    /// Every registered output reached its safe value.
    pub fn is_complete(&self) -> bool {
        self.failures.is_empty() && self.applied == self.registered
    }

    /// The reported summary.
    pub fn summary(&self) -> SafeStateSummary {
        SafeStateSummary {
            registered: self.registered,
            applied: self.applied,
            failed: self.failures.len(),
        }
    }

    /// The degraded-mode reason when the pass was incomplete.
    pub fn degraded_reason(&self) -> Option<DegradedReason> {
        if self.is_complete() {
            None
        } else {
            Some(DegradedReason::SafeStateIncomplete {
                registered: self.registered,
                failed: self
                    .failures
                    .iter()
                    .map(|f| format!("{}: {}", f.output, f.error))
                    .collect(),
            })
        }
    }
}

impl OutputTag {
    /// Short description for logs and reports.
    pub fn describe(&self) -> String {
        match self {
            Self::ModbusCoil {
                device_name,
                address,
                ..
            } => format!("modbus coil {device_name}/{address}"),
            Self::ModbusRegister {
                device_name,
                address,
                ..
            } => format!("modbus register {device_name}/{address}"),
            Self::GpioPin { pin, .. } => format!("gpio pin {pin}"),
            Self::I2cOutput {
                device_name,
                register,
                ..
            } => format!("i2c {device_name}/0x{register:02X}"),
            Self::PiControl { tag } => format!("piControl output {tag}"),
        }
    }
}

/// Maximum time to wait for one output's safe-state write.
///
/// LIFE-SAFETY: derived from the slowest backend's own bound — a Modbus
/// write and its read-back ([`crate::modbus::WRITE_IN_FLIGHT_BOUND`]) — plus
/// a second, so a write is never counted as failed while it can still land.
/// The earlier fixed 2 s was shorter than the 5 s Modbus request timeout: on
/// a slow bus the agent reported an output unsafe (and went degraded) while
/// the write then reached the device. A dead bus still fails fast: a
/// request on an unconnected channel is refused at once.
const PER_DEVICE_TIMEOUT: Duration =
    Duration::from_secs(crate::modbus::WRITE_IN_FLIGHT_BOUND.as_secs() + 1);

// Make it impossible to shorten the bound below an in-flight write again.
const _: () = assert!(
    PER_DEVICE_TIMEOUT.as_secs() > crate::modbus::WRITE_IN_FLIGHT_BOUND.as_secs(),
    "the safe-state bound must exceed the Modbus layer's in-flight bound"
);

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
    /// A RevPi process-image output (ADR-048 DEC-8.8). The safe value is the
    /// registry's: the `config.rsc` default of the variable, which the driver
    /// restores on a reset (`Registry::build` refuses any other).
    PiControl { tag: String },
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

        // ── RevPi process-image outputs ──
        if let Some(picontrol) = &config.picontrol {
            for point in &picontrol.points {
                if point.direction == crate::picontrol::config::Direction::Output {
                    outputs.push(OutputTag::PiControl {
                        tag: point.tag_name().to_owned(),
                    });
                }
            }
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
    /// - Works while control is disabled: the writes use the
    ///   [`SafeStateWrite`] capability, not the gated actuator path.
    /// - Returns a report; the boot sequence enters degraded mode unless it
    ///   is complete.
    pub async fn apply(
        &self,
        modbus: Option<&ModbusHandle>,
        gpio: Option<&GpioHandle>,
        i2c: Option<&I2cHandle>,
        picontrol: Option<&PiControlHandle>,
    ) -> SafeStateReport {
        let outputs = self.outputs_now(picontrol);
        if outputs.is_empty() {
            info!("SafeStateManager: no output tags registered — nothing to safe-state");
            return SafeStateReport {
                registered: 0,
                applied: 0,
                failures: Vec::new(),
            };
        }
        let token = SafeStateWrite(());

        info!(
            // LIFE-SAFETY: loud marker so log analysis tools can find this event
            "LIFE-SAFETY: applying safe-state to {} actuator outputs",
            outputs.len()
        );

        let mut success_count: usize = 0;
        let mut failures = Vec::new();

        for tag in &outputs {
            let result = tokio::time::timeout(
                PER_DEVICE_TIMEOUT,
                Self::apply_single(tag, modbus, gpio, i2c, picontrol, &token),
            )
            .await;

            match result {
                Ok(Ok(())) => {
                    success_count += 1;
                }
                Ok(Err(e)) => {
                    // LIFE-SAFETY: log at error level so alerting picks it up
                    error!("LIFE-SAFETY: failed to safe-state {:?}: {}", tag, e);
                    failures.push(SafeStateFailure {
                        output: tag.describe(),
                        error: format!("{e:#}"),
                    });
                }
                Err(_elapsed) => {
                    error!(
                        "LIFE-SAFETY: safe-state TIMEOUT for {:?} ({}s limit)",
                        tag,
                        PER_DEVICE_TIMEOUT.as_secs()
                    );
                    failures.push(SafeStateFailure {
                        output: tag.describe(),
                        error: format!("timeout after {}s", PER_DEVICE_TIMEOUT.as_secs()),
                    });
                }
            }
        }

        if success_count == outputs.len() {
            info!(
                "LIFE-SAFETY: all {} outputs set to safe-state successfully",
                success_count
            );
        } else {
            warn!(
                "LIFE-SAFETY: {}/{} outputs set to safe-state ({} FAILED)",
                success_count,
                outputs.len(),
                outputs.len() - success_count
            );
        }

        SafeStateReport {
            registered: outputs.len(),
            applied: success_count,
            failures,
        }
    }

    /// The outputs to drive now: the boot snapshot, with the RevPi outputs
    /// taken from the handle's proven registry when there is one. A SIGHUP
    /// reload can grant an output after boot (and the driver's reset restored
    /// the defaults of any it dropped), so the registry, not the snapshot, is
    /// what the agent can write and therefore what it must make safe. Without
    /// a handle the configured RevPi outputs stay in the list and fail by
    /// name: an output the agent cannot reach is not made safe.
    fn outputs_now(&self, picontrol: Option<&PiControlHandle>) -> Vec<OutputTag> {
        let Some(handle) = picontrol else {
            return self.outputs.clone();
        };
        self.outputs
            .iter()
            .filter(|o| !matches!(o, OutputTag::PiControl { .. }))
            .cloned()
            .chain(
                handle
                    .output_tags()
                    .into_iter()
                    .map(|tag| OutputTag::PiControl { tag }),
            )
            .collect()
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
    ///
    /// An output is a register the agent can write: it is registered only
    /// when the device's own write policy lets that write through
    /// (`ModbusSecurityConfig::permits_write`), so a registered output is
    /// writable by construction and the pass cannot report a device degraded
    /// for an output the policy never allowed (EDGE-MEDIUM-134).
    fn collect_modbus_outputs(device: &ModbusDeviceConfig, outputs: &mut Vec<OutputTag>) {
        // SECURITY: only include registers whose type implies an output
        if !device.security.allow_writes {
            return;
        }

        for reg in &device.registers {
            let (function_code, tag) = match reg.register_type.to_lowercase().as_str() {
                // EDGE-HIGH-012: non-zero safe_state_value = energise
                // (fail-ON, e.g. life-support aeration); default OFF.
                "coil" => (
                    crate::modbus::FC_WRITE_SINGLE_COIL,
                    OutputTag::ModbusCoil {
                        device_name: device.name.clone(),
                        address: reg.address,
                        safe_value: reg.safe_state_value.map(|v| v != 0).unwrap_or(false),
                    },
                ),
                // Only holding registers on write-enabled devices are
                // outputs; input/discrete registers are read-only by Modbus
                // spec. EDGE-HIGH-012: safe_state_value = raw fail-safe
                // register value; default 0.
                "holding" => (
                    crate::modbus::FC_WRITE_SINGLE_REGISTER,
                    OutputTag::ModbusRegister {
                        device_name: device.name.clone(),
                        address: reg.address,
                        safe_value: reg.safe_state_value.unwrap_or(0),
                    },
                ),
                _ => continue,
            };
            if device.security.permits_write(function_code, reg.address) {
                outputs.push(tag);
            } else {
                debug!(
                    "Modbus {}/{}: the write policy does not permit FC{} here; not a \
                     safe-state output",
                    device.name, reg.address, function_code
                );
            }
        }
    }

    /// Collect GPIO output pin tags.
    fn collect_gpio_outputs(gpio: &GpioConfig, outputs: &mut Vec<OutputTag>) {
        if gpio.is_output() {
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
        picontrol: Option<&PiControlHandle>,
        token: &SafeStateWrite,
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
                handle
                    .write_coil_safe_state(device_name, *address, *safe_value, token)
                    .await
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
                    .write_register_safe_state(device_name, *address, *safe_value, token)
                    .await
            }
            OutputTag::GpioPin { pin, safe_level } => {
                let handle = gpio
                    .ok_or_else(|| anyhow::anyhow!("GPIO handle unavailable for pin safe-state"))?;
                // LIFE-SAFETY: per-actuator fail-safe level (EDGE-HIGH-012);
                // default false (LOW) when unclassified.
                handle.drive_safe_level(*pin, *safe_level, token).await
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
                    .write_register_safe_state(device_name, *register, safe_value, token)
                    .await
            }
            OutputTag::PiControl { tag } => {
                let handle = picontrol.ok_or_else(|| {
                    anyhow::anyhow!("piControl handle unavailable for the output safe-state")
                })?;
                // The safe value is the registry's (the config.rsc default);
                // a stale layout refuses the drive rather than guess an address.
                handle
                    .drive_safe(tag, token)
                    .map(|_| ())
                    .map_err(anyhow::Error::new)
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic, clippy::indexing_slicing)]
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
        // A valid write policy (`AgentConfig::validate`): writes on, every
        // address opted in.
        device.security.allow_writes = true;
        device.security.allow_all_write_addresses = true;
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
        device.security.allow_all_write_addresses = true;

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

    /// EDGE-MEDIUM-134: an output is registered only when the device's write
    /// policy lets the write through, so every registered output is writable
    /// by construction (an address outside the allowed ranges is not one the
    /// agent can move, hence not one it must make safe).
    #[test]
    fn only_registers_the_write_policy_permits_are_outputs() {
        let mut device = modbus_device_with_outputs("PLC-RANGE");
        device.security.allow_all_write_addresses = false;
        device.security.allowed_write_ranges = vec![(100, 110)];
        let mgr = SafeStateManager::from_config(&test_config(vec![device], vec![]));
        // coil 100 is inside the range; holding 200 is outside it.
        assert_eq!(mgr.output_count(), 1);
        assert!(matches!(
            mgr.outputs.first(),
            Some(OutputTag::ModbusCoil { address: 100, .. })
        ));
    }

    #[test]
    fn an_explicit_whitelist_without_fc5_registers_no_coil() {
        let mut device = modbus_device_with_outputs("PLC-FC6");
        device.security.allowed_function_codes = vec![1, 2, 3, 4, 6];
        let mgr = SafeStateManager::from_config(&test_config(vec![device], vec![]));
        assert_eq!(mgr.output_count(), 1);
        assert!(matches!(
            mgr.outputs.first(),
            Some(OutputTag::ModbusRegister { address: 200, .. })
        ));
    }

    /// The default (read-only) whitelist with `allow_writes: true` registers
    /// both kinds: the write policy completes it (the combination that used
    /// to register outputs it could never write).
    #[test]
    fn allow_writes_with_the_default_whitelist_registers_both_kinds() {
        let device = modbus_device_with_outputs("PLC-DEFAULT");
        assert_eq!(device.security.allowed_function_codes, vec![1, 2, 3, 4]);
        let mgr = SafeStateManager::from_config(&test_config(vec![device], vec![]));
        assert_eq!(mgr.output_count(), 2);
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

    /// EDGE-HIGH-061: a node with no writable outputs (sensor-only Modbus,
    /// input-only GPIO) has nothing to drive, and that is complete — not a
    /// failure that aborts the boot.
    #[tokio::test]
    async fn no_registered_outputs_is_a_complete_pass() {
        let mut ro = modbus_device_with_outputs("SENSORS");
        ro.security.allow_writes = false;
        let config = test_config(vec![ro], vec![gpio_input(22)]);
        let mgr = SafeStateManager::from_config(&config);

        let report = mgr.apply(None, None, None, None).await;
        assert_eq!(report.registered, 0);
        assert_eq!(report.applied, 0);
        assert!(report.is_complete());
        assert!(report.degraded_reason().is_none());
    }

    /// EDGE-MEDIUM-075: when only some outputs reach safe-state the report
    /// says which did not, and that is a degraded-mode reason.
    #[tokio::test]
    async fn a_missing_handle_fails_its_outputs_and_names_them() {
        let config = test_config(
            vec![modbus_device_with_outputs("PLC-001")],
            vec![gpio_output(17)],
        );
        let mgr = SafeStateManager::from_config(&config);

        // No handle at all: all three outputs fail, each by name.
        let report = mgr.apply(None, None, None, None).await;
        assert_eq!(report.registered, 3);
        assert_eq!(report.applied, 0);
        assert!(!report.is_complete());
        let names: Vec<&str> = report.failures.iter().map(|f| f.output.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "modbus coil PLC-001/100",
                "modbus register PLC-001/200",
                "gpio pin 17"
            ]
        );
        match report.degraded_reason() {
            Some(DegradedReason::SafeStateIncomplete { registered, failed }) => {
                assert_eq!(registered, 3);
                assert_eq!(failed.len(), 3);
            }
            other => panic!("expected SafeStateIncomplete, got {other:?}"),
        }
        assert_eq!(report.summary().failed, 3);
    }

    /// Direction parsing is shared with config validation: an `OUT` pin is
    /// an output for the registry exactly as it is for the validator and the
    /// GPIO init.
    #[test]
    fn upper_case_out_is_an_output() {
        let mut pin = gpio_output(5);
        pin.direction = "OUT".to_string();
        let config = test_config(vec![], vec![pin]);
        assert_eq!(SafeStateManager::from_config(&config).output_count(), 1);
    }

    // ---- RevPi process-image outputs (ADR-048 DEC-8.8) ---------------------

    mod picontrol {
        use std::sync::Arc;

        use super::*;
        use crate::degraded::DegradedMode;
        use crate::picontrol::device::Opener;
        use crate::picontrol::fake::FakeKernel;
        use crate::picontrol::rsc::sample;
        use crate::picontrol::{PiControlConfig, PiControlHandle, RscSource};
        use crate::scripting::force_registry::ForceRegistry;

        const GRANT: &str = r#"
output_watchdog_ms: 1000
points:
  - tag: pump
    variable: O_1
    direction: output
  - tag: aerator
    variable: O_2
    direction: output
    safe_state_value: 1
  - tag: in_1
    variable: I_1
"#;

        fn config() -> AgentConfig {
            let mut config = test_config(vec![], vec![]);
            config.picontrol = Some(serde_yaml::from_str(GRANT).unwrap());
            config
        }

        fn handle(kernel: &Arc<FakeKernel>, dir: &std::path::Path) -> PiControlHandle {
            let degraded = DegradedMode::new(dir.join("health.json"));
            let k = kernel.clone();
            let opener: Opener = Arc::new(move || Ok(k.open()));
            let grant: PiControlConfig = serde_yaml::from_str(GRANT).unwrap();
            PiControlHandle::open(
                &grant,
                250,
                RscSource::Verified(sample::rsc().into_bytes().into()),
                degraded.control_gate(),
                Arc::new(ForceRegistry::new()),
                opener,
            )
            .unwrap()
        }

        #[test]
        fn only_the_outputs_of_the_section_are_registered() {
            let mgr = SafeStateManager::from_config(&config());
            assert_eq!(mgr.output_count(), 2, "the input point is not an output");
        }

        #[tokio::test]
        async fn the_pass_drives_every_output_to_the_default_config_rsc_restores() {
            let dir = tempfile::tempdir().unwrap();
            let kernel = FakeKernel::sample();
            let handle = handle(&kernel, dir.path());
            // The agent drove pump on and aerator off: the opposite of both safe values.
            handle.write_output("pump", 1.0).await.unwrap();
            handle.write_output("aerator", 0.0).await.unwrap();
            assert_eq!(kernel.peek(122) & 0b11, 0b01);

            let report = SafeStateManager::from_config(&config())
                .apply(None, None, None, Some(&handle))
                .await;
            assert!(report.is_complete(), "{:?}", report.failures);
            assert_eq!((report.registered, report.applied), (2, 2));
            assert_eq!(
                kernel.peek(122) & 0b11,
                0b10,
                "pump off, the life-support aerator on"
            );
        }

        #[tokio::test]
        async fn an_output_a_reload_granted_after_boot_is_driven_too() {
            let dir = tempfile::tempdir().unwrap();
            let kernel = FakeKernel::sample();
            // Booted with `pump` alone: the manager's snapshot lists one output.
            let boot: PiControlConfig = serde_yaml::from_str(
                "output_watchdog_ms: 1000\npoints:\n  - tag: pump\n    variable: O_1\n    direction: output\n",
            )
            .unwrap();
            let degraded = DegradedMode::new(dir.path().join("health.json"));
            let k = kernel.clone();
            let opener: Opener = Arc::new(move || Ok(k.open()));
            let handle = PiControlHandle::open(
                &boot,
                250,
                RscSource::Verified(sample::rsc().into_bytes().into()),
                degraded.control_gate(),
                Arc::new(ForceRegistry::new()),
                opener,
            )
            .unwrap();
            let mut snapshot = test_config(vec![], vec![]);
            snapshot.picontrol = Some(boot);
            let manager = SafeStateManager::from_config(&snapshot);
            assert_eq!(manager.output_count(), 1);

            // A verified reload grants the life-support aerator as well.
            handle
                .reload(
                    &serde_yaml::from_str(GRANT).unwrap(),
                    250,
                    RscSource::Verified(sample::rsc().into_bytes().into()),
                )
                .unwrap();
            handle.write_output("aerator", 0.0).await.unwrap();
            assert_eq!(kernel.peek(122) & 0b10, 0);

            let report = manager.apply(None, None, None, Some(&handle)).await;
            assert!(report.is_complete(), "{:?}", report.failures);
            assert_eq!((report.registered, report.applied), (2, 2));
            assert_eq!(
                kernel.peek(122) & 0b10,
                0b10,
                "the aerator the boot snapshot never listed is on"
            );
        }

        #[tokio::test]
        async fn without_the_handle_the_outputs_fail_by_name() {
            let report = SafeStateManager::from_config(&config())
                .apply(None, None, None, None)
                .await;
            let names: Vec<&str> = report.failures.iter().map(|f| f.output.as_str()).collect();
            assert_eq!(names, ["piControl output pump", "piControl output aerator"]);
            assert!(!report.is_complete());
        }

        #[tokio::test]
        async fn an_unproven_layout_refuses_to_guess_an_address() {
            let dir = tempfile::tempdir().unwrap();
            let kernel = FakeKernel::sample();
            let handle = handle(&kernel, dir.path());
            // The driver is reset to a layout the signed file does not describe.
            let moved = sample::rsc().replace("\"offset\": 100", "\"offset\": 104");
            kernel.reset_driver_with(
                &crate::picontrol::rsc::ProcessMap::parse(moved.as_bytes()).unwrap(),
            );
            let start = std::time::Instant::now();
            while handle.stale_reason().is_none() {
                assert!(start.elapsed() < std::time::Duration::from_secs(5));
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            kernel.clear_written_ranges();
            let report = SafeStateManager::from_config(&config())
                .apply(None, None, None, Some(&handle))
                .await;
            assert_eq!(report.applied, 0);
            assert!(
                report.failures[0].error.contains("not verified"),
                "{:?}",
                report.failures
            );
            assert!(
                kernel.written_ranges().is_empty(),
                "nothing was written to a guessed address"
            );
        }
    }
}
