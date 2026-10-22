//! GPIO support for Raspberry Pi / Revolution Pi
//!
//! Provides digital I/O capabilities for edge devices with GPIO pins.
//! Uses actor pattern to isolate non-Send rppal types.
//! Components communicate with the actor via channels.
//!
//! ## Channel Backpressure (v1.2.0)
//! The channel buffer is configurable and defaults to 64 messages.
//! Send operations include retry logic with exponential backoff.

#[cfg(all(target_os = "linux", feature = "gpio"))]
use anyhow::Context;
use anyhow::Result;
use serde::{Deserialize, Serialize};
#[cfg(all(target_os = "linux", feature = "gpio"))]
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

use crate::config::GpioConfig;
use crate::degraded::ControlGate;
#[cfg(not(all(target_os = "linux", feature = "gpio")))]
use crate::degraded::{Backend, BackendNotCompiled};
use crate::resilience::with_timeout;
use crate::safe_state::SafeStateWrite;

// ============================================================================
// Channel Configuration Constants (v1.2.0)
// ============================================================================

/// Default GPIO command channel buffer size (increased from 32)
const DEFAULT_GPIO_CHANNEL_SIZE: usize = 64;

/// Maximum retry attempts for channel send operations
const GPIO_SEND_RETRIES: u32 = 3;

/// Base delay between retries in milliseconds (doubles each retry)
const GPIO_RETRY_DELAY_MS: u64 = 10;

// ============================================================================
// Public Types
// ============================================================================

/// GPIO pin state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum PinState {
    High,
    #[default]
    Low,
}

impl From<bool> for PinState {
    fn from(value: bool) -> Self {
        if value { PinState::High } else { PinState::Low }
    }
}

impl From<PinState> for bool {
    fn from(state: PinState) -> Self {
        matches!(state, PinState::High)
    }
}

/// GPIO pin value with metadata
#[derive(Debug, Clone, Serialize)]
pub struct GpioPinValue {
    pub name: String,
    pub pin: u8,
    pub direction: String,
    pub state: PinState,
    pub timestamp: String,
}

/// GPIO read result
#[derive(Debug, Clone, Serialize, Default)]
pub struct GpioReadResult {
    pub values: Vec<GpioPinValue>,
    pub errors: Vec<String>,
}

// ============================================================================
// Actor Pattern Types
// ============================================================================

/// Commands sent to the GPIO actor
#[derive(Debug)]
pub enum GpioCommand {
    /// Initialize GPIO hardware
    Init {
        response: oneshot::Sender<Result<()>>,
    },
    /// Read all configured input pins
    ReadAll {
        response: oneshot::Sender<GpioReadResult>,
    },
    /// Read a single pin
    ReadPin {
        pin: u8,
        response: oneshot::Sender<Result<PinState>>,
    },
    /// Write to an output pin
    WritePin {
        pin: u8,
        value: bool,
        response: oneshot::Sender<Result<()>>,
    },
    /// Get pin count
    GetPinCount { response: oneshot::Sender<usize> },
    /// Check if GPIO is available
    IsAvailable { response: oneshot::Sender<bool> },
    /// Reconfigure GPIO (hot-reload)
    Reconfigure {
        configs: Vec<GpioConfig>,
        response: oneshot::Sender<Result<()>>,
    },
}

/// Thread-safe handle to communicate with the GPIO actor
#[derive(Clone)]
pub struct GpioHandle {
    sender: mpsc::Sender<GpioCommand>,
    /// Operation timeout (configurable)
    timeout: Duration,
    /// Channel buffer size (for monitoring, v1.2.0)
    channel_size: usize,
    /// Refuses actuator writes while the agent is degraded (DEC-6.3).
    gate: ControlGate,
}

impl GpioHandle {
    /// Create a new handle and spawn the GPIO actor with default channel size
    ///
    /// Must be called within a LocalSet context on Linux
    /// `timeout_secs` configures the operation timeout (default: 5 seconds)
    pub fn new(configs: Vec<GpioConfig>, timeout_secs: u64, gate: ControlGate) -> Self {
        Self::with_channel_size(configs, timeout_secs, DEFAULT_GPIO_CHANNEL_SIZE, gate)
    }

    /// Create a new handle with custom channel buffer size (v1.2.0)
    ///
    /// # Arguments
    /// * `configs` - GPIO pin configurations
    /// * `timeout_secs` - Operation timeout in seconds
    /// * `channel_size` - Channel buffer size (minimum 16, default 64)
    /// * `gate` - the agent's control gate (degraded mode refuses writes)
    pub fn with_channel_size(
        configs: Vec<GpioConfig>,
        timeout_secs: u64,
        channel_size: usize,
        gate: ControlGate,
    ) -> Self {
        // Ensure minimum buffer size
        let effective_size = channel_size.max(16);
        let (sender, receiver) = mpsc::channel(effective_size);

        // Spawn the actor in a local task (for non-Send rppal types)
        // v1.2.6: JoinHandle intentionally not tracked - actor lifetime tied to LocalSet
        // If actor panics, channel closes and callers receive "actor dead" error
        let _handle = tokio::task::spawn_local(async move {
            let mut actor = GpioActor::new(configs, receiver);
            actor.run().await;
            // If we reach here, channel was closed (shouldn't happen normally)
            tracing::warn!("GPIO actor terminated unexpectedly");
        });

        Self {
            sender,
            timeout: Duration::from_secs(timeout_secs),
            channel_size: effective_size,
            gate,
        }
    }

    /// Get the channel buffer size (v1.2.0)
    pub fn channel_size(&self) -> usize {
        self.channel_size
    }

    /// Send a command asynchronously (awaits until the actor channel has capacity).
    ///
    /// This is a plain async channel send with no retry loop.
    /// For fire-and-forget commands with retry-on-backpressure semantics,
    /// use `try_send_with_retry()` instead.
    #[allow(dead_code)]
    async fn send_async(&self, cmd: GpioCommand) -> Result<(), String> {
        // Blocking send: suspends until the actor channel has capacity.
        match self.sender.send(cmd).await {
            Ok(()) => Ok(()),
            Err(e) => Err(format!("GPIO actor dead: {}", e)),
        }
    }

    /// Try to send a command without blocking, with retries (v1.2.0)
    ///
    /// Used for fire-and-forget commands where we want to avoid blocking
    /// but still handle transient backpressure.
    ///
    /// # v1.3.3: Fixed command loss on final retry exhaustion
    /// Previously, the command would be consumed but not returned on the last
    /// failed attempt. Now we properly preserve the command in the error.
    #[allow(dead_code)]
    async fn try_send_with_retry(&self, mut cmd: GpioCommand) -> Result<(), String> {
        for attempt in 0..GPIO_SEND_RETRIES {
            match self.sender.try_send(cmd) {
                Ok(()) => return Ok(()),
                Err(TrySendError::Full(returned_cmd)) => {
                    // v1.3.3: Always preserve the command for potential retry or logging
                    cmd = returned_cmd;

                    if attempt < GPIO_SEND_RETRIES - 1 {
                        // Exponential backoff: 10ms, 20ms, 40ms
                        let delay = GPIO_RETRY_DELAY_MS * (1 << attempt);
                        debug!(
                            "GPIO channel full, retry {}/{} after {}ms",
                            attempt + 1,
                            GPIO_SEND_RETRIES,
                            delay
                        );
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    } else {
                        // v1.3.3: Log command details before returning error
                        // BUG-014: include command type in the returned Err so callers
                        // can identify which GPIO pin/command failed without needing
                        // to correlate a separate warn! log line.
                        warn!(
                            "GPIO channel full after {} retries (buffer size: {}), command lost: {:?}",
                            GPIO_SEND_RETRIES, self.channel_size, cmd
                        );
                        return Err(format!(
                            "GPIO channel full after {} retries - command dropped: {:?}",
                            GPIO_SEND_RETRIES, cmd
                        ));
                    }
                }
                Err(TrySendError::Closed(_)) => {
                    return Err("GPIO actor dead".to_string());
                }
            }
        }
        // v1.3.3: This should be unreachable, but log if it happens
        warn!("GPIO send failed unexpectedly after loop completion");
        Err("GPIO send failed unexpectedly".to_string())
    }

    /// Initialize GPIO hardware
    pub async fn init(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(GpioCommand::Init { response: tx })
            .await
            .map_err(|_| anyhow::anyhow!("GPIO actor dead"))?;

        with_timeout(rx, self.timeout, "GPIO init")
            .await
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .map_err(|_| anyhow::anyhow!("GPIO actor response error"))?
    }

    /// Read all configured input pins
    pub async fn read_all(&self) -> GpioReadResult {
        let (tx, rx) = oneshot::channel();
        if self
            .sender
            .send(GpioCommand::ReadAll { response: tx })
            .await
            .is_err()
        {
            return GpioReadResult {
                values: vec![],
                errors: vec!["GPIO actor dead".to_string()],
            };
        }

        match with_timeout(rx, self.timeout, "GPIO read_all").await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => GpioReadResult {
                values: vec![],
                errors: vec!["GPIO actor response error".to_string()],
            },
            Err(_) => GpioReadResult {
                values: vec![],
                errors: vec!["GPIO read timeout".to_string()],
            },
        }
    }

    /// Read a single pin
    pub async fn read_pin(&self, pin: u8) -> Result<PinState> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(GpioCommand::ReadPin { pin, response: tx })
            .await
            .map_err(|_| anyhow::anyhow!("GPIO actor dead"))?;

        with_timeout(rx, self.timeout, &format!("GPIO read pin {}", pin))
            .await
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .map_err(|_| anyhow::anyhow!("GPIO actor response error"))?
    }

    /// Write to an output pin. Refused while the agent is degraded.
    pub async fn write_pin(&self, pin: u8, value: bool) -> Result<()> {
        self.gate.permit()?;
        self.send_write(pin, value).await
    }

    /// Drive an output pin to its fail-safe logical level; allowed while
    /// control is disabled, for the safe-state writer only.
    pub async fn drive_safe_level(&self, pin: u8, level: bool, _: &SafeStateWrite) -> Result<()> {
        self.send_write(pin, level).await
    }

    async fn send_write(&self, pin: u8, value: bool) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(GpioCommand::WritePin {
                pin,
                value,
                response: tx,
            })
            .await
            .map_err(|_| anyhow::anyhow!("GPIO actor dead"))?;

        with_timeout(rx, self.timeout, &format!("GPIO write pin {}", pin))
            .await
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .map_err(|_| anyhow::anyhow!("GPIO actor response error"))?
    }

    /// Get configured pin count
    pub async fn pin_count(&self) -> usize {
        let (tx, rx) = oneshot::channel();
        if self
            .sender
            .send(GpioCommand::GetPinCount { response: tx })
            .await
            .is_err()
        {
            return 0;
        }
        rx.await.unwrap_or(0)
    }

    /// Check if GPIO hardware is available
    pub async fn is_available(&self) -> bool {
        let (tx, rx) = oneshot::channel();
        if self
            .sender
            .send(GpioCommand::IsAvailable { response: tx })
            .await
            .is_err()
        {
            return false;
        }
        rx.await.unwrap_or(false)
    }

    /// Reconfigure GPIO pins (hot-reload)
    pub async fn reconfigure(&self, configs: Vec<GpioConfig>) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(GpioCommand::Reconfigure {
                configs,
                response: tx,
            })
            .await
            .map_err(|_| anyhow::anyhow!("GPIO actor dead"))?;

        rx.await
            .map_err(|_| anyhow::anyhow!("GPIO actor response error"))?
    }
}

// ============================================================================
// GPIO Actor Implementation
// ============================================================================

/// The only way this crate makes a pin an output: already at its safe level,
/// and one that keeps that level when the agent lets go of it.
///
/// ADR-048 DEC-13 / EDGE-HIGH-058: rppal's `OutputPin` returns the pin to its
/// previous mode when it is dropped (`reset_on_drop`, on by default). The
/// shutdown sequence drives every output to its safe level and then drops the
/// actor, so with the default every pin went back to an input a moment after
/// it was made safe: a relay board then follows its own pull resistors, and a
/// fail-ON aerator can fall off. With the reset off the safe level stays
/// latched in the pin after the process has exited; what follows (a restart
/// re-acquires the pin at the same level, a reboot is the platform's) is the
/// DEC-13.3 behaviour table. `tests/invariants/gpio_outputs_persist.rs` keeps
/// every other way of building an output pin out of the crate.
#[cfg(all(target_os = "linux", feature = "gpio"))]
fn output_at_safe_level(pin: rppal::gpio::Pin, high: bool) -> rppal::gpio::OutputPin {
    let mut output_pin = if high {
        pin.into_output_high()
    } else {
        pin.into_output_low()
    };
    output_pin.set_reset_on_drop(false);
    output_pin
}

/// GPIO actor that owns the non-Send rppal types.
///
/// ADR-048 DEC-6.3 / INFRA-CRITICAL-236: there is no simulation backend. A
/// build without the Linux `gpio` driver answers every hardware request with
/// [`BackendNotCompiled`], so a configured GPIO fails closed (degraded mode)
/// instead of reporting simulated success.
struct GpioActor {
    configs: Vec<GpioConfig>,
    receiver: mpsc::Receiver<GpioCommand>,
    #[cfg(all(target_os = "linux", feature = "gpio"))]
    gpio: Option<rppal::gpio::Gpio>,
    #[cfg(all(target_os = "linux", feature = "gpio"))]
    input_pins: HashMap<u8, rppal::gpio::InputPin>,
    #[cfg(all(target_os = "linux", feature = "gpio"))]
    output_pins: HashMap<u8, rppal::gpio::OutputPin>,
}

impl GpioActor {
    fn new(configs: Vec<GpioConfig>, receiver: mpsc::Receiver<GpioCommand>) -> Self {
        Self {
            configs,
            receiver,
            #[cfg(all(target_os = "linux", feature = "gpio"))]
            gpio: None,
            #[cfg(all(target_os = "linux", feature = "gpio"))]
            input_pins: HashMap::new(),
            #[cfg(all(target_os = "linux", feature = "gpio"))]
            output_pins: HashMap::new(),
        }
    }

    async fn run(&mut self) {
        info!(
            "GPIO actor started with {} pins configured",
            self.configs.len()
        );

        while let Some(cmd) = self.receiver.recv().await {
            match cmd {
                GpioCommand::Init { response } => {
                    let result = self.init_gpio();
                    if response.send(result).is_err() {
                        warn!("GPIO Init response receiver dropped");
                    }
                }
                GpioCommand::ReadAll { response } => {
                    let result = self.read_all_pins();
                    if response.send(result).is_err() {
                        warn!("GPIO ReadAll response receiver dropped");
                    }
                }
                GpioCommand::ReadPin { pin, response } => {
                    let result = self.read_single_pin(pin);
                    if response.send(result).is_err() {
                        warn!("GPIO ReadPin response receiver dropped");
                    }
                }
                GpioCommand::WritePin {
                    pin,
                    value,
                    response,
                } => {
                    let result = self.write_single_pin(pin, value);
                    if response.send(result).is_err() {
                        warn!("GPIO WritePin response receiver dropped");
                    }
                }
                GpioCommand::GetPinCount { response } => {
                    if response.send(self.configs.len()).is_err() {
                        warn!("GPIO GetPinCount response receiver dropped");
                    }
                }
                GpioCommand::IsAvailable { response } => {
                    if response.send(self.is_gpio_available()).is_err() {
                        warn!("GPIO IsAvailable response receiver dropped");
                    }
                }
                GpioCommand::Reconfigure { configs, response } => {
                    let result = self.reconfigure_pins(configs);
                    if response.send(result).is_err() {
                        warn!("GPIO Reconfigure response receiver dropped");
                    }
                }
            }
        }

        info!("GPIO actor stopped");
    }

    /// Acquire every configured pin, or none.
    ///
    /// EDGE-MEDIUM-075: an output pin is switched to output mode already at
    /// its fail-safe level (`into_output_low` / `into_output_high`), so there
    /// is no instant in which it drives the stale latch value. The pins are
    /// acquired into local maps first and committed only when all of them
    /// were acquired; a failure releases the ones already taken and returns
    /// the error, which puts the agent in degraded mode.
    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn init_gpio(&mut self) -> Result<()> {
        use crate::config::GpioDirection;
        use rppal::gpio::Gpio;

        info!(
            "Initializing GPIO with {} pins configured",
            self.configs.len()
        );

        let gpio = Gpio::new().context("Failed to initialize GPIO")?;
        let mut input_pins = HashMap::new();
        let mut output_pins = HashMap::new();

        for config in &self.configs {
            let pin = gpio
                .get(config.pin)
                .with_context(|| format!("Failed to get GPIO pin {}", config.pin))?;

            match config.direction_kind() {
                Some(GpioDirection::Input) => {
                    info!(
                        "Configuring GPIO pin {} ({}) as input",
                        config.pin, config.name
                    );
                    // rppal 0.17 sets the bias together with the mode.
                    let input_pin = match config.pull.as_str() {
                        "up" => pin.into_input_pullup(),
                        "down" => pin.into_input_pulldown(),
                        _ => pin.into_input(),
                    };
                    input_pins.insert(config.pin, input_pin);
                }
                Some(GpioDirection::Output) => {
                    let high = config.safe_physical_level();
                    info!(
                        "Configuring GPIO pin {} ({}) as output at its safe level {}",
                        config.pin,
                        config.name,
                        if high { "HIGH" } else { "LOW" }
                    );
                    output_pins.insert(config.pin, output_at_safe_level(pin, high));
                }
                None => {
                    anyhow::bail!(
                        "GPIO pin {} ({}) has an invalid direction '{}'",
                        config.pin,
                        config.name,
                        config.direction
                    );
                }
            }
        }

        self.input_pins = input_pins;
        self.output_pins = output_pins;
        self.gpio = Some(gpio);
        info!("GPIO initialized successfully");
        Ok(())
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn init_gpio(&mut self) -> Result<()> {
        Err(anyhow::Error::new(BackendNotCompiled(Backend::Gpio)))
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn read_all_pins(&self) -> GpioReadResult {
        use crate::config::GpioDirection;
        let mut result = GpioReadResult::default();

        // PERF-003: Generate one RFC 3339 timestamp for the entire GPIO read cycle
        // rather than calling Utc::now().to_rfc3339() for each pin.  All pins are
        // read in the same logical snapshot, so a shared cycle timestamp is correct
        // and eliminates N String heap allocations per telemetry cycle.
        let cycle_timestamp = chrono::Utc::now().to_rfc3339();

        for config in &self.configs {
            if config.direction_kind() != Some(GpioDirection::Input) {
                continue;
            }

            if let Some(pin) = self.input_pins.get(&config.pin) {
                let raw_state = if pin.is_high() {
                    PinState::High
                } else {
                    PinState::Low
                };
                let final_state = if config.invert {
                    match raw_state {
                        PinState::High => PinState::Low,
                        PinState::Low => PinState::High,
                    }
                } else {
                    raw_state
                };

                result.values.push(GpioPinValue {
                    name: config.name.clone(),
                    pin: config.pin,
                    direction: config.direction.clone(),
                    state: final_state,
                    timestamp: cycle_timestamp.clone(),
                });
            } else {
                result
                    .errors
                    .push(format!("{}: Pin not initialized", config.name));
            }
        }

        result
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn read_all_pins(&self) -> GpioReadResult {
        use crate::config::GpioDirection;
        let mut result = GpioReadResult::default();
        for config in &self.configs {
            if config.direction_kind() == Some(GpioDirection::Input) {
                result.errors.push(format!(
                    "{}: {}",
                    config.name,
                    BackendNotCompiled(Backend::Gpio)
                ));
            }
        }
        result
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn read_single_pin(&self, pin: u8) -> Result<PinState> {
        if let Some(input_pin) = self.input_pins.get(&pin) {
            let state = if input_pin.is_high() {
                PinState::High
            } else {
                PinState::Low
            };
            Ok(state)
        } else {
            Err(anyhow::anyhow!("Pin {} not configured as input", pin))
        }
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn read_single_pin(&self, _pin: u8) -> Result<PinState> {
        Err(anyhow::Error::new(BackendNotCompiled(Backend::Gpio)))
    }

    #[cfg(all(target_os = "linux", feature = "gpio"))]
    fn write_single_pin(&mut self, pin: u8, value: bool) -> Result<()> {
        if let Some(output_pin) = self.output_pins.get_mut(&pin) {
            // Apply invert logic to write path (v2.1.1 - issue #26 fix)
            let config = self.configs.iter().find(|c| c.pin == pin);
            let actual_value = if config.map(|c| c.invert).unwrap_or(false) {
                !value
            } else {
                value
            };

            if actual_value {
                output_pin.set_high();
            } else {
                output_pin.set_low();
            }
            // v1.2.6: Enhanced GPIO logging for observability
            info!(
                "GPIO WRITE: pin={}, value={} (actual={}, invert={:?})",
                pin,
                value,
                actual_value,
                config.map(|c| c.invert)
            );
            Ok(())
        } else {
            Err(anyhow::anyhow!("Pin {} not configured as output", pin))
        }
    }

    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    fn write_single_pin(&mut self, _pin: u8, _value: bool) -> Result<()> {
        Err(anyhow::Error::new(BackendNotCompiled(Backend::Gpio)))
    }

    fn is_gpio_available(&self) -> bool {
        #[cfg(all(target_os = "linux", feature = "gpio"))]
        {
            self.gpio.is_some()
        }
        #[cfg(not(all(target_os = "linux", feature = "gpio")))]
        {
            false
        }
    }

    fn reconfigure_pins(&mut self, new_configs: Vec<GpioConfig>) -> Result<()> {
        info!("Reconfiguring GPIO with {} pins", new_configs.len());

        // Clear existing state
        #[cfg(all(target_os = "linux", feature = "gpio"))]
        {
            self.input_pins.clear();
            self.output_pins.clear();
            self.gpio = None;
        }

        self.configs = new_configs;
        self.init_gpio()
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_pin_state_conversion() {
        assert_eq!(PinState::from(true), PinState::High);
        assert_eq!(PinState::from(false), PinState::Low);
        assert!(bool::from(PinState::High));
        assert!(!bool::from(PinState::Low));
    }

    #[test]
    fn test_gpio_read_result_default() {
        let result = GpioReadResult::default();
        assert!(result.values.is_empty());
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_default_channel_size() {
        // Verify default channel size constant
        assert_eq!(DEFAULT_GPIO_CHANNEL_SIZE, 64);
        assert!(DEFAULT_GPIO_CHANNEL_SIZE > 32); // Must be larger than old value
    }

    fn pins() -> Vec<GpioConfig> {
        vec![
            GpioConfig {
                name: "pump".into(),
                pin: 17,
                direction: "output".into(),
                pull: "none".into(),
                invert: false,
                debounce_ms: None,
                safe_state_level: Some(true),
            },
            GpioConfig {
                name: "float_switch".into(),
                pin: 22,
                direction: "input".into(),
                pull: "up".into(),
                invert: false,
                debounce_ms: None,
                safe_state_level: None,
            },
        ]
    }

    /// INFRA-CRITICAL-236 / DEC-6.3: a build without the GPIO driver has no
    /// simulation to fall back to. Init, reads and writes all fail with
    /// `BackendNotCompiled`, so the boot enters degraded mode instead of
    /// counting simulated writes as safe outputs.
    #[cfg(not(all(target_os = "linux", feature = "gpio")))]
    #[test]
    fn without_the_driver_gpio_fails_closed() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let dir = tempfile::tempdir().expect("tempdir");
            let degraded = crate::degraded::DegradedMode::new(dir.path().join("h.json"));
            let handle = GpioHandle::new(pins(), 1, degraded.control_gate());
            let err = handle.init().await.expect_err("init must fail closed");
            assert!(
                err.downcast_ref::<BackendNotCompiled>().is_some(),
                "{err:#}"
            );
            assert!(!handle.is_available().await);
            let err = handle
                .write_pin(17, false)
                .await
                .expect_err("no simulated write");
            assert!(
                err.downcast_ref::<BackendNotCompiled>().is_some(),
                "{err:#}"
            );
            let read = handle.read_all().await;
            assert!(read.values.is_empty());
            assert_eq!(read.errors.len(), 1);
            assert!(handle.read_pin(22).await.is_err());
        });
    }

    /// DEC-6.3: while degraded, an actuator write is refused before it
    /// reaches the actor.
    #[test]
    fn degraded_mode_refuses_writes() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let dir = tempfile::tempdir().expect("tempdir");
            let degraded = crate::degraded::DegradedMode::new(dir.path().join("h.json"));
            let handle = GpioHandle::new(pins(), 1, degraded.control_gate());
            degraded.enter(crate::degraded::DegradedReason::IoBudgetExceeded {
                configured: 2,
                cap: 1,
            });
            let err = handle.write_pin(17, true).await.expect_err("refused");
            assert!(
                err.downcast_ref::<crate::degraded::ControlDisabled>()
                    .is_some(),
                "{err:#}"
            );
        });
    }

    #[test]
    fn safe_physical_level_follows_invert() {
        let mut p = pins().remove(0);
        assert!(p.safe_physical_level());
        p.invert = true;
        assert!(!p.safe_physical_level());
        p.safe_state_level = None;
        assert!(p.safe_physical_level());
    }

    #[test]
    fn test_retry_constants() {
        // Verify retry configuration
        assert!(GPIO_SEND_RETRIES >= 2);
        assert!(GPIO_RETRY_DELAY_MS >= 5);
        assert!(GPIO_RETRY_DELAY_MS <= 100); // Not too long
    }
}
