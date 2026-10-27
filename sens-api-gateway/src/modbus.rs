//! Modbus TCP/RTU client for PLC communication
//!
//! Supports reading/writing Modbus registers from industrial PLCs
//! and sensor controllers.
//!
//! Uses actor pattern to isolate non-Send Modbus client types.
//! Components communicate with the actor via channels.
//!
//! Features:
//! - Circuit breaker for fault tolerance
//! - Timeouts on all operations
//! - Parallel device reads (v1.2.0)
//! - TLS support for encrypted Modbus/TCP (v1.2.0 - IEC 62443 SL2 FR4)
//!
//! ## Parallel vs Sequential Reads (v1.2.0)
//! - `read_all()`: Sequential reads (backwards compatible, simpler error handling)
//! - `read_all_parallel()`: Concurrent reads across multiple devices (better latency)
//!
//! ## TLS Support (v1.2.0)
//! When `tls.enabled = true` in device config, connections use encrypted TLS.
//! This provides IEC 62443 SL2 FR4 (Data Confidentiality) compliance.
//!
//! ## Transport
//! `tokio-modbus` provides the Modbus/TCP and RTU framing; this module owns the
//! transport underneath it:
//! - plain TCP, or Modbus/TCP Security over `tokio-rustls` (server-only TLS or
//!   mTLS, TLS 1.2 floor, PLC certificate verified against the configured CA)
//! - RTU over `tokio-serial`
//! - automatic re-open of a dropped transport with doubling backoff (2 s → 30 s)
//!   — see [`Link`]

use anyhow::{Context, Result};
use futures::future::join_all;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::Instant;
use tokio_modbus::Slave;
use tokio_modbus::client::{Client as _, Context as ModbusContext, Reader as _, Writer as _, tcp};
use tokio_rustls::TlsConnector;
use tracing::{debug, error, info, warn};

use crate::config::{ByteOrder, ModbusDeviceConfig, ModbusRegisterConfig, ModbusSecurityConfig};
use crate::resilience::{CircuitBreaker, RateLimiter, with_timeout};

/// Default timeout for Modbus operations
const MODBUS_TIMEOUT: Duration = Duration::from_secs(5);
/// Default connection timeout
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Circuit breaker failure threshold
const CIRCUIT_BREAKER_THRESHOLD: u32 = 3;
/// Circuit breaker recovery timeout
const CIRCUIT_BREAKER_RECOVERY: Duration = Duration::from_secs(30);

// Modbus Function Codes (IEC 62443 SL2 FR3: Whitelisting)
/// FC 1: Read Coils
const FC_READ_COILS: u8 = 1;
/// FC 2: Read Discrete Inputs
const FC_READ_DISCRETE_INPUTS: u8 = 2;
/// FC 3: Read Holding Registers
const FC_READ_HOLDING_REGISTERS: u8 = 3;
/// FC 4: Read Input Registers
const FC_READ_INPUT_REGISTERS: u8 = 4;
/// FC 5: Write Single Coil
const FC_WRITE_SINGLE_COIL: u8 = 5;
/// FC 6: Write Single Register
const FC_WRITE_SINGLE_REGISTER: u8 = 6;
/// v1.2.6: Maximum errors to collect per read operation (prevents unbounded growth)
const MAX_ERRORS_PER_READ: usize = 50;
// FC 15, 16 (Write Multiple) not implemented - use single writes

/// TLS versions offered on Modbus/TCP Security links. The Modbus/TCP Security
/// specification sets TLS 1.2 as the floor; TLS 1.3 is negotiated whenever the
/// PLC supports it.
const MODBUS_TLS_VERSIONS: &[&rustls::SupportedProtocolVersion] =
    &[&rustls::version::TLS13, &rustls::version::TLS12];

// ============================================================================
// Actor Pattern Types
// ============================================================================

/// Commands sent to the Modbus actor
#[derive(Debug)]
pub enum ModbusCommand {
    /// Connect to all configured devices
    ConnectAll {
        response: oneshot::Sender<Vec<String>>,
    },
    /// Disconnect all devices
    DisconnectAll { response: oneshot::Sender<()> },
    /// Read all registers from all devices (sequential)
    ReadAll {
        response: oneshot::Sender<Vec<ModbusReadResult>>,
    },
    /// Read all registers from all devices (parallel, v1.2.0)
    ReadAllParallel {
        response: oneshot::Sender<Vec<ModbusReadResult>>,
    },
    /// Write a register value
    WriteRegister {
        device_name: String,
        address: u16,
        value: u16,
        response: oneshot::Sender<Result<ModbusWriteReceipt>>,
    },
    /// Write a coil value
    WriteCoil {
        device_name: String,
        address: u16,
        value: bool,
        response: oneshot::Sender<Result<()>>,
    },
    /// Get device count
    DeviceCount { response: oneshot::Sender<usize> },
    /// Provision (add or replace) a device at runtime — additive hot-reload.
    ///
    /// Unlike a destructive full reconfigure, this touches ONLY the named
    /// device; every other live drive/sensor keeps its connection. Backs
    /// runtime VFD provisioning (SENSOR-CRITICAL-007) so a tenant-added drive
    /// reaches the edge without a reboot. Boxed to keep the enum variant small
    /// (ModbusDeviceConfig is large).
    ProvisionDevice {
        config: Box<ModbusDeviceConfig>,
        response: oneshot::Sender<Result<()>>,
    },
    /// Decommission (remove + disconnect) a device by name at runtime.
    DecommissionDevice {
        device_name: String,
        response: oneshot::Sender<bool>,
    },
}

/// Thread-safe handle to communicate with the Modbus actor
#[derive(Clone)]
pub struct ModbusHandle {
    sender: mpsc::Sender<ModbusCommand>,
}

impl ModbusHandle {
    /// Create a new handle and spawn the actor
    pub fn new(configs: Vec<ModbusDeviceConfig>) -> Self {
        let (sender, receiver) = mpsc::channel(32);

        // Spawn the actor in a local task (will be run via LocalSet)
        // v1.2.6: JoinHandle intentionally not tracked - actor lifetime tied to LocalSet
        // If actor panics, channel closes and callers receive send error
        let _handle = tokio::task::spawn_local(async move {
            let mut actor = ModbusActor::new(configs, receiver);
            actor.run().await;
            // If we reach here, channel was closed (shouldn't happen normally)
            tracing::warn!("Modbus actor terminated unexpectedly");
        });

        Self { sender }
    }

    /// Connect to all devices
    pub async fn connect_all(&self) -> Vec<String> {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::ConnectAll { response: tx })
            .await;
        rx.await
            .unwrap_or_else(|_| vec!["Actor disconnected".to_string()])
    }

    /// Disconnect all devices
    pub async fn disconnect_all(&self) {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::DisconnectAll { response: tx })
            .await;
        let _ = rx.await;
    }

    /// Read all registers from all devices (sequential)
    pub async fn read_all(&self) -> Vec<ModbusReadResult> {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::ReadAll { response: tx })
            .await;
        rx.await.unwrap_or_default()
    }

    /// Read all registers from all devices (parallel, v1.2.0)
    ///
    /// Reads from multiple devices concurrently for lower overall latency.
    /// Uses `join_all` to execute all device reads simultaneously.
    pub async fn read_all_parallel(&self) -> Vec<ModbusReadResult> {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::ReadAllParallel { response: tx })
            .await;
        rx.await.unwrap_or_default()
    }

    /// Write a register value and return protocol/readback evidence.
    pub async fn write_register_checked(
        &self,
        device_name: &str,
        address: u16,
        value: u16,
    ) -> Result<ModbusWriteReceipt> {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::WriteRegister {
                device_name: device_name.to_string(),
                address,
                value,
                response: tx,
            })
            .await;
        rx.await
            .map_err(|_| anyhow::anyhow!("Actor disconnected"))?
    }

    /// Write a register value.
    pub async fn write_register(&self, device_name: &str, address: u16, value: u16) -> Result<()> {
        self.write_register_checked(device_name, address, value)
            .await
            .map(|_| ())
    }

    /// Write a coil value
    pub async fn write_coil(&self, device_name: &str, address: u16, value: bool) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::WriteCoil {
                device_name: device_name.to_string(),
                address,
                value,
                response: tx,
            })
            .await;
        rx.await
            .map_err(|_| anyhow::anyhow!("Actor disconnected"))?
    }

    /// Get device count
    pub async fn device_count(&self) -> usize {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::DeviceCount { response: tx })
            .await;
        rx.await.unwrap_or(0)
    }

    /// Provision (add or replace) a Modbus device on the running actor.
    ///
    /// Additive hot-reload: only the named device is (re)created and connected;
    /// every other live device keeps its connection. Returns `Ok(())` when the
    /// new client connected, or the connect error when the device was registered
    /// but its socket is not yet up (a later read/reconnect retries). The write
    /// path still enforces `allow_writes` + `allowed_write_ranges` per request,
    /// so provisioning never widens write authority on its own.
    pub async fn provision_device(&self, config: ModbusDeviceConfig) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::ProvisionDevice {
                config: Box::new(config),
                response: tx,
            })
            .await;
        rx.await
            .map_err(|_| anyhow::anyhow!("Actor disconnected"))?
    }

    /// Decommission (remove + disconnect) a device by name on the running actor.
    /// Returns true when a device was removed.
    pub async fn decommission_device(&self, device_name: &str) -> bool {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .sender
            .send(ModbusCommand::DecommissionDevice {
                device_name: device_name.to_string(),
                response: tx,
            })
            .await;
        rx.await.unwrap_or(false)
    }
}

/// Modbus actor that owns the non-Send client types
struct ModbusActor {
    manager: ModbusManager,
    receiver: mpsc::Receiver<ModbusCommand>,
}

impl ModbusActor {
    fn new(configs: Vec<ModbusDeviceConfig>, receiver: mpsc::Receiver<ModbusCommand>) -> Self {
        Self {
            manager: ModbusManager::new(configs),
            receiver,
        }
    }

    async fn run(&mut self) {
        info!("Modbus actor started");

        while let Some(cmd) = self.receiver.recv().await {
            match cmd {
                ModbusCommand::ConnectAll { response } => {
                    let errors = self.manager.connect_all().await;
                    if response.send(errors).is_err() {
                        warn!("Modbus ConnectAll response receiver dropped");
                    }
                }
                ModbusCommand::DisconnectAll { response } => {
                    self.manager.disconnect_all().await;
                    if response.send(()).is_err() {
                        warn!("Modbus DisconnectAll response receiver dropped");
                    }
                }
                ModbusCommand::ReadAll { response } => {
                    let results = self.manager.read_all().await;
                    if response.send(results).is_err() {
                        warn!("Modbus ReadAll response receiver dropped");
                    }
                }
                ModbusCommand::ReadAllParallel { response } => {
                    let results = self.manager.read_all_parallel().await;
                    if response.send(results).is_err() {
                        warn!("Modbus ReadAllParallel response receiver dropped");
                    }
                }
                ModbusCommand::WriteRegister {
                    device_name,
                    address,
                    value,
                    response,
                } => {
                    // v1.2.3: Use async get_client_by_name for reliable lookup
                    let result = if let Some(client_arc) =
                        self.manager.get_client_by_name(&device_name).await
                    {
                        let mut client = client_arc.lock().await;
                        client.write_register(address, value).await
                    } else {
                        Err(anyhow::anyhow!("Device not found: {}", device_name))
                    };
                    if response.send(result).is_err() {
                        warn!("Modbus WriteRegister response receiver dropped");
                    }
                }
                ModbusCommand::WriteCoil {
                    device_name,
                    address,
                    value,
                    response,
                } => {
                    // v1.2.3: Use async get_client_by_name for reliable lookup
                    let result = if let Some(client_arc) =
                        self.manager.get_client_by_name(&device_name).await
                    {
                        let mut client = client_arc.lock().await;
                        client.write_coil(address, value).await
                    } else {
                        Err(anyhow::anyhow!("Device not found: {}", device_name))
                    };
                    if response.send(result).is_err() {
                        warn!("Modbus WriteCoil response receiver dropped");
                    }
                }
                ModbusCommand::DeviceCount { response } => {
                    if response.send(self.manager.device_count()).is_err() {
                        warn!("Modbus DeviceCount response receiver dropped");
                    }
                }
                ModbusCommand::ProvisionDevice { config, response } => {
                    let result = match self.manager.add_or_replace_device(*config).await {
                        None => Ok(()),
                        Some(err) => Err(anyhow::anyhow!(err)),
                    };
                    if response.send(result).is_err() {
                        warn!("Modbus ProvisionDevice response receiver dropped");
                    }
                }
                ModbusCommand::DecommissionDevice {
                    device_name,
                    response,
                } => {
                    let removed = self.manager.remove_device(&device_name).await;
                    if response.send(removed).is_err() {
                        warn!("Modbus DecommissionDevice response receiver dropped");
                    }
                }
            }
        }

        info!("Modbus actor stopped");
    }
}

// ============================================================================
// Core Modbus Types
// ============================================================================

/// Reconnect schedule for a dropped Modbus transport: wait `min`, then double
/// the wait after every failed re-open, up to `max`.
#[derive(Debug, Clone, Copy)]
struct ReconnectPolicy {
    min: Duration,
    max: Duration,
}

impl ReconnectPolicy {
    const DEFAULT: Self = Self {
        min: Duration::from_secs(2),
        max: Duration::from_secs(30),
    };

    /// A down link whose next open attempt is `wait` from now. If that attempt
    /// fails, the following one waits twice as long (clamped to `min..=max`).
    fn down_after(self, wait: Duration) -> Link {
        Link::Down {
            retry_at: Instant::now() + wait,
            next_delay: wait.saturating_mul(2).clamp(self.min, self.max),
        }
    }
}

/// An open Modbus transport.
struct LiveLink {
    ctx: ModbusContext,
    /// True while a request awaits its response. A request future dropped
    /// mid-flight (outer timeout) leaves it set, and that request's late reply
    /// can still arrive on this stream — RTU frames carry no transaction id to
    /// reject it — so the next request retires the transport instead of
    /// reusing it.
    in_flight: bool,
}

/// Connection state of one Modbus device.
enum Link {
    /// Never connected, or disconnected on request. Never re-opened
    /// automatically.
    Idle,
    /// Transport open.
    Up(LiveLink),
    /// Transport lost or failed to open; the first request at or after
    /// `retry_at` re-opens it.
    Down {
        retry_at: Instant,
        next_delay: Duration,
    },
}

/// Run one request on the device's live transport: re-open the transport if
/// due (see [`Link`]), bound the request by `MODBUS_TIMEOUT`, mark it in
/// flight for the duration, and classify the outcome via `settle_outcome`.
macro_rules! modbus_request {
    ($client:expr, $op:expr, |$ctx:ident| $call:expr) => {{
        let live = $client.live_transport().await?;
        live.in_flight = true;
        let $ctx = &mut live.ctx;
        let outcome = tokio::time::timeout(MODBUS_TIMEOUT, $call).await;
        live.in_flight = false;
        $client.settle_outcome($op, outcome)
    }};
}

/// Modbus client wrapper with circuit breaker and rate limiter
///
/// # Security Features (IEC 62443 SL2)
/// - FR3: Function code whitelist validation
/// - FR4: TLS encryption for data confidentiality (v1.2.0)
/// - FR5: Rate limiting to prevent resource exhaustion
pub struct ModbusClient {
    /// Device configuration (without registers to avoid large clones)
    config: ModbusDeviceConfig,
    /// Register configurations (Arc to avoid cloning on every read)
    registers: Arc<Vec<ModbusRegisterConfig>>,
    /// Security configuration
    security: ModbusSecurityConfig,
    /// Transport state (see [`Link`])
    link: Link,
    /// Re-open schedule for a dropped transport
    reconnect: ReconnectPolicy,
    /// Unit ID (slave ID) for Modbus requests
    slave: Slave,
    /// Circuit breaker for fault tolerance
    circuit_breaker: CircuitBreaker,
    /// Read rate limiter (FC1–FC4): 10 ops/sec, burst 20
    rate_limiter: RateLimiter,
    /// Write rate limiter (FC5, FC6) — intentionally more restrictive than reads.
    /// Limits FC5/FC6 to 2 ops/sec (burst 4) to prevent runaway scripts from
    /// causing physical actuator damage on the factory floor (IEC 62443 SL2 FR5).
    write_rate_limiter: RateLimiter,
}

/// Register value with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterValue {
    pub name: String,
    pub address: u16,
    pub raw_value: u16,
    pub scaled_value: f64,
    pub unit: Option<String>,
    pub timestamp: String,
}

/// Modbus read result
#[derive(Debug, Clone, Serialize)]
pub struct ModbusReadResult {
    pub device_name: String,
    pub values: Vec<RegisterValue>,
    pub errors: Vec<String>,
}

/// Evidence returned by a Modbus FC6 register write.
///
/// 2026-04-29: Separates protocol ACK from physical/logical verification. A
/// successful write response alone is not enough for safety-critical actuators;
/// readback fields show whether the target register was verified after ACK.
#[derive(Debug, Clone, Serialize)]
pub struct ModbusWriteReceipt {
    pub device_name: String,
    pub address: u16,
    pub requested_value: u16,
    pub protocol_ack: bool,
    pub readback_enabled: bool,
    pub readback_verified: bool,
    pub readback_value: Option<u16>,
}

impl ModbusClient {
    /// Create a new Modbus client (not connected)
    pub fn new(config: ModbusDeviceConfig) -> Self {
        // v1.2.6: Warn if no registers configured (wasteful resource allocation)
        if config.registers.is_empty() {
            warn!(
                device = %config.name,
                "Modbus device configured with no registers - polling will be skipped"
            );
        }

        let circuit_breaker = CircuitBreaker::new(
            format!("modbus-{}", config.name),
            CIRCUIT_BREAKER_THRESHOLD,
            CIRCUIT_BREAKER_RECOVERY,
        );

        // Read rate limiter from security config (FC1–FC4)
        let rate_limiter = RateLimiter::new(
            format!("modbus-rate-{}", config.name),
            config.security.rate_limit_burst,
            config.security.rate_limit_ops_per_sec,
        );

        // Write rate limiter (FC5, FC6) — intentionally more restrictive.
        // 2 ops/sec with burst 4 prevents runaway scripts from overwhelming actuators.
        let write_rate_limiter = RateLimiter::new(
            format!("modbus-write-rate-{}", config.name),
            4, // burst
            2, // ops/sec
        );

        // Store registers in Arc to avoid cloning on every read
        let registers = Arc::new(config.registers.clone());
        let security = config.security.clone();

        // Create unit ID from slave ID
        let slave = Slave(config.slave_id);

        Self {
            config,
            registers,
            security,
            link: Link::Idle,
            reconnect: ReconnectPolicy::DEFAULT,
            slave,
            circuit_breaker,
            rate_limiter,
            write_rate_limiter,
        }
    }

    /// Validate function code against whitelist
    ///
    /// # Security
    /// IEC 62443 SL2 FR3: Only allow pre-approved function codes
    fn validate_function_code(&self, function_code: u8) -> Result<()> {
        if !self.security.enabled {
            return Ok(());
        }

        if self
            .security
            .allowed_function_codes
            .contains(&function_code)
        {
            Ok(())
        } else {
            warn!(
                "Modbus function code {} denied for device '{}' (whitelist: {:?})",
                function_code, self.config.name, self.security.allowed_function_codes
            );
            Err(anyhow::anyhow!(
                "Function code {} not allowed by security policy",
                function_code
            ))
        }
    }

    /// Validate write operation is permitted
    fn validate_write_allowed(&self) -> Result<()> {
        if !self.security.enabled {
            return Ok(());
        }

        if self.security.allow_writes {
            Ok(())
        } else {
            warn!(
                "Write operation denied for device '{}' (allow_writes=false)",
                self.config.name
            );
            Err(anyhow::anyhow!(
                "Write operations not allowed by security policy"
            ))
        }
    }

    /// Validate the target register address is within the allowed write ranges.
    /// IEC 62443 SL-2: address-granularity write authorization prevents a compromised
    /// cloud credential from targeting arbitrary holding registers (pump relays,
    /// dosing actuators, VFD frequency setpoints).
    fn validate_write_address(&self, address: u16) -> Result<()> {
        if !self.security.enabled {
            return Ok(());
        }

        if self.security.allowed_write_ranges.is_empty() {
            if self.security.allow_all_write_addresses {
                return Ok(());
            }
            return Err(anyhow::anyhow!(
                "Write address policy for device '{}' has no allowed ranges; set allowed_write_ranges or explicit allow_all_write_addresses=true",
                self.config.name
            ));
        }

        let allowed = self
            .security
            .allowed_write_ranges
            .iter()
            .any(|&(start, end)| address >= start && address <= end);

        if allowed {
            Ok(())
        } else {
            warn!(
                "Write to register {} denied for device '{}' (not in allowed_write_ranges)",
                address, self.config.name
            );
            Err(anyhow::anyhow!(
                "Register address {} is not in the allowed write range",
                address
            ))
        }
    }

    /// Try to acquire read rate limiter token (FC1–FC4)
    ///
    /// # Security
    /// IEC 62443 SL2 FR5: Prevent resource exhaustion attacks
    fn acquire_rate_limit(&self) -> Result<()> {
        if !self.security.enabled {
            return Ok(());
        }

        if self.rate_limiter.try_acquire() {
            Ok(())
        } else {
            warn!(
                "Rate limit exceeded for Modbus device '{}' ({}/{} tokens)",
                self.config.name,
                self.rate_limiter.available_tokens(),
                self.rate_limiter.capacity()
            );
            Err(anyhow::anyhow!(
                "Rate limit exceeded for device '{}'",
                self.config.name
            ))
        }
    }

    /// Try to acquire write rate limiter token (FC5, FC6)
    ///
    /// Write operations use a separate, more restrictive rate limiter to prevent
    /// runaway script logic from causing physical actuator damage (IEC 62443 SL2 FR5).
    fn acquire_write_rate_limit(&self) -> Result<()> {
        if !self.security.enabled {
            return Ok(());
        }

        if self.write_rate_limiter.try_acquire() {
            Ok(())
        } else {
            warn!(
                "Write rate limit exceeded for Modbus device '{}' ({}/{} tokens) — FC5/FC6 throttled",
                self.config.name,
                self.write_rate_limiter.available_tokens(),
                self.write_rate_limiter.capacity()
            );
            Err(anyhow::anyhow!(
                "Write rate limit exceeded for device '{}' — try again in ~500ms",
                self.config.name
            ))
        }
    }

    /// Check if circuit breaker is open
    #[allow(dead_code)]
    pub fn is_circuit_open(&self) -> bool {
        self.circuit_breaker.is_open()
    }

    /// Get circuit breaker state name
    #[allow(dead_code)]
    pub fn circuit_state(&self) -> &'static str {
        self.circuit_breaker.state_name()
    }

    /// Open the transport to the device (TCP, Modbus/TCP Security, or RTU).
    ///
    /// On failure the device stays registered and the link is scheduled for
    /// automatic re-open, so a PLC that is unreachable at boot or provision
    /// time is picked up by a later read without operator action.
    pub async fn connect(&mut self) -> Result<()> {
        // Reset circuit breaker on reconnection attempt
        self.circuit_breaker.reset();

        let timeout_msg = format!("Modbus connect {}", self.config.name);
        let opened = match with_timeout(self.open_transport(), CONNECT_TIMEOUT, &timeout_msg).await
        {
            Ok(opened) => opened,
            Err(e) => Err(anyhow::anyhow!("{e}")),
        };

        match opened {
            Ok(ctx) => {
                self.link = Link::Up(LiveLink {
                    ctx,
                    in_flight: false,
                });
                self.circuit_breaker.record_success();
                Ok(())
            }
            Err(e) => {
                self.link = self.reconnect.down_after(self.reconnect.min);
                self.circuit_breaker.record_failure();
                Err(e)
            }
        }
    }

    /// Open a fresh transport for this device.
    async fn open_transport(&self) -> Result<ModbusContext> {
        match self.config.connection_type.as_str() {
            "tcp" => self.open_tcp().await,
            "rtu" => self.open_rtu(),
            other => Err(anyhow::anyhow!("Unknown connection type: {other}")),
        }
    }

    /// Open a Modbus TCP transport with optional TLS (v1.2.0)
    ///
    /// # TLS Support
    /// When `config.tls.enabled = true`, uses encrypted TLS connection.
    /// This provides IEC 62443 SL2 FR4 (Data Confidentiality) compliance.
    async fn open_tcp(&self) -> Result<ModbusContext> {
        let socket_addr: SocketAddr = self
            .config
            .address
            .parse()
            .with_context(|| format!("Invalid TCP address: {}", self.config.address))?;

        // Batch 22 ARC-007: convert the serde-deserialized TLS
        // config to the type-level TlsMode enum. Validation
        // happens here — half-configured combinations (e.g.,
        // client cert without client key) and unreadable
        // certificate files fail-fast with an operator-actionable
        // error string before any socket is opened.
        let tls_mode = self.config.tls.to_mode().map_err(|e| {
            anyhow::anyhow!("Modbus '{}' TLS config invalid: {}", self.config.name, e)
        })?;

        let tls = match tls_mode {
            crate::config::TlsMode::Full {
                ref server_name,
                ref ca_cert_path,
                ref client_cert_path,
                ref client_key_path,
                ..
            } => {
                info!(
                    "Connecting to Modbus TCP/mTLS device '{}' at {} (mutual TLS)",
                    self.config.name, socket_addr
                );
                Some(
                    modbus_tls_client(
                        server_name,
                        ca_cert_path,
                        Some((client_cert_path, client_key_path)),
                    )
                    .with_context(|| "Failed to create mTLS config")?,
                )
            }
            crate::config::TlsMode::ServerOnly {
                ref server_name,
                ref ca_cert_path,
                ..
            } => {
                info!(
                    "Connecting to Modbus TCP/TLS device '{}' at {} (server-only TLS)",
                    self.config.name, socket_addr
                );
                debug!(
                    "Server-only TLS for '{}' (no client certificate)",
                    self.config.name
                );
                Some(
                    modbus_tls_client(server_name, ca_cert_path, None).with_context(|| {
                        format!(
                            "Failed to create server-only TLS config for '{}'. Ensure CA certificate at '{}' is valid PEM format.",
                            self.config.name, ca_cert_path
                        )
                    })?,
                )
            }
            crate::config::TlsMode::Disabled => {
                info!(
                    "Connecting to Modbus TCP device '{}' at {} (plaintext)",
                    self.config.name, socket_addr
                );
                None
            }
        };

        let stream = TcpStream::connect(socket_addr).await.with_context(|| {
            format!(
                "TCP connect to Modbus device '{}' at {} failed",
                self.config.name, socket_addr
            )
        })?;

        let ctx = match tls {
            Some((tls_config, server_name)) => {
                let tls_stream = TlsConnector::from(tls_config)
                    .connect(server_name, stream)
                    .await
                    .with_context(|| {
                        format!(
                            "TLS handshake with Modbus device '{}' at {} failed",
                            self.config.name, socket_addr
                        )
                    })?;
                info!(
                    "Connected to Modbus TCP/TLS device '{}' (TLS encrypted)",
                    self.config.name
                );
                tcp::attach_slave(tls_stream, self.slave)
            }
            None => {
                info!("Connected to Modbus TCP device '{}'", self.config.name);
                tcp::attach_slave(stream, self.slave)
            }
        };

        Ok(ctx)
    }

    /// Open a Modbus RTU (serial) transport
    ///
    /// Note: RTU connections do not support TLS (serial communication).
    /// For secure RTU, use physical security measures.
    fn open_rtu(&self) -> Result<ModbusContext> {
        #[cfg(target_os = "linux")]
        {
            let baud_rate = self.config.baud_rate.unwrap_or(9600);

            info!(
                "Connecting to Modbus RTU device '{}' at {} (baud: {})",
                self.config.name, self.config.address, baud_rate
            );

            // 8N1, no flow control
            let port_settings = tokio_serial::new(&self.config.address, baud_rate)
                .data_bits(tokio_serial::DataBits::Eight)
                .stop_bits(tokio_serial::StopBits::One)
                .parity(tokio_serial::Parity::None)
                .flow_control(tokio_serial::FlowControl::None);
            let port = tokio_serial::SerialStream::open(&port_settings).with_context(|| {
                format!(
                    "Failed to open serial port '{}' for Modbus RTU device '{}'",
                    self.config.address, self.config.name
                )
            })?;

            info!("Connected to Modbus RTU device '{}'", self.config.name);
            Ok(tokio_modbus::client::rtu::attach_slave(port, self.slave))
        }

        #[cfg(not(target_os = "linux"))]
        {
            Err(anyhow::anyhow!("Modbus RTU not supported on this platform"))
        }
    }

    /// Disconnect from device
    ///
    /// Closes the transport (TLS close_notify / TCP FIN) and returns the link
    /// to `Link::Idle`, which is never re-opened automatically.
    pub async fn disconnect(&mut self) {
        if let Link::Up(mut live) = std::mem::replace(&mut self.link, Link::Idle) {
            match tokio::time::timeout(MODBUS_TIMEOUT, live.ctx.disconnect()).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => debug!(
                    "Closing Modbus transport for '{}' reported: {}",
                    self.config.name, e
                ),
                Err(_) => debug!(
                    "Closing Modbus transport for '{}' timed out",
                    self.config.name
                ),
            }
        }
        info!("Disconnected from Modbus device '{}'", self.config.name);
    }

    /// Check if connected
    #[allow(dead_code)]
    pub fn is_connected(&self) -> bool {
        matches!(self.link, Link::Up(_))
    }

    /// The open transport. A link that is down is re-opened first once its
    /// backoff has elapsed; `Link::Idle` (never connected, or disconnected on
    /// request) is reported as "Not connected" and never re-opened here.
    async fn live_transport(&mut self) -> Result<&mut LiveLink> {
        if matches!(&self.link, Link::Up(live) if live.in_flight) {
            warn!(
                "Modbus device '{}': previous request was abandoned mid-flight; reopening transport",
                self.config.name
            );
            self.link = self.reconnect.down_after(Duration::ZERO);
        }

        if let Link::Down {
            retry_at,
            next_delay,
        } = self.link
        {
            let now = Instant::now();
            if now < retry_at {
                return Err(anyhow::anyhow!(
                    "Not connected (reconnect in {}ms)",
                    retry_at.duration_since(now).as_millis()
                ));
            }

            // Schedule the follow-up attempt before awaiting, so an attempt
            // cancelled by an outer timeout still honours the backoff.
            self.link = self.reconnect.down_after(next_delay);
            let ctx = tokio::time::timeout(MODBUS_TIMEOUT, self.open_transport())
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "Reconnect to Modbus device '{}' timed out",
                        self.config.name
                    )
                })?
                .with_context(|| {
                    format!("Reconnect to Modbus device '{}' failed", self.config.name)
                })?;
            info!("Reconnected to Modbus device '{}'", self.config.name);
            self.link = Link::Up(LiveLink {
                ctx,
                in_flight: false,
            });
        }

        match &mut self.link {
            Link::Up(live) => Ok(live),
            Link::Idle | Link::Down { .. } => Err(anyhow::anyhow!("Not connected")),
        }
    }

    /// Classify one request outcome. A Modbus exception is the device's answer
    /// and leaves the transport up; a transport/protocol error or a timeout
    /// leaves the stream in an unknown state, so the transport is retired and
    /// re-opened by a later request after the reconnect backoff.
    fn settle_outcome<T>(
        &mut self,
        op: &str,
        outcome: std::result::Result<tokio_modbus::Result<T>, tokio::time::error::Elapsed>,
    ) -> Result<T> {
        match outcome {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(exception))) => Err(anyhow::anyhow!("{op}: device exception: {exception}")),
            Ok(Err(e)) => {
                self.link = self.reconnect.down_after(self.reconnect.min);
                Err(anyhow::anyhow!("{op}: {e}"))
            }
            Err(_) => {
                self.link = self.reconnect.down_after(self.reconnect.min);
                Err(anyhow::anyhow!(
                    "{op}: no response within {MODBUS_TIMEOUT:?}"
                ))
            }
        }
    }

    /// Read all configured registers with circuit breaker protection
    pub async fn read_all(&mut self) -> ModbusReadResult {
        let register_count = self.registers.len();
        // LOW-39: Pre-allocate value/error vectors to the register count to avoid
        // incremental reallocations across the read loop on every telemetry cycle.
        let mut result = ModbusReadResult {
            device_name: self.config.name.clone(),
            values: Vec::with_capacity(register_count),
            errors: Vec::with_capacity(register_count.min(MAX_ERRORS_PER_READ)),
        };

        // PERF-003: Generate one RFC 3339 timestamp for the entire read cycle.
        // Previously each read_register() call allocated a new String via
        // Utc::now().to_rfc3339(), producing N heap allocations per cycle where N
        // is the register count.  Sharing a single timestamp across all registers
        // in the same read_all() call eliminates those allocations; all registers
        // read in one cycle share the same logical capture time anyway.
        let cycle_timestamp = chrono::Utc::now().to_rfc3339();

        // Check circuit breaker first
        if self.circuit_breaker.is_open() {
            result.errors.push(format!(
                "Circuit breaker open for device '{}' (state: {})",
                self.config.name,
                self.circuit_breaker.state_name()
            ));
            return result;
        }

        if matches!(self.link, Link::Idle) {
            result.errors.push("Not connected".to_string());
            return result;
        }

        let mut had_failure = false;
        let mut had_success = false;

        // Use Arc reference instead of cloning (v2.0 optimization)
        let registers = Arc::clone(&self.registers);
        for register in registers.iter() {
            match self
                .read_register_with_timeout(register, &cycle_timestamp)
                .await
            {
                Ok(value) => {
                    // v1.2.6: Log successful register reads at debug level
                    debug!(
                        "📊 Modbus READ: device='{}', register='{}', value={:.4} {}",
                        self.config.name,
                        register.name,
                        value.scaled_value,
                        value.unit.as_deref().unwrap_or("")
                    );
                    result.values.push(value);
                    had_success = true;
                }
                Err(e) => {
                    warn!("Failed to read register {}: {}", register.name, e);
                    // v1.2.6: Limit error vector growth
                    if result.errors.len() < MAX_ERRORS_PER_READ {
                        result.errors.push(format!("{}: {}", register.name, e));
                    } else if result.errors.len() == MAX_ERRORS_PER_READ {
                        result
                            .errors
                            .push("[Additional errors truncated]".to_string());
                    }
                    had_failure = true;
                }
            }
        }

        // Update circuit breaker based on overall result
        if had_failure && !had_success {
            self.circuit_breaker.record_failure();
        } else if had_success {
            self.circuit_breaker.record_success();
        }

        result
    }

    /// Read a register with timeout
    ///
    /// `cycle_timestamp` is the RFC 3339 string generated once at the start of
    /// the enclosing `read_all()` call and shared across all registers in this
    /// cycle (PERF-003: eliminates per-register String allocation).
    async fn read_register_with_timeout(
        &mut self,
        register: &ModbusRegisterConfig,
        cycle_timestamp: &str,
    ) -> Result<RegisterValue> {
        with_timeout(
            self.read_register(register, cycle_timestamp),
            MODBUS_TIMEOUT,
            &format!("Modbus read {}", register.name),
        )
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?
    }

    /// Read a single register (v1.2.0)
    ///
    /// # Security
    /// - Validates function code against whitelist
    /// - Enforces rate limiting
    /// - Validates register count limits
    ///
    /// `cycle_timestamp` is the RFC 3339 string generated once at the enclosing
    /// `read_all()` boundary and shared across all registers in this cycle
    /// (PERF-003: eliminates per-register Utc::now().to_rfc3339() allocation).
    pub async fn read_register(
        &mut self,
        register: &ModbusRegisterConfig,
        cycle_timestamp: &str,
    ) -> Result<RegisterValue> {
        // Security checks
        self.acquire_rate_limit()?;

        // Calculate register count before borrowing channel to satisfy borrow checker
        let register_count = self.get_register_count(&register.data_type);

        // Validate register count (IEC 62443 SL2 FR3: Input validation)
        if register_count > self.security.max_register_count {
            return Err(anyhow::anyhow!(
                "Register count {} exceeds maximum {} for security policy",
                register_count,
                self.security.max_register_count
            ));
        }

        // Determine function code and validate
        let function_code = match register.register_type.as_str() {
            "holding" => FC_READ_HOLDING_REGISTERS,
            "input" => FC_READ_INPUT_REGISTERS,
            "coil" => FC_READ_COILS,
            "discrete" => FC_READ_DISCRETE_INPUTS,
            other => return Err(anyhow::anyhow!("Unknown register type: {}", other)),
        };
        self.validate_function_code(function_code)?;

        let address = register.address;
        let raw_values: Vec<u16> = match register.register_type.as_str() {
            "holding" => {
                checked_address_range(address, register_count)?;
                modbus_request!(self, "Failed to read holding registers", |ctx| ctx
                    .read_holding_registers(address, register_count))?
            }
            "input" => {
                checked_address_range(address, register_count)?;
                modbus_request!(self, "Failed to read input registers", |ctx| ctx
                    .read_input_registers(address, register_count))?
            }
            "coil" => {
                let coils = modbus_request!(self, "Failed to read coil", |ctx| ctx
                    .read_coils(address, 1))?;
                // First coil value as u16
                vec![u16::from(coils.first().copied().unwrap_or(false))]
            }
            "discrete" => {
                let inputs = modbus_request!(self, "Failed to read discrete input", |ctx| ctx
                    .read_discrete_inputs(address, 1))?;
                // First input value as u16
                vec![u16::from(inputs.first().copied().unwrap_or(false))]
            }
            other => return Err(anyhow::anyhow!("Unknown register type: {}", other)),
        };

        // Convert raw value based on data type and byte order
        let raw_value = raw_values.first().copied().unwrap_or(0);
        let scaled_value =
            self.convert_value(&raw_values, &register.data_type, register.byte_order)
                * register.scale;

        debug!(
            "Read {}: raw={}, scaled={:.2}{}",
            register.name,
            raw_value,
            scaled_value,
            register.unit.as_deref().unwrap_or("")
        );

        Ok(RegisterValue {
            name: register.name.clone(),
            address: register.address,
            raw_value,
            scaled_value,
            unit: register.unit.clone(),
            // PERF-003: reuse cycle_timestamp instead of calling Utc::now().to_rfc3339()
            // per register — eliminates N String heap allocations per telemetry cycle.
            timestamp: cycle_timestamp.to_string(),
        })
    }

    /// Write to a holding register (v1.2.0)
    ///
    /// # Security
    /// - Validates write operations are allowed
    /// - Validates function code against whitelist
    /// - Enforces rate limiting
    pub async fn write_register(&mut self, address: u16, value: u16) -> Result<ModbusWriteReceipt> {
        // Security checks
        self.validate_write_allowed()?;
        self.validate_write_address(address)?;
        self.validate_function_code(FC_WRITE_SINGLE_REGISTER)?;
        self.acquire_write_rate_limit()?;

        modbus_request!(self, "Failed to write register", |ctx| ctx
            .write_single_register(address, value))?;

        let mut receipt = ModbusWriteReceipt {
            device_name: self.config.name.clone(),
            address,
            requested_value: value,
            protocol_ack: true,
            readback_enabled: self.security.verify_write_readback,
            readback_verified: !self.security.verify_write_readback,
            readback_value: None,
        };

        if self.security.verify_write_readback {
            receipt.readback_value = Some(self.read_back_written_register(address).await?);
            receipt.readback_verified = receipt.readback_value == Some(value);
            if !receipt.readback_verified {
                return Err(anyhow::anyhow!(
                    "Modbus write readback mismatch for device '{}' register {}: expected {}, got {:?}",
                    self.config.name,
                    address,
                    value,
                    receipt.readback_value
                ));
            }
        }

        // v1.2.6: Enhanced Modbus write logging
        info!(
            "📝 Modbus WRITE: device='{}', register={}, value={}",
            self.config.name, address, value
        );
        Ok(receipt)
    }

    /// Read a just-written holding register back from the same unit id.
    ///
    /// 2026-04-29: This closes the ACK-only blind spot. It verifies the target
    /// register after FC6 so PLC-side clamps, ignored writes, and wrong-address
    /// configuration fail the command instead of reporting a false success.
    async fn read_back_written_register(&mut self, address: u16) -> Result<u16> {
        let attempts = self.security.write_readback_retries.saturating_add(1);
        let settle = Duration::from_millis(self.security.write_readback_settle_ms);
        let mut last_error: Option<anyhow::Error> = None;

        for _ in 0..attempts {
            if !settle.is_zero() {
                tokio::time::sleep(settle).await;
            }

            match modbus_request!(self, "readback failed", |ctx| ctx
                .read_holding_registers(address, 1))
            {
                Ok(values) => {
                    if let Some(value) = values.first() {
                        return Ok(*value);
                    }
                    last_error = Some(anyhow::anyhow!("empty readback response"));
                }
                Err(e) => {
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("readback did not run")))
    }

    /// Write to a coil (v1.2.0)
    ///
    /// # Security
    /// - Validates write operations are allowed
    /// - Validates function code against whitelist
    /// - Enforces rate limiting
    pub async fn write_coil(&mut self, address: u16, value: bool) -> Result<()> {
        // Security checks
        self.validate_write_allowed()?;
        self.validate_write_address(address)?;
        self.validate_function_code(FC_WRITE_SINGLE_COIL)?;
        self.acquire_write_rate_limit()?;

        modbus_request!(self, "Failed to write coil", |ctx| ctx
            .write_single_coil(address, value))?;

        // v1.2.6: Enhanced Modbus write logging
        info!(
            "📝 Modbus WRITE COIL: device='{}', coil={}, value={}",
            self.config.name, address, value
        );
        Ok(())
    }

    /// Get register count for data type
    fn get_register_count(&self, data_type: &str) -> u16 {
        match data_type {
            "u32" | "i32" | "f32" => 2,
            "u64" | "i64" | "f64" => 4,
            _ => 1, // u16, i16
        }
    }

    /// Convert raw register values to f64 with byte order support
    ///
    /// Supported byte orders for 32-bit values:
    /// - BigEndian: AB CD (registers as-is, most significant first)
    /// - LittleEndian: CD AB (swap register order)
    /// - BigEndianByteSwap: BA DC (swap bytes within each register)
    /// - LittleEndianByteSwap: DC BA (swap both)
    fn convert_value(&self, values: &[u16], data_type: &str, byte_order: ByteOrder) -> f64 {
        match data_type {
            "u16" => values.first().copied().unwrap_or(0) as f64,
            "i16" => values.first().copied().unwrap_or(0) as i16 as f64,
            "u32" if values.len() >= 2 => {
                let bits = self.combine_u32(values[0], values[1], byte_order);
                bits as f64
            }
            "i32" if values.len() >= 2 => {
                let bits = self.combine_u32(values[0], values[1], byte_order);
                (bits as i32) as f64
            }
            "f32" if values.len() >= 2 => {
                let bits = self.combine_u32(values[0], values[1], byte_order);
                f32::from_bits(bits) as f64
            }
            "u64" if values.len() >= 4 => {
                let val = ((values[0] as u64) << 48)
                    | ((values[1] as u64) << 32)
                    | ((values[2] as u64) << 16)
                    | (values[3] as u64);
                val as f64
            }
            "i64" if values.len() >= 4 => {
                let raw = ((values[0] as u64) << 48)
                    | ((values[1] as u64) << 32)
                    | ((values[2] as u64) << 16)
                    | (values[3] as u64);
                // Sign-extend: shift left then arithmetic right to propagate the sign bit
                // The raw value uses 64 bits from 4 × 16-bit registers (big-endian)
                (raw as i64) as f64
            }
            _ => values.first().copied().unwrap_or(0) as f64,
        }
    }

    /// Combine two u16 registers into u32 based on byte order
    ///
    /// Different PLCs use different byte orders:
    /// - Siemens S7: BigEndian (AB CD)
    /// - Schneider: LittleEndian (CD AB)
    /// - Some devices: BigEndianByteSwap (BA DC)
    fn combine_u32(&self, reg_a: u16, reg_b: u16, byte_order: ByteOrder) -> u32 {
        match byte_order {
            ByteOrder::BigEndian => {
                // AB CD - standard Modbus, most significant word first
                ((reg_a as u32) << 16) | (reg_b as u32)
            }
            ByteOrder::LittleEndian => {
                // CD AB - swap register order
                ((reg_b as u32) << 16) | (reg_a as u32)
            }
            ByteOrder::BigEndianByteSwap => {
                // BA DC - swap bytes within each register
                let a_swapped = reg_a.swap_bytes();
                let b_swapped = reg_b.swap_bytes();
                ((a_swapped as u32) << 16) | (b_swapped as u32)
            }
            ByteOrder::LittleEndianByteSwap => {
                // DC BA - swap register order AND swap bytes
                let a_swapped = reg_a.swap_bytes();
                let b_swapped = reg_b.swap_bytes();
                ((b_swapped as u32) << 16) | (a_swapped as u32)
            }
        }
    }
}

/// Reject a register range that runs past the 16-bit Modbus address space.
fn checked_address_range(start: u16, count: u16) -> Result<()> {
    if count == 0 || u32::from(start) + u32::from(count) - 1 > u32::from(u16::MAX) {
        return Err(anyhow::anyhow!(
            "Invalid address range: {} register(s) from address {}",
            count,
            start
        ));
    }
    Ok(())
}

/// Build the TLS client side of a Modbus/TCP Security link.
///
/// The PLC certificate chain is verified against the CA bundle at
/// `ca_cert_path` and must match `server_name`. `client_identity` =
/// (certificate chain PEM path, private key PEM path) enables mutual TLS.
/// Files are read on every (re)connect, so a rotated certificate takes effect
/// without restarting the agent.
fn modbus_tls_client(
    server_name: &str,
    ca_cert_path: &str,
    client_identity: Option<(&str, &str)>,
) -> Result<(Arc<rustls::ClientConfig>, ServerName<'static>)> {
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_file_iter(ca_cert_path)
        .with_context(|| format!("Cannot read CA certificate file '{}'", ca_cert_path))?
    {
        let cert =
            cert.with_context(|| format!("Invalid PEM certificate in '{}'", ca_cert_path))?;
        roots
            .add(cert)
            .with_context(|| format!("Unusable CA certificate in '{}'", ca_cert_path))?;
    }
    if roots.is_empty() {
        return Err(anyhow::anyhow!(
            "CA certificate file '{}' contains no certificates",
            ca_cert_path
        ));
    }

    let builder = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(MODBUS_TLS_VERSIONS)
    .context("TLS protocol versions rejected by the crypto provider")?
    .with_root_certificates(roots);

    let config = match client_identity {
        None => builder.with_no_client_auth(),
        Some((cert_path, key_path)) => {
            let chain = CertificateDer::pem_file_iter(cert_path)
                .with_context(|| format!("Cannot read client certificate file '{}'", cert_path))?
                .collect::<std::result::Result<Vec<_>, _>>()
                .with_context(|| format!("Invalid PEM certificate in '{}'", cert_path))?;
            if chain.is_empty() {
                return Err(anyhow::anyhow!(
                    "Client certificate file '{}' contains no certificates",
                    cert_path
                ));
            }
            let key = PrivateKeyDer::from_pem_file(key_path)
                .with_context(|| format!("Cannot read client private key '{}'", key_path))?;
            builder
                .with_client_auth_cert(chain, key)
                .context("Client certificate and private key do not form a usable TLS identity")?
        }
    };

    let server_name = ServerName::try_from(server_name.to_string())
        .with_context(|| format!("Invalid TLS server_name '{}'", server_name))?;

    Ok((Arc::new(config), server_name))
}

/// Modbus device manager - handles multiple Modbus connections
///
/// # Thread Safety (v1.2.0)
/// Uses `Arc<Mutex>` for each client to enable parallel reads across devices.
/// Sequential operations still work as before for backwards compatibility.
///
/// # Why Mutex instead of RwLock (v1.2.4)
/// Modbus protocol requires exclusive access to the TCP/RTU connection for each
/// request-response cycle. Even "read" operations (reading holding registers)
/// require:
/// 1. Sending request bytes on the socket (write)
/// 2. Updating internal buffers and timeout state (write)
/// 3. Receiving response bytes from the socket (read)
///
/// Since reads and writes are interleaved for every operation, RwLock would
/// provide no benefit - all operations need exclusive (&mut) access anyway.
/// Multiple devices CAN be read in parallel since each has its own connection.
pub struct ModbusManager {
    /// Clients wrapped in `Arc<Mutex>` for parallel access (v1.2.0)
    /// Note: Mutex is correct here - see struct-level docs for explanation
    clients: Vec<Arc<Mutex<ModbusClient>>>,
}

impl ModbusManager {
    /// Create a new Modbus manager
    pub fn new(configs: Vec<ModbusDeviceConfig>) -> Self {
        let clients = configs
            .into_iter()
            .map(|c| Arc::new(Mutex::new(ModbusClient::new(c))))
            .collect();

        Self { clients }
    }

    /// Connect all devices (sequential - Modbus connections shouldn't be parallel)
    pub async fn connect_all(&mut self) -> Vec<String> {
        let mut errors = Vec::new();

        for client_arc in &self.clients {
            let mut client = client_arc.lock().await;
            if let Err(e) = client.connect().await {
                error!("Failed to connect to '{}': {}", client.config.name, e);
                errors.push(format!("{}: {}", client.config.name, e));
            }
        }

        errors
    }

    /// Disconnect all devices
    pub async fn disconnect_all(&mut self) {
        for client_arc in &self.clients {
            let mut client = client_arc.lock().await;
            client.disconnect().await;
        }
    }

    /// Read all registers from all devices (sequential)
    ///
    /// Backwards compatible method that reads devices one at a time.
    /// Use `read_all_parallel()` for concurrent reads with lower latency.
    pub async fn read_all(&mut self) -> Vec<ModbusReadResult> {
        let mut results = Vec::new();

        for client_arc in &self.clients {
            let mut client = client_arc.lock().await;
            // Use per-device timeout
            let device_name = client.config.name.clone();
            let result = tokio::time::timeout(
                Duration::from_secs(10), // Per-device timeout
                client.read_all(),
            )
            .await;

            match result {
                Ok(r) => results.push(r),
                Err(_) => {
                    results.push(ModbusReadResult {
                        device_name,
                        values: vec![],
                        errors: vec!["Device read timeout".to_string()],
                    });
                    // Record failure in circuit breaker
                    client.circuit_breaker.record_failure();
                }
            }
        }

        results
    }

    /// Read all registers from all devices (parallel, v1.2.0)
    ///
    /// Reads from all devices concurrently using `join_all`.
    /// This provides lower overall latency when reading multiple devices,
    /// as I/O waits can overlap.
    ///
    /// # Design note — join_all vs tokio::spawn
    /// `join_all` polls every per-device future on the *calling* (actor) task,
    /// so a parallel read cycle spawns no extra tasks that would need tracking
    /// or cancellation on shutdown, while I/O concurrency still comes from
    /// cooperative yielding inside each future.
    ///
    /// # Performance
    /// For N devices with T seconds read time each:
    /// - Sequential: N * T total time
    /// - Parallel: ~T total time (limited by slowest device)
    pub async fn read_all_parallel(&self) -> Vec<ModbusReadResult> {
        let futures: Vec<_> = self
            .clients
            .iter()
            .map(|client_arc| {
                let client_arc = Arc::clone(client_arc);
                async move {
                    let mut client = client_arc.lock().await;
                    let device_name = client.config.name.clone();

                    // Use per-device timeout.
                    // IMPORTANT: the lock is dropped before record_failure() to avoid
                    // holding it for the full timeout duration and blocking other reads.
                    let result = tokio::time::timeout(
                        Duration::from_secs(10), // Per-device timeout
                        client.read_all(),
                    )
                    .await;

                    // Drop the client lock before calling record_failure() so that
                    // concurrent reads on other devices are not blocked during the
                    // circuit-breaker state update (atomics only; no lock needed).
                    drop(client);

                    match result {
                        Ok(r) => r,
                        Err(_) => {
                            // Re-acquire lock only to access circuit breaker
                            let client = client_arc.lock().await;
                            client.circuit_breaker.record_failure();
                            ModbusReadResult {
                                device_name,
                                values: vec![],
                                errors: vec!["Device read timeout".to_string()],
                            }
                        }
                    }
                }
            })
            .collect();

        join_all(futures).await
    }

    /// Get client by device name (acquires lock)
    #[allow(dead_code)]
    pub async fn get_client_locked(
        &self,
        name: &str,
    ) -> Option<tokio::sync::MutexGuard<'_, ModbusClient>> {
        for client_arc in &self.clients {
            let client = client_arc.lock().await;
            if client.config.name == name {
                return Some(client);
            }
        }
        None
    }

    /// Get client by device name (returns Arc for caller to lock)
    ///
    /// Prefer `get_client_by_name` (async) for reliable lookups.
    /// This sync version uses try_lock and may return None if locks are contested.
    /// v1.2.3: Added retry logic for contested locks
    ///
    /// DEPRECATED: Use `get_client_by_name()` instead - this sync version
    /// uses busy-waiting which wastes CPU cycles. The async version properly
    /// yields to the scheduler.
    #[allow(dead_code)]
    #[deprecated(
        since = "1.3.2",
        note = "Use get_client_by_name() async version instead"
    )]
    pub fn get_client(&self, name: &str) -> Option<Arc<Mutex<ModbusClient>>> {
        // v1.2.3: Retry multiple times if locks are contested
        // v1.3.2: Note - spin_loop() doesn't actually yield to async runtime
        // Use get_client_by_name() for proper async yielding
        for _attempt in 0..3 {
            for client_arc in &self.clients {
                if let Ok(client) = client_arc.try_lock() {
                    if client.config.name == name {
                        return Some(Arc::clone(client_arc));
                    }
                }
            }
            // Note: spin_loop() is just a CPU hint, doesn't yield to async runtime
            // This is kept for backwards compatibility but should not be used
            std::hint::spin_loop();
        }
        None
    }

    /// Get client by device name (async version - always reliable)
    ///
    /// v1.2.3: New async method that guarantees finding the device if it exists,
    /// even when locks are contested.
    pub async fn get_client_by_name(&self, name: &str) -> Option<Arc<Mutex<ModbusClient>>> {
        for client_arc in &self.clients {
            let client = client_arc.lock().await;
            if client.config.name == name {
                drop(client); // Release lock before returning Arc
                return Some(Arc::clone(client_arc));
            }
        }
        None
    }

    /// Get device count
    pub fn device_count(&self) -> usize {
        self.clients.len()
    }

    /// Get circuit breaker status for all devices
    #[allow(dead_code)]
    pub async fn circuit_status(&self) -> Vec<(String, &'static str)> {
        let mut results = Vec::new();
        for client_arc in &self.clients {
            let client = client_arc.lock().await;
            results.push((client.config.name.clone(), client.circuit_state()));
        }
        results
    }

    /// Reconfigure with new device configs (hot-reload)
    #[allow(dead_code)]
    pub async fn reconfigure(&mut self, new_configs: Vec<ModbusDeviceConfig>) {
        info!(
            "Reconfiguring Modbus manager with {} devices",
            new_configs.len()
        );

        // Disconnect existing clients
        self.disconnect_all().await;

        // Create new clients
        self.clients = new_configs
            .into_iter()
            .map(|c| Arc::new(Mutex::new(ModbusClient::new(c))))
            .collect();

        // Connect new clients
        let errors = self.connect_all().await;
        if !errors.is_empty() {
            warn!(
                "Some Modbus devices failed to connect during reconfigure: {:?}",
                errors
            );
        }
    }

    /// Add a new device or replace an existing one by name (additive hot-reload).
    ///
    /// Unlike [`reconfigure`](Self::reconfigure), which disconnects EVERY device,
    /// this touches only the named device — other live drives/sensors keep their
    /// connections. Backs runtime provisioning of a tenant-added VFD so the drive
    /// becomes controllable without interrupting the rest of the bus.
    ///
    /// Returns `Some(error)` when the new client fails to connect; the client is
    /// still registered so a later reconnect/read can retry (a transient socket
    /// failure at provision time must not lose the binding). Returns `None` on a
    /// clean connect.
    pub async fn add_or_replace_device(&mut self, config: ModbusDeviceConfig) -> Option<String> {
        let name = config.name.clone();

        // Remove + disconnect any existing client with the same name so
        // re-provisioning a drive (e.g. changed IP or write ranges) is idempotent
        // rather than duplicating the device.
        let existing = self.index_of(&name).await;
        if let Some(pos) = existing {
            let old = self.clients.remove(pos);
            let mut client = old.lock().await;
            client.disconnect().await;
        }

        // Insert + connect only the new client.
        let client_arc = Arc::new(Mutex::new(ModbusClient::new(config)));
        let connect_err = {
            let mut client = client_arc.lock().await;
            client
                .connect()
                .await
                .err()
                .map(|e| format!("{}: {}", name, e))
        };
        self.clients.push(client_arc);

        if let Some(ref err) = connect_err {
            warn!(
                "Provisioned Modbus device '{}' but connect failed: {}",
                name, err
            );
        } else {
            info!("Provisioned Modbus device '{}' (connected)", name);
        }
        connect_err
    }

    /// Remove + disconnect a device by name (runtime decommission).
    /// Returns true when a device was removed.
    pub async fn remove_device(&mut self, name: &str) -> bool {
        match self.index_of(name).await {
            Some(pos) => {
                let old = self.clients.remove(pos);
                let mut client = old.lock().await;
                client.disconnect().await;
                info!("Decommissioned Modbus device '{}'", name);
                true
            }
            None => false,
        }
    }

    /// Find the index of a client by device name (acquires each lock in turn).
    async fn index_of(&self, name: &str) -> Option<usize> {
        for (i, client_arc) in self.clients.iter().enumerate() {
            let client = client_arc.lock().await;
            if client.config.name == name {
                return Some(i);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ModbusTlsConfig;

    /// Build a minimal plaintext-TCP device config for manager-level tests.
    /// `connect()` against a dead port fails fast but the device stays
    /// registered (its link is scheduled for re-open) — these tests exercise
    /// the additive/remove bookkeeping, not a live socket.
    fn provision_test_config(name: &str, address: &str) -> ModbusDeviceConfig {
        ModbusDeviceConfig {
            name: name.to_string(),
            connection_type: "tcp".to_string(),
            address: address.to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: Default::default(),
        }
    }

    #[tokio::test]
    async fn add_or_replace_device_is_additive_and_idempotent() {
        let mut mgr = ModbusManager::new(vec![]);
        assert_eq!(mgr.device_count(), 0);

        // First provision adds the device.
        let _ = mgr
            .add_or_replace_device(provision_test_config("vfd-1", "127.0.0.1:1"))
            .await;
        assert_eq!(mgr.device_count(), 1);

        // Re-provisioning the SAME name replaces in place — no duplicate device.
        let _ = mgr
            .add_or_replace_device(provision_test_config("vfd-1", "127.0.0.1:2"))
            .await;
        assert_eq!(mgr.device_count(), 1);

        // A different name adds alongside the existing live device.
        let _ = mgr
            .add_or_replace_device(provision_test_config("vfd-2", "127.0.0.1:3"))
            .await;
        assert_eq!(mgr.device_count(), 2);
    }

    #[tokio::test]
    async fn remove_device_removes_only_the_named_device() {
        let mut mgr = ModbusManager::new(vec![]);
        let _ = mgr
            .add_or_replace_device(provision_test_config("a", "127.0.0.1:1"))
            .await;
        let _ = mgr
            .add_or_replace_device(provision_test_config("b", "127.0.0.1:1"))
            .await;
        assert_eq!(mgr.device_count(), 2);

        assert!(mgr.remove_device("a").await);
        assert_eq!(mgr.device_count(), 1);

        // Removing an unknown device is a no-op that reports false.
        assert!(!mgr.remove_device("does-not-exist").await);
        assert_eq!(mgr.device_count(), 1);

        assert!(mgr.remove_device("b").await);
        assert_eq!(mgr.device_count(), 0);
    }

    #[test]
    fn test_register_value_serialization() {
        let value = RegisterValue {
            name: "temperature".to_string(),
            address: 100,
            raw_value: 2500,
            scaled_value: 25.0,
            unit: Some("°C".to_string()),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
        };

        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("temperature"));
        assert!(json.contains("25.0"));
    }

    #[test]
    fn test_convert_u32_big_endian() {
        let client = ModbusClient::new(ModbusDeviceConfig {
            name: "test".to_string(),
            connection_type: "tcp".to_string(),
            address: "127.0.0.1:502".to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: Default::default(),
        });

        // Test u32 BigEndian: 0x0001 0x0000 = 65536 (AB CD)
        let values = vec![0x0001, 0x0000];
        let result = client.convert_value(&values, "u32", ByteOrder::BigEndian);
        assert_eq!(result, 65536.0);
    }

    #[test]
    fn test_convert_u32_little_endian() {
        let client = ModbusClient::new(ModbusDeviceConfig {
            name: "test".to_string(),
            connection_type: "tcp".to_string(),
            address: "127.0.0.1:502".to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: Default::default(),
        });

        // Test u32 LittleEndian: 0x0001 0x0000 = 1 (CD AB = 0x0000 0x0001)
        let values = vec![0x0001, 0x0000];
        let result = client.convert_value(&values, "u32", ByteOrder::LittleEndian);
        assert_eq!(result, 1.0);
    }

    #[test]
    fn test_byte_order_combinations() {
        let client = ModbusClient::new(ModbusDeviceConfig {
            name: "test".to_string(),
            connection_type: "tcp".to_string(),
            address: "127.0.0.1:502".to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: Default::default(),
        });

        // Test with 0x1234 0x5678
        let values = vec![0x1234, 0x5678];

        // BigEndian: 0x12345678
        let be = client.combine_u32(values[0], values[1], ByteOrder::BigEndian);
        assert_eq!(be, 0x12345678);

        // LittleEndian: 0x56781234
        let le = client.combine_u32(values[0], values[1], ByteOrder::LittleEndian);
        assert_eq!(le, 0x56781234);

        // BigEndianByteSwap: 0x34127856
        let bebs = client.combine_u32(values[0], values[1], ByteOrder::BigEndianByteSwap);
        assert_eq!(bebs, 0x34127856);

        // LittleEndianByteSwap: 0x78563412
        let lebs = client.combine_u32(values[0], values[1], ByteOrder::LittleEndianByteSwap);
        assert_eq!(lebs, 0x78563412);
    }

    #[test]
    fn test_tls_config_in_client() {
        // Test that TLS config is properly initialized
        let tls_config = ModbusTlsConfig {
            enabled: true,
            server_name: Some("plc.example.com".to_string()),
            ca_cert_path: Some("/etc/certs/ca.pem".to_string()),
            client_cert_path: None,
            client_key_path: None,
            insecure_skip_verify: false,
        };

        let client = ModbusClient::new(ModbusDeviceConfig {
            name: "tls-test".to_string(),
            connection_type: "tcp".to_string(),
            address: "192.168.1.100:802".to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: tls_config.clone(),
        });

        assert!(client.config.tls.enabled);
        assert_eq!(
            client.config.tls.server_name,
            Some("plc.example.com".to_string())
        );
        assert!(!client.is_connected()); // Not connected yet
    }

    #[test]
    fn test_unit_id_creation() {
        // Test that UnitId is properly created from slave_id
        let client = ModbusClient::new(ModbusDeviceConfig {
            name: "unit-id-test".to_string(),
            connection_type: "tcp".to_string(),
            address: "127.0.0.1:502".to_string(),
            slave_id: 42,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: Default::default(),
        });

        // unit_id should be created from slave_id
        assert_eq!(client.slave.0, 42);
    }

    #[test]
    fn test_tls_config_server_only() {
        // Test TLS configuration for server-only authentication
        let config = ModbusDeviceConfig {
            name: "tls-server-only".to_string(),
            connection_type: "tcp".to_string(),
            address: "127.0.0.1:8802".to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: ModbusTlsConfig {
                enabled: true,
                server_name: Some("modbus.example.com".to_string()),
                ca_cert_path: Some("/etc/certs/ca.pem".to_string()),
                client_cert_path: None,
                client_key_path: None,
                insecure_skip_verify: false,
            },
        };

        let client = ModbusClient::new(config);
        assert!(client.config.tls.enabled);
        assert!(client.config.tls.client_cert_path.is_none());
        assert!(!client.is_connected());
    }

    #[test]
    fn test_tls_config_mtls() {
        // Test TLS configuration for mutual TLS (mTLS)
        let config = ModbusDeviceConfig {
            name: "tls-mtls".to_string(),
            connection_type: "tcp".to_string(),
            address: "192.168.1.100:8802".to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![],
            security: Default::default(),
            tls: ModbusTlsConfig {
                enabled: true,
                server_name: Some("plc.industrial.local".to_string()),
                ca_cert_path: Some("/etc/certs/ca.pem".to_string()),
                client_cert_path: Some("/etc/certs/client.pem".to_string()),
                client_key_path: Some("/etc/certs/client-key.pem".to_string()),
                insecure_skip_verify: false,
            },
        };

        let client = ModbusClient::new(config);
        assert!(client.config.tls.enabled);
        assert!(client.config.tls.client_cert_path.is_some());
        assert!(client.config.tls.client_key_path.is_some());
    }

    #[test]
    fn checked_address_range_rejects_overflow_and_empty() {
        assert!(checked_address_range(0, 1).is_ok());
        assert!(checked_address_range(u16::MAX, 1).is_ok());
        assert!(checked_address_range(u16::MAX - 1, 2).is_ok());
        assert!(checked_address_range(u16::MAX, 2).is_err());
        assert!(checked_address_range(10, 0).is_err());
    }

    // ============================================================================
    // Transport tests against an in-process Modbus/TCP server
    // ============================================================================
    // Plain TCP, server-only TLS, mTLS, certificate rejection, reconnect after a
    // PLC restart, and retirement of a transport whose request was abandoned.

    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;
    use tokio_modbus::server::tcp::{Server, accept_tcp_connection};
    use tokio_modbus::{ExceptionCode, Request, Response};

    /// DNS name in the test PLC's server certificate.
    const TEST_PLC_NAME: &str = "plc.test.local";

    /// Register image served by the in-process test PLC. Input registers mirror
    /// the holding image; discrete inputs mirror the coil image.
    #[derive(Clone, Default)]
    struct TestPlc {
        holding: Arc<StdMutex<HashMap<u16, u16>>>,
        coils: Arc<StdMutex<HashMap<u16, bool>>>,
        /// Transports accepted: TCP connections, or completed TLS handshakes.
        accepted: Arc<AtomicUsize>,
        /// Delay before each response, to let a client-side timeout fire.
        response_delay_ms: Arc<AtomicU64>,
    }

    impl TestPlc {
        fn with_holding(values: &[(u16, u16)]) -> Self {
            let plc = Self::default();
            if let Ok(mut image) = plc.holding.lock() {
                image.extend(values.iter().copied());
            }
            plc
        }

        fn set_coil(&self, address: u16, value: bool) {
            if let Ok(mut image) = self.coils.lock() {
                image.insert(address, value);
            }
        }

        fn holding_at(&self, address: u16) -> Option<u16> {
            self.holding.lock().ok()?.get(&address).copied()
        }

        fn coil_at(&self, address: u16) -> Option<bool> {
            self.coils.lock().ok()?.get(&address).copied()
        }

        fn accepted(&self) -> usize {
            self.accepted.load(Ordering::SeqCst)
        }

        fn set_response_delay(&self, delay: Duration) {
            let millis = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
            self.response_delay_ms.store(millis, Ordering::SeqCst);
        }

        fn read_words(&self, address: u16, count: u16) -> Result<Vec<u16>, ExceptionCode> {
            let image = self
                .holding
                .lock()
                .map_err(|_| ExceptionCode::ServerDeviceFailure)?;
            (address..address.saturating_add(count))
                .map(|a| {
                    image
                        .get(&a)
                        .copied()
                        .ok_or(ExceptionCode::IllegalDataAddress)
                })
                .collect()
        }

        fn read_bits(&self, address: u16, count: u16) -> Result<Vec<bool>, ExceptionCode> {
            let image = self
                .coils
                .lock()
                .map_err(|_| ExceptionCode::ServerDeviceFailure)?;
            (address..address.saturating_add(count))
                .map(|a| {
                    image
                        .get(&a)
                        .copied()
                        .ok_or(ExceptionCode::IllegalDataAddress)
                })
                .collect()
        }

        fn handle(&self, request: Request<'static>) -> Result<Response, ExceptionCode> {
            match request {
                Request::ReadHoldingRegisters(address, count) => self
                    .read_words(address, count)
                    .map(Response::ReadHoldingRegisters),
                Request::ReadInputRegisters(address, count) => self
                    .read_words(address, count)
                    .map(Response::ReadInputRegisters),
                Request::ReadCoils(address, count) => {
                    self.read_bits(address, count).map(Response::ReadCoils)
                }
                Request::ReadDiscreteInputs(address, count) => self
                    .read_bits(address, count)
                    .map(Response::ReadDiscreteInputs),
                Request::WriteSingleRegister(address, value) => {
                    self.holding
                        .lock()
                        .map_err(|_| ExceptionCode::ServerDeviceFailure)?
                        .insert(address, value);
                    Ok(Response::WriteSingleRegister(address, value))
                }
                Request::WriteSingleCoil(address, value) => {
                    self.coils
                        .lock()
                        .map_err(|_| ExceptionCode::ServerDeviceFailure)?
                        .insert(address, value);
                    Ok(Response::WriteSingleCoil(address, value))
                }
                _ => Err(ExceptionCode::IllegalFunction),
            }
        }
    }

    impl tokio_modbus::server::Service for TestPlc {
        type Request = Request<'static>;
        type Response = Response;
        type Exception = ExceptionCode;
        type Future = Pin<Box<dyn Future<Output = Result<Response, ExceptionCode>> + Send>>;

        fn call(&self, request: Self::Request) -> Self::Future {
            let delay = Duration::from_millis(self.response_delay_ms.load(Ordering::SeqCst));
            let response = self.handle(request);
            Box::pin(async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                response
            })
        }
    }

    /// Serve `plc` over plain Modbus/TCP until the returned task is aborted.
    /// Aborting also closes every connection the server accepted.
    fn spawn_plain_server(listener: TcpListener, plc: TestPlc) -> JoinHandle<()> {
        tokio::spawn(async move {
            let on_connected = |stream: TcpStream, socket_addr: SocketAddr| {
                let plc = plc.clone();
                async move {
                    plc.accepted.fetch_add(1, Ordering::SeqCst);
                    accept_tcp_connection(stream, socket_addr, move |_| Ok(Some(plc.clone())))
                }
            };
            let _ = Server::new(listener)
                .serve(&on_connected, |_err: std::io::Error| {})
                .await;
        })
    }

    /// Serve `plc` over Modbus/TCP Security behind `acceptor`. A failed
    /// handshake rejects that connection only.
    fn spawn_tls_server(
        listener: TcpListener,
        plc: TestPlc,
        acceptor: tokio_rustls::TlsAcceptor,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let on_connected = |stream: TcpStream, _socket_addr: SocketAddr| {
                let plc = plc.clone();
                let acceptor = acceptor.clone();
                async move {
                    let Ok(tls_stream) = acceptor.accept(stream).await else {
                        return Ok(None);
                    };
                    plc.accepted.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, std::io::Error>(Some((plc, tls_stream)))
                }
            };
            let _ = Server::new(listener)
                .serve(&on_connected, |_err: std::io::Error| {})
                .await;
        })
    }

    async fn local_listener() -> anyhow::Result<(TcpListener, SocketAddr)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        Ok((listener, address))
    }

    fn register(
        name: &str,
        address: u16,
        register_type: &str,
        data_type: &str,
        scale: f64,
    ) -> ModbusRegisterConfig {
        ModbusRegisterConfig {
            name: name.to_string(),
            address,
            register_type: register_type.to_string(),
            data_type: data_type.to_string(),
            byte_order: ByteOrder::BigEndian,
            scale,
            unit: None,
            poll_interval_ms: None,
            safe_state_value: None,
        }
    }

    /// TCP device polling holding register 100, writes allowed on 100..=120.
    fn device_config(name: &str, address: SocketAddr, tls: ModbusTlsConfig) -> ModbusDeviceConfig {
        ModbusDeviceConfig {
            name: name.to_string(),
            connection_type: "tcp".to_string(),
            address: address.to_string(),
            slave_id: 1,
            baud_rate: None,
            registers: vec![register("level", 100, "holding", "u16", 1.0)],
            security: ModbusSecurityConfig {
                allowed_function_codes: vec![
                    FC_READ_COILS,
                    FC_READ_DISCRETE_INPUTS,
                    FC_READ_HOLDING_REGISTERS,
                    FC_READ_INPUT_REGISTERS,
                    FC_WRITE_SINGLE_COIL,
                    FC_WRITE_SINGLE_REGISTER,
                ],
                allow_writes: true,
                allowed_write_ranges: vec![(100, 120)],
                write_readback_settle_ms: 0,
                ..Default::default()
            },
            tls,
        }
    }

    fn raw_values(result: &ModbusReadResult) -> Vec<u16> {
        result.values.iter().map(|v| v.raw_value).collect()
    }

    /// One CA issuing the PLC server certificate (SAN `plc.test.local`) and
    /// the agent client certificate. Client-side files are written as PEM.
    struct TestPki {
        dir: tempfile::TempDir,
        ca_pem: String,
        server_cert_pem: String,
        server_key_pem: String,
    }

    impl TestPki {
        fn generate() -> anyhow::Result<Self> {
            let ca_key = rcgen::KeyPair::generate()?;
            let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new())?;
            ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
            ca_params
                .distinguished_name
                .push(rcgen::DnType::CommonName, "Test Modbus CA");
            let ca_cert = ca_params.self_signed(&ca_key)?;

            let server_key = rcgen::KeyPair::generate()?;
            let mut server_params = rcgen::CertificateParams::new(vec![TEST_PLC_NAME.to_string()])?;
            server_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
            let server_cert = server_params.signed_by(&server_key, &ca_cert, &ca_key)?;

            let client_key = rcgen::KeyPair::generate()?;
            let mut client_params =
                rcgen::CertificateParams::new(vec!["edge-agent.test.local".to_string()])?;
            client_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
            let client_cert = client_params.signed_by(&client_key, &ca_cert, &ca_key)?;

            let dir = tempfile::tempdir()?;
            std::fs::write(dir.path().join("ca.pem"), ca_cert.pem())?;
            std::fs::write(dir.path().join("client.pem"), client_cert.pem())?;
            std::fs::write(
                dir.path().join("client-key.pem"),
                client_key.serialize_pem(),
            )?;

            Ok(Self {
                dir,
                ca_pem: ca_cert.pem(),
                server_cert_pem: server_cert.pem(),
                server_key_pem: server_key.serialize_pem(),
            })
        }

        fn path(&self, file: &str) -> String {
            self.dir.path().join(file).to_string_lossy().into_owned()
        }

        /// Agent-side TLS settings; `mutual` adds the agent client certificate.
        fn client_tls(&self, server_name: &str, mutual: bool) -> ModbusTlsConfig {
            ModbusTlsConfig {
                enabled: true,
                server_name: Some(server_name.to_string()),
                ca_cert_path: Some(self.path("ca.pem")),
                client_cert_path: mutual.then(|| self.path("client.pem")),
                client_key_path: mutual.then(|| self.path("client-key.pem")),
                insecure_skip_verify: false,
            }
        }

        /// PLC-side acceptor; `require_client_cert` turns on mutual TLS.
        fn acceptor(&self, require_client_cert: bool) -> anyhow::Result<tokio_rustls::TlsAcceptor> {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let chain = vec![CertificateDer::from_pem_slice(
                self.server_cert_pem.as_bytes(),
            )?];
            let key = PrivateKeyDer::from_pem_slice(self.server_key_pem.as_bytes())?;
            let builder = rustls::ServerConfig::builder_with_provider(Arc::clone(&provider))
                .with_protocol_versions(MODBUS_TLS_VERSIONS)?;
            let config = if require_client_cert {
                let mut roots = rustls::RootCertStore::empty();
                roots.add(CertificateDer::from_pem_slice(self.ca_pem.as_bytes())?)?;
                let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
                    Arc::new(roots),
                    provider,
                )
                .build()?;
                builder
                    .with_client_cert_verifier(verifier)
                    .with_single_cert(chain, key)?
            } else {
                builder.with_no_client_auth().with_single_cert(chain, key)?
            };
            Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
        }
    }

    #[tokio::test]
    async fn plain_tcp_reads_every_register_type_and_verifies_writes() -> anyhow::Result<()> {
        // f32 25.0 = 0x41C8_0000, big-endian word order
        let plc = TestPlc::with_holding(&[(100, 2500), (200, 0x41C8), (201, 0x0000)]);
        plc.set_coil(5, true);
        let (listener, address) = local_listener().await?;
        let _server = spawn_plain_server(listener, plc.clone());

        let mut config = device_config("plc-plain", address, ModbusTlsConfig::default());
        config.registers = vec![
            register("level", 100, "holding", "u16", 0.01),
            register("temperature", 200, "input", "f32", 1.0),
            register("pump", 5, "coil", "u16", 1.0),
            register("float_switch", 5, "discrete", "u16", 1.0),
        ];
        let mut client = ModbusClient::new(config);
        client.connect().await?;

        let result = client.read_all().await;
        assert!(result.errors.is_empty(), "read errors: {:?}", result.errors);
        let scaled: Vec<f64> = result.values.iter().map(|v| v.scaled_value).collect();
        assert_eq!(scaled, vec![25.0, 25.0, 1.0, 1.0]);

        let receipt = client.write_register(110, 1234).await?;
        assert!(receipt.protocol_ack);
        assert!(receipt.readback_enabled && receipt.readback_verified);
        assert_eq!(receipt.readback_value, Some(1234));
        assert_eq!(plc.holding_at(110), Some(1234));

        client.write_coil(111, true).await?;
        assert_eq!(plc.coil_at(111), Some(true));

        assert_eq!(plc.accepted(), 1, "all requests share one transport");
        Ok(())
    }

    #[tokio::test]
    async fn device_exception_is_reported_without_dropping_the_transport() -> anyhow::Result<()> {
        let plc = TestPlc::with_holding(&[(100, 7)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_plain_server(listener, plc.clone());

        let mut config = device_config("plc-exception", address, ModbusTlsConfig::default());
        config.registers = vec![
            register("unmapped", 300, "holding", "u16", 1.0),
            register("level", 100, "holding", "u16", 1.0),
        ];
        let mut client = ModbusClient::new(config);
        client.connect().await?;

        let result = client.read_all().await;
        assert_eq!(result.errors.len(), 1, "errors: {:?}", result.errors);
        assert!(
            result.errors.iter().all(|e| e.contains("device exception")),
            "errors: {:?}",
            result.errors
        );
        assert_eq!(raw_values(&result), vec![7]);
        assert!(client.is_connected());
        assert_eq!(plc.accepted(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn dropped_transport_is_reopened_after_backoff() -> anyhow::Result<()> {
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let server = spawn_plain_server(listener, plc.clone());

        let mut client = ModbusClient::new(device_config(
            "plc-restart",
            address,
            ModbusTlsConfig::default(),
        ));
        client.reconnect = ReconnectPolicy {
            min: Duration::from_millis(20),
            max: Duration::from_millis(80),
        };
        client.connect().await?;
        assert_eq!(raw_values(&client.read_all().await), vec![42]);

        // PLC restart: the server and every connection it accepted go away.
        server.abort();
        let _ = server.await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let during_outage = client.read_all().await;
        assert!(during_outage.values.is_empty());
        assert!(!during_outage.errors.is_empty());
        assert!(!client.is_connected());

        let _restarted = spawn_plain_server(TcpListener::bind(address).await?, plc.clone());
        tokio::time::sleep(Duration::from_millis(30)).await;

        let after_restart = client.read_all().await;
        assert!(
            after_restart.errors.is_empty(),
            "errors: {:?}",
            after_restart.errors
        );
        assert_eq!(raw_values(&after_restart), vec![42]);
        assert!(client.is_connected());
        assert_eq!(plc.accepted(), 2);
        Ok(())
    }

    #[tokio::test]
    async fn abandoned_request_retires_the_transport() -> anyhow::Result<()> {
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_plain_server(listener, plc.clone());

        let mut client = ModbusClient::new(device_config(
            "plc-slow",
            address,
            ModbusTlsConfig::default(),
        ));
        client.connect().await?;
        let level = register("level", 100, "holding", "u16", 1.0);

        // An outer timeout drops the request while its response is pending.
        plc.set_response_delay(Duration::from_millis(200));
        let abandoned =
            tokio::time::timeout(Duration::from_millis(20), client.read_register(&level, "t"))
                .await;
        assert!(
            abandoned.is_err(),
            "request should be cut off by the outer timeout"
        );

        // The late reply must not be paired with the next request: the next
        // request runs on a fresh transport and reads the right value.
        plc.set_response_delay(Duration::ZERO);
        let value = client.read_register(&level, "t").await?;
        assert_eq!(value.raw_value, 42);
        assert_eq!(plc.accepted(), 2, "transport must be re-opened, not reused");
        Ok(())
    }

    #[tokio::test]
    async fn server_only_tls_round_trip() -> anyhow::Result<()> {
        let pki = TestPki::generate()?;
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_tls_server(listener, plc.clone(), pki.acceptor(false)?);

        let mut client = ModbusClient::new(device_config(
            "plc-tls",
            address,
            pki.client_tls(TEST_PLC_NAME, false),
        ));
        client.connect().await?;

        let result = client.read_all().await;
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
        assert_eq!(raw_values(&result), vec![42]);
        assert_eq!(plc.accepted(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn mutual_tls_round_trip() -> anyhow::Result<()> {
        let pki = TestPki::generate()?;
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_tls_server(listener, plc.clone(), pki.acceptor(true)?);

        let mut client = ModbusClient::new(device_config(
            "plc-mtls",
            address,
            pki.client_tls(TEST_PLC_NAME, true),
        ));
        client.connect().await?;

        let receipt = client.write_register(105, 77).await?;
        assert!(receipt.readback_verified);
        let result = client.read_all().await;
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
        assert_eq!(raw_values(&result), vec![42]);
        assert_eq!(plc.holding_at(105), Some(77));
        assert_eq!(plc.accepted(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn mutual_tls_plc_rejects_agent_without_client_certificate() -> anyhow::Result<()> {
        let pki = TestPki::generate()?;
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_tls_server(listener, plc.clone(), pki.acceptor(true)?);

        let mut client = ModbusClient::new(device_config(
            "plc-mtls-no-cert",
            address,
            pki.client_tls(TEST_PLC_NAME, false),
        ));
        // With TLS 1.3 the client may finish its side of the handshake before
        // the PLC rejects it, so the rejection can surface on connect or on
        // the first request — either way no data may flow.
        let connected = client.connect().await;
        let result = client.read_all().await;
        assert!(connected.is_err() || !result.errors.is_empty());
        assert!(result.values.is_empty());
        assert_eq!(plc.accepted(), 0);
        Ok(())
    }

    #[tokio::test]
    async fn tls_rejects_plc_certificate_from_unknown_ca() -> anyhow::Result<()> {
        let plc_pki = TestPki::generate()?;
        let other_pki = TestPki::generate()?;
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_tls_server(listener, plc.clone(), plc_pki.acceptor(false)?);

        let mut client = ModbusClient::new(device_config(
            "plc-unknown-ca",
            address,
            other_pki.client_tls(TEST_PLC_NAME, false),
        ));
        let Err(err) = client.connect().await else {
            panic!("handshake with a PLC certificate from an unknown CA must fail");
        };
        assert!(format!("{err:#}").contains("TLS handshake"), "{err:#}");
        assert!(!client.is_connected());
        Ok(())
    }

    #[tokio::test]
    async fn tls_rejects_plc_certificate_for_another_name() -> anyhow::Result<()> {
        let pki = TestPki::generate()?;
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_tls_server(listener, plc.clone(), pki.acceptor(false)?);

        let mut client = ModbusClient::new(device_config(
            "plc-wrong-name",
            address,
            pki.client_tls("other-plc.test.local", false),
        ));
        let Err(err) = client.connect().await else {
            panic!("handshake with a certificate for another name must fail");
        };
        assert!(format!("{err:#}").contains("TLS handshake"), "{err:#}");
        Ok(())
    }

    #[tokio::test]
    async fn half_configured_mtls_fails_before_opening_a_socket() -> anyhow::Result<()> {
        let pki = TestPki::generate()?;
        let plc = TestPlc::with_holding(&[(100, 42)]);
        let (listener, address) = local_listener().await?;
        let _server = spawn_tls_server(listener, plc.clone(), pki.acceptor(true)?);

        let mut tls = pki.client_tls(TEST_PLC_NAME, true);
        tls.client_key_path = None;
        let mut client = ModbusClient::new(device_config("plc-half-mtls", address, tls));
        let Err(err) = client.connect().await else {
            panic!("client certificate without key must be rejected");
        };
        assert!(format!("{err:#}").contains("TLS config invalid"), "{err:#}");
        assert_eq!(plc.accepted(), 0);
        Ok(())
    }
}
