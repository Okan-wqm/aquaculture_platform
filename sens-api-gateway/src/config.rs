//! Configuration management for Suderra Edge Agent
//!
//! Handles loading and saving of agent configuration from YAML files.
//!
//! # Security Hardening (v1.2.2)
//! - MQTT credentials use `secrecy` crate (zeroize on drop)
//! - TLS is now default for Modbus TCP connections
//! - Certificate file permissions are validated on Unix
//! - `insecure_skip_verify` is compile-time disabled in release builds

use anyhow::{Context, Result};
use secrecy::{ExposeSecret, Secret};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use tracing::{debug, info, warn};

use crate::i2c::I2cDeviceConfig;
use crate::plc_programming::PlcProgrammingConfig;

// ============================================================================
// `Secret<String>` Serialization Helpers (v1.2.2)
// ============================================================================

/// Prefix used to identify base64-encoded credential fields in config.yaml
const B64_PREFIX: &str = "b64:";

/// Serialize `Option<Secret<String>>` — stores the value as base64 to avoid
/// accidental cleartext credential exposure via grep, diff, or backup tools.
///
/// The `b64:` prefix allows the deserializer to distinguish encoded values
/// from any legacy cleartext values stored before this change was applied.
///
/// Note: base64 is encoding, not encryption.  The config file must still be
/// protected by OS-level permissions (0600) which `save()` enforces below.
fn serialize_secret_option<S>(
    value: &Option<Secret<String>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    match value {
        Some(secret) => {
            let encoded = format!("{}{}", B64_PREFIX, STANDARD.encode(secret.expose_secret()));
            serializer.serialize_some(&encoded)
        }
        None => serializer.serialize_none(),
    }
}

/// Deserialize `Option<Secret<String>>` — handles both the new `b64:` encoded
/// form and any legacy cleartext values for backward compatibility.
fn deserialize_secret_option<'de, D>(deserializer: D) -> Result<Option<Secret<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let opt: Option<String> = Option::deserialize(deserializer)?;
    Ok(opt.map(|s| {
        if let Some(encoded) = s.strip_prefix(B64_PREFIX) {
            // Decode base64; fall back to the raw string if decoding fails
            match STANDARD.decode(encoded) {
                Ok(bytes) => Secret::new(String::from_utf8_lossy(&bytes).into_owned()),
                Err(_) => Secret::new(s),
            }
        } else {
            // Legacy cleartext value — wrap as-is
            Secret::new(s)
        }
    }))
}

// ============================================================================
// Private Key Permission Validation (v1.2.2 - IEC 62443 FR4)
// ============================================================================
// Delegate to the canonical implementation in crate::security (MED-23).
use crate::security::validate_key_file_permissions;

// ============================================================================
// Platform-Aware GPIO Validation (v1.2.2)
// ============================================================================

/// GPIO platform type for validation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpioPlatform {
    /// Raspberry Pi (BCM GPIO 0-27)
    RaspberryPi,
    /// Revolution Pi (extended GPIO range)
    RevolutionPi,
    /// Generic Linux GPIO (sysfs/gpiod)
    GenericLinux,
    /// Unknown/Simulation
    Unknown,
}

impl GpioPlatform {
    /// Get valid GPIO pin range for this platform
    pub fn valid_range(&self) -> (u8, u8) {
        match self {
            GpioPlatform::RaspberryPi => (0, 27),
            GpioPlatform::RevolutionPi => (0, 127), // RevPi has extended GPIO
            GpioPlatform::GenericLinux => (0, 255), // Generic allows up to 255
            GpioPlatform::Unknown => (0, 255),      // Simulation mode - allow all
        }
    }
}

/// Detect current GPIO platform based on system info
#[cfg(target_os = "linux")]
fn detect_gpio_platform() -> GpioPlatform {
    use std::path::Path;

    // Check for Raspberry Pi
    if Path::new("/proc/device-tree/model").exists() {
        if let Ok(model) = std::fs::read_to_string("/proc/device-tree/model") {
            if model.contains("Raspberry Pi") {
                return GpioPlatform::RaspberryPi;
            }
            if model.contains("Revolution Pi") || model.contains("RevPi") {
                return GpioPlatform::RevolutionPi;
            }
        }
    }

    // Check for generic gpiochip
    if Path::new("/dev/gpiochip0").exists() {
        return GpioPlatform::GenericLinux;
    }

    GpioPlatform::Unknown
}

#[cfg(not(target_os = "linux"))]
fn detect_gpio_platform() -> GpioPlatform {
    GpioPlatform::Unknown
}

/// Default config file path
const DEFAULT_CONFIG_PATH: &str = "/etc/suderra/config.yaml";

/// Agent configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Unique device identifier (UUID)
    pub device_id: String,

    /// Human-readable device code (e.g., "RPI-A1B2C3D4")
    pub device_code: String,

    /// Provisioning token — zeroized on drop via `Secret<String>` (IEC 62443 FR4 / MED-30).
    /// Cleared from config after successful activation.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_secret_option",
        deserialize_with = "deserialize_secret_option"
    )]
    pub provisioning_token: Option<Secret<String>>,

    /// Tenant provisioning token for self-registration (v2.0) — zeroized on drop.
    /// Cleared after successful self-registration.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_secret_option",
        deserialize_with = "deserialize_secret_option"
    )]
    pub tenant_token: Option<Secret<String>>,

    /// Cloud API URL
    pub api_url: String,

    /// MQTT configuration
    pub mqtt: MqttConfig,

    /// Health HTTP server configuration (Batch 14 ARC-003).
    /// Default: disabled with localhost:8080 bind. Per plan §5 Faz 1
    /// Step 1.4 HealthServer wire — orchestrators (Docker / k8s /
    /// systemd) probe /health + /ready + /metrics + /diagnostics for
    /// liveness + readiness gating.
    #[serde(default)]
    pub health: HealthServerConfig,

    /// Offline queue configuration (Batch 15 ARC-002).
    /// Default: disabled. Per plan §5 Faz 1 Step 1.3 — SQLCipher-backed
    /// durable queue for telemetry across broker outages. Enable via
    /// `config.yaml::offline_queue.enabled: true`.
    #[serde(default)]
    pub offline_queue: OfflineQueueConfig,

    /// Backup manager configuration (Batch 18 ARC-009 wire).
    /// Default: disabled. Per plan §5 Faz 1 Step 8 + ADR-020 §6 GDPR
    /// Art 20 edge portability — config/script/FB/SQLite snapshot to
    /// gzipped binary at `backup_dir`. Operator reads via future HTTP
    /// endpoint (auth via `BACKUP_AUTH_SECRET` env) OR manually
    /// copies for operator-controlled data export.
    #[serde(default)]
    pub backup: BackupConfig,

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

    /// I2C device configuration
    #[serde(default)]
    pub i2c: Vec<I2cDeviceConfig>,

    /// Scripting configuration
    #[serde(default)]
    pub scripting: ScriptingConfig,

    /// Runtime/resilience configuration
    #[serde(default)]
    pub runtime: RuntimeConfig,

    /// mTLS rollout-stage configuration (Batch 27, plan §5 Faz 2
    /// item 7). Controls cert-age checks + fingerprint-pinning
    /// enforcement across the Legacy → Warn → Strict 3-stage
    /// rollout. Wired into rustls client builder in Sprint 6-.8;
    /// pre-Sprint-6.8 the value is surfaced at boot log for
    /// operator visibility but does not yet affect TLS handshakes.
    #[serde(default)]
    pub mtls: MtlsConfig,

    /// Config-integrity sidecar verification (Batch 42, plan D-13
    /// / ADR-020 §6 / Sprint 6.6). Controls whether boot reads
    /// `/etc/suderra/config.yaml.sig`, computes SHA-256 of
    /// `config.yaml`, and verifies the factory-ed25519
    /// signature against the embedded public key.
    /// Pre-Sprint-6.6 the MODE field is surfaced at boot log for
    /// operator visibility; the actual verify path wires in
    /// Sprint 6.6 once the factory key is bundled in the
    /// firmware image.
    #[serde(default)]
    pub config_integrity: ConfigIntegrityConfig,

    /// Command-envelope signature verification mode (Batch 45,
    /// plan §2 HC-6 / Sprint 6.4). Controls whether incoming
    /// MQTT commands require a valid ed25519 signature for
    /// mutating operations. Pre-Sprint-6.4 the MODE field is
    /// exposed here + logged at boot for operator visibility;
    /// the actual envelope verify path wires in Sprint 6.4
    /// along with the Moka-backed jti dedup cache.
    ///
    /// Rollout discipline (plan §2 HC-6):
    /// - Disabled (default) — HC-1 backward compat; unsigned
    ///   commands accepted.
    /// - Permissive — unsigned mutating commands logged but
    ///   accepted; signed envelopes MUST verify.
    /// - Enforcing — unsigned mutating commands rejected.
    #[serde(default)]
    pub signature_mode: crate::command_envelope::envelope::SignatureMode,

    /// Clock authority configuration (Batch 56, plan D-7 /
    /// Sprint 6.7). Controls NTS-sync staleness threshold used
    /// by the future `ChronyNtsClockAuthority` to reject wall-
    /// clock reads when chronyd has been silent too long.
    /// Pre-Sprint-6.7 the SystemClockAuthority (Batch 55)
    /// reports nts_sync_age_secs=0 unconditionally so the
    /// threshold check never fires; operators can still tune
    /// the threshold so their config.yaml is ready for
    /// Sprint 6.7 swap-in.
    #[serde(default)]
    pub clock: ClockConfig,

    /// Envelope dedup cache configuration (Batch 58, plan
    /// §4.10 / Sprint 6.4). Controls the MokaJtiDedupTable
    /// capacity + TTL — the hot-window tier (60s default)
    /// that catches QoS-1 MQTT redelivery replays in-memory.
    /// Sprint 6.4 full wire layers a SQLCipher persistent tier
    /// underneath for the 72-hour plan window.
    #[serde(default)]
    pub envelope_dedup: EnvelopeDedupConfig,

    /// RBAC manifest configuration (Batch 66, plan §3 R-5 /
    /// ADR-018 / Sprint 6.1). Controls loading + verification
    /// of the cloud-signed RBAC manifest that carries
    /// operator-pubkey bindings + custom role definitions.
    /// Pre-Sprint-6.1 the MODE is exposed + logged at boot;
    /// manifest runtime (actor-pubkey lookup for envelope
    /// signature verify) wires at Sprint 6.1 full.
    #[serde(default)]
    pub rbac_manifest: RbacManifestConfig,

    /// User-token manifest knobs (Batch #249b Faz 5 A-3c).
    /// Serde-default so pre-Batch-249b config.yaml files continue
    /// to parse; when absent, user-token manifest stays disabled
    /// (fail-closed — no credentials can be enrolled).
    #[serde(default)]
    pub user_token_manifest: UserTokenManifestConfig,

    /// Firmware update verification configuration (Batch 114
    /// Sprint 6.5 / ADR-019 §3). Controls whether incoming
    /// firmware payloads are verified as SignedFirmwareManifest
    /// (ed25519 + 8-gate verify) or fall through to the
    /// legacy Batch 20k tarball OTA path. Operator-facing
    /// knobs: rollout mode (Disabled/Permissive/Enforcing) +
    /// ed25519 signing pubkey hex. Coherence Rule 20 enforces
    /// that non-Disabled mode requires a parseable 64-char
    /// hex pubkey.
    #[serde(default)]
    pub firmware_update: FirmwareUpdateConfig,

    /// Lifecycle HTTP endpoint auth config (Batch 129
    /// Sprint 6.6). Controls whether
    /// `POST /lifecycle/confirm-active` requires a
    /// per-request HMAC derived from a
    /// systemd-credential-delivered key. HC-1 default is
    /// Disabled; production deployments set
    /// `auth_mode = hmac_token` + deploy the corresponding
    /// systemd unit with LoadCredential.
    #[serde(default)]
    pub lifecycle_endpoint: LifecycleEndpointConfig,

    /// Audit sink configuration (Batch 78 Sprint 6.2 Phase 2).
    /// Controls whether pre+post audit events are written to
    /// `/var/log/suderra/audit.log` with HMAC chain integrity.
    /// Phase 2 / Batch 80 swaps the HMAC key source from
    /// config-supplied hex to Sprint 6.3 keystore-derived
    /// (KeyPurpose::AuditHmacChain) — the config knob is the
    /// rollout-stage path.
    #[serde(default)]
    pub audit: AuditConfig,

    /// Keystore configuration (Batch 83 Sprint 6.3). Selects
    /// the master-key backend (TPM / systemd-creds /
    /// FileBacked) + supplies the per-backend paths.
    /// Disabled (default) leaves AppState.keystore = None —
    /// existing deployments keep using config-supplied hex
    /// keys from audit/sqlcipher config surfaces.
    #[serde(default)]
    pub keystore: KeystoreConfig,

    /// Cache configuration (v1.2.0)
    #[serde(default)]
    pub cache: CacheConfig,

    /// Circuit breaker configuration (v1.2.0)
    #[serde(default)]
    pub circuit_breaker: CircuitBreakerConfig,

    /// LoRaWAN gateway configuration (v1.5.0)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lorawan: Option<LoRaWanConfig>,

    /// OPC UA server configuration (Batch 207 Faz 5).
    ///
    /// WHY: Plan §5 Faz 5 specifies an async-opcua-backed server
    /// that 3rd-party HMIs (Ignition, UaExpert, Kepware,
    /// Wonderware) browse + subscribe to without the cloud
    /// broker. Read paths expose the process image; write paths
    /// go through the same authz + audit gate every MQTT-command
    /// write uses, so the OPC UA surface cannot bypass policy.
    ///
    /// HC-1 backward compat: `enabled` default false — existing
    /// config.yaml files deserialize unchanged and no OPC UA
    /// port is opened. The `opc-ua-server` Cargo feature flag
    /// compiles the implementation out of the binary entirely
    /// when not built; this config block is always accepted at
    /// the serde layer so operators can pre-stage the config for
    /// a feature-built binary roll-out without re-deploying
    /// agent configs.
    #[serde(default)]
    pub opc_ua_server: OpcUaServerConfig,

    /// Direct PLC programming endpoint inventory.
    ///
    /// MQTT/HTTP PLC commands use these names as stable audit and
    /// authorization targets. Default-empty keeps existing config files valid
    /// while enabling boot-time validation for deployments that opt in.
    #[serde(default)]
    pub plc_programming: PlcProgrammingConfig,
}

/// MQTT TLS configuration (IEC 62443 SL2 FR4: Data Confidentiality)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MqttTlsConfig {
    /// Enable TLS encryption
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// CA certificate path for server verification
    pub ca_cert_path: Option<String>,

    /// Client certificate path (for mTLS)
    pub client_cert_path: Option<String>,

    /// Client private key path (for mTLS)
    pub client_key_path: Option<String>,

    /// Verify server hostname against certificate
    #[serde(default = "default_true")]
    pub verify_hostname: bool,

    /// Disable TLS server certificate verification — ONLY for development/testing.
    /// Setting this to `true` in release builds is blocked at compile time
    /// to prevent insecure production deployments (IEC 62443 FR4).
    #[serde(default)]
    pub insecure_skip_verify: bool,
}

impl MqttTlsConfig {
    /// Validate TLS configuration — compile-time guard mirrors ModbusTlsConfig
    pub fn validate(&self) -> Result<(), crate::error::AgentError> {
        #[cfg(not(debug_assertions))]
        if self.insecure_skip_verify {
            return Err(crate::error::AgentError::Config(
                "MQTT TLS insecure_skip_verify is not allowed in release builds (IEC 62443 FR4)"
                    .into(),
            ));
        }
        Ok(())
    }
}

/// MQTT configuration
#[derive(Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    /// MQTT broker hostname (primary)
    pub broker: Option<String>,

    /// MQTT broker port (1883 for plain, 8883 for TLS)
    #[serde(default = "default_mqtt_port")]
    pub port: u16,

    /// MQTT username (set after activation)
    pub username: Option<String>,

    /// MQTT password (set after activation)
    /// v1.2.2: Uses secrecy crate for zeroize on drop (IEC 62443 FR4)
    #[serde(
        default,
        serialize_with = "serialize_secret_option",
        deserialize_with = "deserialize_secret_option"
    )]
    pub password: Option<Secret<String>>,

    /// TLS configuration (optional, IEC 62443 SL2)
    #[serde(default)]
    pub tls: MqttTlsConfig,

    /// Topic patterns (v1.1 - tenant-prefixed)
    #[serde(default)]
    pub topics: MqttTopics,

    /// Keep-alive interval in seconds
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u64,

    /// Clean session flag — default `false` to preserve QoS 1/2 messages across
    /// reconnects. Setting `true` discards server-side session state on every
    /// connect, losing any messages queued by the broker during the disconnect window.
    #[serde(default)]
    pub clean_session: bool,

    /// Last Will topic for device status (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_will_topic: Option<String>,

    /// Failover configuration for high availability (v1.3.4)
    #[serde(default)]
    pub failover: MqttFailoverConfig,
}

/// MQTT Failover configuration for high availability (v1.3.4)
///
/// Enables automatic failover to a backup broker when the primary
/// broker becomes unavailable. Supports health checks and automatic
/// recovery to primary when it comes back online.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttFailoverConfig {
    /// Enable failover functionality
    #[serde(default)]
    pub enabled: bool,

    /// Backup broker hostname
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_broker: Option<String>,

    /// Backup broker port (defaults to same as primary)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_port: Option<u16>,

    /// Connection timeout before failover (seconds)
    #[serde(default = "default_failover_timeout_secs")]
    pub timeout_secs: u64,

    /// Interval to check if primary is back online (seconds)
    #[serde(default = "default_failover_health_check_secs")]
    pub health_check_interval_secs: u64,

    /// Maximum consecutive failures before failover
    #[serde(default = "default_failover_max_failures")]
    pub max_failures: u32,

    /// Delay before attempting to reconnect to primary (seconds)
    #[serde(default = "default_failover_recovery_delay_secs")]
    pub recovery_delay_secs: u64,
}

impl Default for MqttFailoverConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            backup_broker: None,
            backup_port: None,
            timeout_secs: default_failover_timeout_secs(),
            health_check_interval_secs: default_failover_health_check_secs(),
            max_failures: default_failover_max_failures(),
            recovery_delay_secs: default_failover_recovery_delay_secs(),
        }
    }
}

// =============================================================================
// HealthServerConfig — Batch 14 ARC-003 (HealthServer wire)
// =============================================================================
//
// WHY: Plan §5 Faz 1 Step 1.4 — `health.rs` implements an axum HTTP server
// exposing `/health /ready /metrics /diagnostics` for orchestrator liveness
// probes (Docker, k8s, systemd). Pre-Batch-14 the file was dead-code.
// OBS-14-001 (see session-observations.md): HealthState counter update
// paths from MQTT / modbus / script engine subsystems are NOT wired —
// metrics will report 0 until Sprint 6.2 threads HealthState clones into
// those subsystems. This batch wires the server + AppState field only.
//
// WHAT: Config struct with:
//   - `enabled` — master toggle (default false per plan HC-6 rollout
//     discipline; explicit opt-in per deployment).
//   - `bind` — SocketAddr string. Default `127.0.0.1:8080` (LOCALHOST
//     ONLY — orchestrators probe via loopback or sidecar; external
//     scrape requires explicit operator reconfigure to the routable
//     interface).
//
// INVARIANT: Server binds to `bind` ONLY when `enabled == true`. Invalid
// SocketAddr parse fails at boot with operator-visible ERROR; no silent
// fallback to a different address.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthServerConfig {
    /// Master toggle for the HTTP health server.
    #[serde(default)]
    pub enabled: bool,

    /// Bind address for the health server. Default `127.0.0.1:8080` —
    /// LOCALHOST ONLY. Operators MUST explicitly reconfigure to route
    /// externally (e.g. `0.0.0.0:8080` or a specific interface);
    /// default is intentionally non-routable per SL-2 defense-in-depth.
    #[serde(default = "default_health_bind")]
    pub bind: String,
}

fn default_health_bind() -> String {
    "127.0.0.1:8080".to_string()
}

impl Default for HealthServerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: default_health_bind(),
        }
    }
}

// =============================================================================
// OfflineQueueConfig — Batch 15 ARC-002 (OfflineQueue wire)
// =============================================================================
//
// WHY: Plan §5 Faz 1 Step 1.3 — `offline_queue.rs` (1527 lines) implements
// a SQLCipher-backed durable queue for telemetry that was NOT YET wired
// into the MQTT publish path. Pre-Batch-15: when broker is unreachable,
// in-flight telemetry is simply dropped. ADR-020 §6 + IEC 62443 FR6
// Timely Response require queue-and-forward so no telemetry is lost
// across transient broker outages.
//
// WHAT: Config struct with:
//   - `enabled` — master toggle (default false per plan HC-6 rollout
//     discipline; explicit opt-in per deployment).
//   - `db_path_override` — Option<PathBuf>. When None, uses
//     `${SUDERRA_DATA_DIR}/offline_queue.db` (default
//     `/var/lib/suderra/offline_queue.db`). Operator override for
//     non-standard layouts.
//   - `max_size` — row count cap. Default 10_000 telemetry messages
//     (~10MB at 1KB avg/msg). After cap, drop_oldest_low_priority.
//   - `max_age_secs` — row TTL. Default 7 days (604800s). Older rows
//     auto-expunged on enqueue.
//   - `max_disk_bytes` — disk cap. Default 100MB (104857600). SQLCipher
//     + indexes overhead considered.
//
// OBS-15-001 (session-observations.md): SQLCipher key is derived from
// machine-id today (plan HC-5 flags this as needing replacement by
// HKDF(master_key) per Sprint 6.3 keystore runtime). Batch 15 uses the
// existing v1.6.0 machine-id derivation to preserve HC-1 backward-
// compat. Migration tracked.
//
// INVARIANT: When `enabled == false`, the AsyncOfflineQueue is not
// constructed; the MQTT publish path (Sprint 6.2 wiring) falls back to
// the current v1.6.0 drop-on-disconnect behavior. When enabled but DB
// open fails, boot FAILS-CLOSED (fatal error) — a declared-enabled queue
// that silently isn't running would hide data-loss from operators.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineQueueConfig {
    /// Master toggle.
    #[serde(default)]
    pub enabled: bool,

    /// Optional path override. None → `${SUDERRA_DATA_DIR}/offline_queue.db`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub db_path_override: Option<std::path::PathBuf>,

    /// Maximum row count before drop_oldest_low_priority kicks in.
    #[serde(default = "default_offline_max_size")]
    pub max_size: usize,

    /// Maximum row age in seconds. 0 = no expiration (not recommended).
    #[serde(default = "default_offline_max_age_secs")]
    pub max_age_secs: u64,

    /// Maximum disk footprint in bytes. 0 = no limit (not recommended).
    #[serde(default = "default_offline_max_disk_bytes")]
    pub max_disk_bytes: u64,
}

fn default_offline_max_size() -> usize {
    10_000
}

fn default_offline_max_age_secs() -> u64 {
    7 * 24 * 60 * 60 // 7 days
}

fn default_offline_max_disk_bytes() -> u64 {
    100 * 1024 * 1024 // 100 MB
}

impl Default for OfflineQueueConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            db_path_override: None,
            max_size: default_offline_max_size(),
            max_age_secs: default_offline_max_age_secs(),
            max_disk_bytes: default_offline_max_disk_bytes(),
        }
    }
}

// =============================================================================
// BackupConfig — Batch 18 ARC-009 (backup.rs wire, GDPR Art 20)
// =============================================================================
//
// WHY: Plan §5 Faz 1 Step 8 + ADR-020 §6 — `backup.rs` (715 lines)
// implements config/script/FB/SQLite snapshot → gzipped binary export.
// Pre-Batch-18 the module was dead-code; no way to dump device state
// for GDPR Art 20 portability requests or disaster recovery.
//
// WHAT:
//   - `enabled: bool` (default false) — master toggle.
//   - `backup_dir: Option<PathBuf>` — override. None →
//     `${SUDERRA_DATA_DIR}/backups/` (default `/var/lib/suderra/backups/`,
//     Batch 4a systemd-whitelisted).
//   - `max_backups: usize` (default 10) — retention cap; older
//     backups auto-deleted after each create (BackupManager::
//     cleanup_old_backups).
//
// OBS-18-001 (session-observations.md): scheduled/periodic backup is
// NOT wired. Operators must manually trigger via future HTTP endpoint
// OR `suderra-agent backup-create` CLI subcommand (Sprint 6.x).
// Current batch wires the manager; triggering landing in Sprint 6.x.
//
// OBS-18-002 (session-observations.md): `BACKUP_AUTH_SECRET` env var
// already loaded by `BackupManager::new()` for HTTP auth defense, but
// no HTTP endpoint yet exists. Sprint 6.x HTTP wiring inherits the
// existing secret validation via `BackupManager::validate_auth()`.
//
// INVARIANT: enabled=true + backup_dir unwritable → fail-closed boot.
// A declared-enabled backup that silently can't write would give
// operators false confidence their data is being captured.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupConfig {
    /// Master toggle for the backup manager.
    #[serde(default)]
    pub enabled: bool,

    /// Optional backup directory override. None →
    /// `${SUDERRA_DATA_DIR}/backups/`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub backup_dir: Option<std::path::PathBuf>,

    /// Maximum number of backup files to keep on disk. Older backups
    /// are auto-deleted after each `create_backup()` call.
    #[serde(default = "default_backup_max_count")]
    pub max_backups: usize,
}

fn default_backup_max_count() -> usize {
    10
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            backup_dir: None,
            max_backups: default_backup_max_count(),
        }
    }
}

/// Custom Debug implementation that masks the password
impl fmt::Debug for MqttConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MqttConfig")
            .field("broker", &self.broker)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("tls", &self.tls)
            .field("topics", &self.topics)
            .field("keepalive_secs", &self.keepalive_secs)
            .field("clean_session", &self.clean_session)
            .field("last_will_topic", &self.last_will_topic)
            .field("failover", &self.failover)
            .finish()
    }
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

    /// Capabilities topic pattern (publish at boot)
    /// v2.3: Reports hardware capabilities for auto-detection
    #[serde(default = "default_capabilities_topic")]
    pub capabilities: String,

    /// I/O data topic pattern (publish process image values)
    #[serde(default = "default_io_data_topic")]
    pub io_data: String,

    /// Alarms topic pattern (publish alarm events)
    #[serde(default = "default_alarms_topic")]
    pub alarms: String,

    /// LoRa events topic pattern (v1.5.0: publish LoRaWAN uplink/join events)
    #[serde(default = "default_lora_events_topic")]
    pub lora_events: String,

    /// **Batch #302 Faz 4 step 5.** Per-task scheduler stats
    /// telemetry topic pattern. The task_stats publisher loop
    /// emits a JSON snapshot of every task's TaskStats
    /// (cycle_ms_min/max/avg, jitter_ms_*, overrun_count,
    /// watchdog_kill_count) at a configurable interval (default
    /// 30s) so operators see scheduler health without parsing
    /// agent internals. Plan §5 Faz 4 step 5 canonical path.
    #[serde(default = "default_task_stats_topic")]
    pub task_stats: String,
}

impl Default for MqttTopics {
    fn default() -> Self {
        Self {
            status: default_status_topic(),
            telemetry: default_telemetry_topic(),
            responses: default_responses_topic(),
            commands: default_commands_topic(),
            config: default_config_topic(),
            capabilities: default_capabilities_topic(),
            io_data: default_io_data_topic(),
            alarms: default_alarms_topic(),
            lora_events: default_lora_events_topic(),
            task_stats: default_task_stats_topic(),
        }
    }
}

impl MqttTopics {
    /// Resolve topic pattern with actual tenant_id and device_id
    ///
    /// v1.2.3: Added validation for unresolved placeholders
    pub fn resolve(&self, tenant_id: &str, device_id: &str) -> ResolvedTopics {
        let resolved = ResolvedTopics {
            status: self
                .status
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            telemetry: self
                .telemetry
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            responses: self
                .responses
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            commands: self
                .commands
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            config: self
                .config
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            capabilities: self
                .capabilities
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            io_data: self
                .io_data
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            alarms: self
                .alarms
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            lora_events: self
                .lora_events
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
            // Batch #302 Faz 4 step 5: task_stats topic resolve
            task_stats: self
                .task_stats
                .replace("{tenant_id}", tenant_id)
                .replace("{device_id}", device_id),
        };

        // v1.2.3: Validate that all placeholders were resolved
        resolved.validate_no_placeholders();

        resolved
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
    /// v2.3: Hardware capabilities report topic
    pub capabilities: String,
    /// I/O data topic for process image values
    pub io_data: String,
    /// Alarm events topic
    pub alarms: String,
    /// LoRa events topic (v1.5.0)
    pub lora_events: String,
    /// **Batch #302 Faz 4 step 5.** Per-task scheduler stats
    /// telemetry topic — populated by the task_stats publisher
    /// loop on a configurable interval (default 30s).
    pub task_stats: String,
}

impl ResolvedTopics {
    /// Check if a topic contains unresolved placeholders (v1.2.3)
    fn contains_placeholder(topic: &str) -> bool {
        topic.contains("{") && topic.contains("}")
    }

    /// Validate that no placeholders remain after resolution (v1.2.3)
    ///
    /// Logs warnings for any unresolved placeholders which may cause
    /// MQTT connection issues.
    fn validate_no_placeholders(&self) {
        let topics = [
            ("status", &self.status),
            ("telemetry", &self.telemetry),
            ("responses", &self.responses),
            ("commands", &self.commands),
            ("config", &self.config),
            ("capabilities", &self.capabilities),
            ("io_data", &self.io_data),
            ("alarms", &self.alarms),
            ("lora_events", &self.lora_events),
            // Batch #302 Faz 4 step 5: include task_stats in
            // the validation sweep so an unresolved placeholder
            // there surfaces with the same operator-visible
            // warning as the other topics.
            ("task_stats", &self.task_stats),
        ];

        for (name, topic) in topics {
            if Self::contains_placeholder(topic) {
                warn!(
                    "MQTT {} topic contains unresolved placeholder: '{}'. \
                    This may cause connection issues. Check your topic configuration.",
                    name, topic
                );
            }
        }
    }
}

/// OpenTelemetry OTLP configuration (optional, requires "telemetry" feature)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OtlpConfig {
    /// OTLP endpoint URL (e.g., "http://localhost:4317")
    /// If not set, OpenTelemetry export is disabled
    pub endpoint: Option<String>,

    /// Service name for traces
    #[serde(default = "default_service_name")]
    pub service_name: String,

    /// Sample ratio (0.0 to 1.0, default 1.0 = sample all)
    #[serde(default = "default_sample_ratio")]
    pub sample_ratio: f64,
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

    /// Include system metrics (uptime, load average)
    #[serde(default = "default_true")]
    pub include_system: bool,

    /// Include Modbus device readings
    #[serde(default = "default_true")]
    pub include_modbus: bool,

    /// Include GPIO pin states
    #[serde(default = "default_true")]
    pub include_gpio: bool,

    /// Include I2C device readings
    #[serde(default = "default_true")]
    pub include_i2c: bool,

    /// I/O data publish interval in milliseconds
    #[serde(default = "default_io_data_interval")]
    pub io_data_interval_ms: u64,

    /// OpenTelemetry OTLP export configuration (optional)
    #[serde(default)]
    pub otlp: OtlpConfig,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            interval_seconds: default_telemetry_interval(),
            include_cpu: true,
            include_memory: true,
            include_disk: true,
            include_temperature: true,
            include_system: true,
            include_modbus: true,
            include_gpio: true,
            include_i2c: true,
            io_data_interval_ms: default_io_data_interval(),
            otlp: OtlpConfig::default(),
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

/// Cache configuration for Moka (v1.2.0)
///
/// Used for caching sensor readings, computed values, and script outputs
/// to reduce latency and prevent excessive recomputation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    /// Maximum number of entries in the cache
    #[serde(default = "default_cache_max_capacity")]
    pub max_capacity: u64,

    /// Time-to-live for cache entries in seconds (0 = no TTL)
    #[serde(default = "default_cache_ttl_secs")]
    pub ttl_secs: u64,

    /// Time-to-idle for cache entries in seconds (0 = no TTI)
    /// Entry expires if not accessed within this time
    #[serde(default = "default_cache_tti_secs")]
    pub tti_secs: u64,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            max_capacity: default_cache_max_capacity(),
            ttl_secs: default_cache_ttl_secs(),
            tti_secs: default_cache_tti_secs(),
        }
    }
}

/// Circuit breaker configuration (v1.2.0)
///
/// Controls fault isolation behavior for external service calls
/// (Modbus devices, MQTT, APIs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    /// Number of failures before opening the circuit
    #[serde(default = "default_cb_failure_threshold")]
    pub failure_threshold: u32,

    /// Number of successes in half-open state to close the circuit
    #[serde(default = "default_cb_success_threshold")]
    pub success_threshold: u32,

    /// Time in seconds to wait before attempting recovery (half-open)
    #[serde(default = "default_circuit_breaker_recovery_secs")]
    pub recovery_secs: u64,

    /// Maximum concurrent requests allowed in half-open state
    #[serde(default = "default_cb_half_open_permits")]
    pub half_open_permits: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: default_cb_failure_threshold(),
            success_threshold: default_cb_success_threshold(),
            recovery_secs: default_circuit_breaker_recovery_secs(),
            half_open_permits: default_cb_half_open_permits(),
        }
    }
}

/// Scripting configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptingConfig {
    /// Enable script execution
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Default scan cycle interval in milliseconds (10-10000)
    #[serde(default = "default_scan_cycle_ms")]
    pub default_scan_cycle_ms: u64,

    /// Minimum allowed scan cycle (ms)
    #[serde(default = "default_min_scan_cycle_ms")]
    pub min_scan_cycle_ms: u64,

    /// Maximum allowed scan cycle (ms)
    #[serde(default = "default_max_scan_cycle_ms")]
    pub max_scan_cycle_ms: u64,

    /// Maximum function blocks per program
    #[serde(default = "default_max_function_blocks")]
    pub max_function_blocks: usize,

    /// Maximum script execution depth (nested calls)
    #[serde(default = "default_max_execution_depth")]
    pub max_execution_depth: usize,

    /// Maximum actions per script execution
    #[serde(default = "default_max_actions")]
    pub max_actions: usize,

    /// Maximum execution time per script (seconds)
    #[serde(default = "default_max_execution_time_secs")]
    pub max_execution_time_secs: u64,

    /// Batch 169 Faz 3 (plan R-1): path to the SQLCipher
    /// file that persists deployed ST bytecode programs
    /// across reboots. Empty string (default) disables
    /// persistence — in-memory registry only. Set to
    /// e.g. `/var/lib/suderra/bytecode_registry.db` for
    /// production deployments.
    #[serde(default)]
    pub bytecode_store_path: String,

    /// Batch 192 Faz 4 (plan R-3): multi-task scheduler
    /// configuration. Empty vector (default) runs the
    /// legacy single-cadence bytecode scan-cycle loop
    /// (Batch 170). Populated → main.rs boot sequence
    /// constructs a `TaskScheduler` + spawns the
    /// scheduler cadence loop + event listener in
    /// place of the single-cadence loop.
    ///
    /// Backward compat: existing config.yaml files
    /// without a `tasks:` key deserialize to an empty
    /// Vec (via serde default) and get the single-
    /// cadence behavior unchanged.
    #[serde(default)]
    pub tasks: Vec<crate::scripting::task_scheduler::TaskConfig>,

    /// Batch 202 Faz 6 (plan R-9): path to the
    /// SQLCipher file that persists
    /// `persist_across_reboot=true` force entries
    /// across reboots. Empty string (default)
    /// disables persistence — `force_value` commands
    /// with `persist_across_reboot: true` still
    /// succeed in memory but DON'T survive reboot
    /// (operator sees `persisted: false` flag in the
    /// response + a warn log).
    ///
    /// Set to e.g.
    /// `/var/lib/suderra/force_registry.db` for
    /// production edges supporting long-running
    /// diagnostics.
    #[serde(default)]
    pub force_store_path: String,

    /// **Batch #302 Faz 4 step 5 closure.** Per-task
    /// scheduler stats publish interval (seconds). Plan §5
    /// Faz 4 step 5 default 30s. Validated bounds: 5..=3600.
    /// Below 5s would saturate the broker queue with
    /// observability traffic; above 3600s would lose too
    /// much visibility for operators monitoring SLO tier
    /// compliance. The publisher loop spawns ONLY when
    /// `tasks: [...]` is non-empty (single-cadence legacy
    /// path doesn't have per-task stats so doesn't need the
    /// publisher).
    #[serde(default = "default_task_stats_interval_secs")]
    pub task_stats_publish_interval_secs: u64,
}

impl Default for ScriptingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            default_scan_cycle_ms: default_scan_cycle_ms(),
            min_scan_cycle_ms: default_min_scan_cycle_ms(),
            max_scan_cycle_ms: default_max_scan_cycle_ms(),
            max_function_blocks: default_max_function_blocks(),
            max_execution_depth: default_max_execution_depth(),
            max_actions: default_max_actions(),
            max_execution_time_secs: default_max_execution_time_secs(),
            bytecode_store_path: String::new(),
            tasks: Vec::new(),
            force_store_path: String::new(),
            task_stats_publish_interval_secs: default_task_stats_interval_secs(),
        }
    }
}

/// Runtime/resilience configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    /// Command rate limit: max commands per window
    #[serde(default = "default_rate_limit_max")]
    pub rate_limit_max_commands: usize,

    /// Command rate limit: window in seconds
    #[serde(default = "default_rate_limit_window_secs")]
    pub rate_limit_window_secs: u64,

    /// GPIO operation timeout in seconds
    #[serde(default = "default_gpio_timeout_secs")]
    pub gpio_timeout_secs: u64,

    /// Modbus operation timeout in seconds
    #[serde(default = "default_modbus_timeout_secs")]
    pub modbus_timeout_secs: u64,

    /// Modbus connection timeout in seconds
    #[serde(default = "default_modbus_connect_timeout_secs")]
    pub modbus_connect_timeout_secs: u64,

    /// Circuit breaker recovery time in seconds
    #[serde(default = "default_circuit_breaker_recovery_secs")]
    pub circuit_breaker_recovery_secs: u64,

    /// Provisioning API timeout in seconds
    #[serde(default = "default_provisioning_timeout_secs")]
    pub provisioning_timeout_secs: u64,

    /// Shutdown timeout in seconds. OUTER budget for the whole
    /// graceful-shutdown sequence (signal → drain → safe-state →
    /// flush → disconnect MQTT). Individual tasks timed out
    /// inside shutdown_coordinator.shutdown() use this value.
    #[serde(default = "default_shutdown_timeout_secs")]
    pub shutdown_timeout_secs: u64,

    /// Per-task DRAIN budget in milliseconds (plan D-15).
    /// In-flight commands get at most this duration between
    /// shutdown signal and force-cancel. Separate from the
    /// outer `shutdown_timeout_secs` because drain is per-task
    /// while shutdown_timeout bounds the whole sequence.
    /// Default 50ms matches plan D-15 specification.
    #[serde(default = "default_drain_timeout_ms")]
    pub drain_timeout_ms: u64,

    /// Maximum acceptable command age in seconds (IEC 62443
    /// SL-2 FR-7 replay protection). Commands older than this
    /// are rejected to bound the replay window on a compromised
    /// QoS 1 redelivery path. Batch 34: exposed as config
    /// (pre-Batch-34 was a hardcoded 300s constant). Default
    /// 300s (5 minutes) matches pre-Batch-34 hardcoded value.
    /// Tightening to 60s is a common hardening posture for
    /// well-synced NTS fleets; operators must first verify
    /// clock skew across all devices is within the new window.
    #[serde(default = "default_max_command_age_secs")]
    pub max_command_age_secs: u64,

    /// Maximum acceptable command CLOCK-SKEW in seconds — the
    /// negative-age tolerance for commands whose RFC3339
    /// timestamp is FUTURE-dated (cloud clock ahead of edge
    /// clock). Batch 34 exposes as config; default 60s matches
    /// pre-Batch-34 hardcoded value. Tighten only after fleet-
    /// wide NTS sync is verified.
    #[serde(default = "default_max_command_skew_secs")]
    pub max_command_skew_secs: u64,

    /// MQTT reconnect minimum delay in seconds
    #[serde(default = "default_mqtt_reconnect_min_secs")]
    pub mqtt_reconnect_min_secs: u64,

    /// MQTT reconnect maximum delay in seconds
    #[serde(default = "default_mqtt_reconnect_max_secs")]
    pub mqtt_reconnect_max_secs: u64,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            rate_limit_max_commands: default_rate_limit_max(),
            rate_limit_window_secs: default_rate_limit_window_secs(),
            gpio_timeout_secs: default_gpio_timeout_secs(),
            modbus_timeout_secs: default_modbus_timeout_secs(),
            modbus_connect_timeout_secs: default_modbus_connect_timeout_secs(),
            circuit_breaker_recovery_secs: default_circuit_breaker_recovery_secs(),
            provisioning_timeout_secs: default_provisioning_timeout_secs(),
            shutdown_timeout_secs: default_shutdown_timeout_secs(),
            drain_timeout_ms: default_drain_timeout_ms(),
            max_command_age_secs: default_max_command_age_secs(),
            max_command_skew_secs: default_max_command_skew_secs(),
            mqtt_reconnect_min_secs: default_mqtt_reconnect_min_secs(),
            mqtt_reconnect_max_secs: default_mqtt_reconnect_max_secs(),
        }
    }
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            file: default_log_file(),
        }
    }
}

// ============================================================================
// LoRaWAN Configuration (v1.5.0)
// ============================================================================

/// LoRaWAN gateway configuration
///
/// Configures the SX1302 concentrator, regional parameters,
/// and pre-registered LoRa end-devices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoRaWanConfig {
    /// Enable LoRaWAN gateway functionality
    #[serde(default)]
    pub enabled: bool,

    /// LoRa frequency region plan (EU868, US915, AS923, etc.)
    pub region: String,

    /// Network ID — 3-byte hex string (e.g. "000001")
    pub net_id: String,

    /// SPI device path for SX1302 (e.g. "/dev/spidev0.0")
    #[serde(default = "default_spi_device")]
    pub spi_device: String,

    /// GPIO pin for SX1302 hardware reset (0 = no hardware reset)
    #[serde(default)]
    pub reset_gpio_pin: u8,

    /// Channel frequency configuration (optional, uses region defaults if empty)
    #[serde(default)]
    pub channels: Vec<LoRaChannelConfig>,

    /// Pre-registered LoRa end-devices
    #[serde(default)]
    pub devices: Vec<LoRaDeviceConfigYaml>,

    /// RX1 receive window delay (seconds, default 1)
    #[serde(default = "default_rx1_delay")]
    pub rx1_delay: u8,

    /// Maximum number of LoRa devices (default 100)
    #[serde(default = "default_max_devices")]
    pub max_devices: usize,

    /// SQLite session database path
    #[serde(default = "default_session_db_path")]
    pub session_db_path: String,
}

/// LoRa channel frequency configuration
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoRaChannelConfig {
    /// Channel index (0-7 for SX1302)
    pub index: u8,
    /// Center frequency in Hz (e.g. 868100000)
    pub freq_hz: u32,
    /// Minimum spreading factor (7-12)
    #[serde(default = "default_sf_min")]
    pub sf_min: u8,
    /// Maximum spreading factor (7-12)
    #[serde(default = "default_sf_max")]
    pub sf_max: u8,
    /// Bandwidth in kHz (125, 250, 500)
    #[serde(default = "default_bandwidth")]
    pub bandwidth_khz: u32,
}

/// LoRa device YAML configuration (string-based for config file)
///
/// Parsed into `LoRaDeviceConfig` at runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoRaDeviceConfigYaml {
    /// Device EUI (16 hex chars, e.g. "0102030405060708")
    pub dev_eui: String,
    /// Application EUI (16 hex chars)
    pub app_eui: String,
    /// Application Key (32 hex chars)
    pub app_key: String,
    /// Activation mode: "otaa" or "abp"
    #[serde(default = "default_activation")]
    pub activation: String,
    /// Device class: "A", "B", or "C"
    #[serde(default = "default_device_class")]
    pub device_class: String,
    /// Tag name prefix for process image (e.g. "lora_sensor1_")
    #[serde(default)]
    pub tag_prefix: String,
    /// Payload codec: "cayenne_lpp", "raw_binary", or custom decoder name
    #[serde(default = "default_codec")]
    pub codec: String,
    /// RX1 delay override (seconds)
    #[serde(default)]
    pub rx1_delay_secs: Option<u32>,
    /// RX2 data rate override
    #[serde(default)]
    pub rx2_datarate: Option<u8>,
    /// RX2 frequency override (Hz)
    #[serde(default)]
    pub rx2_freq_hz: Option<u32>,
    /// Adaptive Data Rate enabled
    #[serde(default)]
    pub adr_enabled: bool,
}

fn default_spi_device() -> String {
    "/dev/spidev0.0".to_string()
}
fn default_rx1_delay() -> u8 {
    1
}
fn default_max_devices() -> usize {
    100
}
fn default_session_db_path() -> String {
    "/var/lib/suderra/lora_sessions.db".to_string()
}
fn default_sf_min() -> u8 {
    7
}
fn default_sf_max() -> u8 {
    12
}
fn default_bandwidth() -> u32 {
    125
}
fn default_activation() -> String {
    "otaa".to_string()
}
fn default_device_class() -> String {
    "A".to_string()
}
fn default_codec() -> String {
    "cayenne_lpp".to_string()
}

/// Modbus security configuration (IEC 62443 SL2 FR3/FR5)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusSecurityConfig {
    /// Enable security checks
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Allowed Modbus function codes (whitelist)
    /// Default: [1, 2, 3, 4] (read coils, discrete inputs, holding/input registers)
    #[serde(default = "default_modbus_function_whitelist")]
    pub allowed_function_codes: Vec<u8>,

    /// Rate limit: maximum operations per second
    #[serde(default = "default_modbus_rate_limit")]
    pub rate_limit_ops_per_sec: u64,

    /// Rate limit: burst capacity (max concurrent ops)
    #[serde(default = "default_modbus_burst_capacity")]
    pub rate_limit_burst: u64,

    /// Maximum register count per read operation
    #[serde(default = "default_max_register_count")]
    pub max_register_count: u16,

    /// Allow write operations (coils and registers)
    #[serde(default)]
    pub allow_writes: bool,

    /// Whitelist of register address ranges allowed for write operations.
    /// When non-empty, write_register/write_coil must target an address within
    /// one of these ranges. Prevents a compromised cloud credential from writing
    /// to arbitrary holding registers (pump relays, dosing actuators, VFD frequency).
    /// Format: [(start, end)] inclusive ranges.
    #[serde(default)]
    pub allowed_write_ranges: Vec<(u16, u16)>,

    /// Explicitly allow every write address when allow_writes=true.
    ///
    /// 2026-04-29: Empty `allowed_write_ranges` used to mean "all addresses",
    /// which made broad write authority easy to enable accidentally. This flag
    /// turns that posture into a named, auditable operator decision.
    #[serde(default)]
    pub allow_all_write_addresses: bool,

    /// Verify FC6 register writes by reading the holding register back.
    ///
    /// 2026-04-29: A protocol ACK only proves the device accepted the request.
    /// Readback verifies the physical/logical register reached the requested
    /// value and catches PLC-side clamps, rejected writes hidden behind ACKs, or
    /// wrong-address configuration.
    #[serde(default = "default_modbus_write_readback")]
    pub verify_write_readback: bool,

    /// Number of extra readback attempts after the first read.
    #[serde(default = "default_modbus_write_readback_retries")]
    pub write_readback_retries: u8,

    /// Delay before each readback attempt.
    #[serde(default = "default_modbus_write_readback_settle_ms")]
    pub write_readback_settle_ms: u64,
}

fn default_modbus_write_readback() -> bool {
    true
}

fn default_modbus_write_readback_retries() -> u8 {
    1
}

fn default_modbus_write_readback_settle_ms() -> u64 {
    25
}

impl Default for ModbusSecurityConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            allowed_function_codes: default_modbus_function_whitelist(),
            rate_limit_ops_per_sec: default_modbus_rate_limit(),
            rate_limit_burst: default_modbus_burst_capacity(),
            max_register_count: default_max_register_count(),
            allow_writes: false,
            allowed_write_ranges: Vec::new(),
            allow_all_write_addresses: false,
            verify_write_readback: default_modbus_write_readback(),
            write_readback_retries: default_modbus_write_readback_retries(),
            write_readback_settle_ms: default_modbus_write_readback_settle_ms(),
        }
    }
}

/// Modbus TLS configuration (v1.2.0 - IEC 62443 SL2 FR4: Data Confidentiality)
///
/// Enables encrypted Modbus/TCP communication using TLS.
/// Supports both server authentication and mutual TLS (mTLS).
///
/// Serde-deserialized from YAML as the backward-compat wire
/// format. Consumers should call `to_mode()` at load time to
/// convert to the type-level `TlsMode` enum (Batch 22 ARC-007)
/// which encodes "server-only vs mTLS vs disabled" at the Rust
/// type level and prevents the `client_cert set but client_key
/// missing` class of misconfiguration from being representable
/// in the consumer path.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModbusTlsConfig {
    /// Enable TLS encryption for Modbus TCP
    #[serde(default)]
    pub enabled: bool,

    /// Server name for SNI (Server Name Indication)
    /// Required when connecting to TLS-enabled Modbus servers
    pub server_name: Option<String>,

    /// CA certificate path for server verification
    pub ca_cert_path: Option<String>,

    /// Client certificate path (for mutual TLS / mTLS)
    pub client_cert_path: Option<String>,

    /// Client private key path (for mutual TLS / mTLS)
    pub client_key_path: Option<String>,

    /// Skip server certificate verification (NOT recommended for production)
    #[serde(default)]
    pub insecure_skip_verify: bool,
}

impl ModbusTlsConfig {
    /// Convert the serde-deserialized config to the type-level
    /// `TlsMode` enum. Fails at load time on any invalid
    /// combination (e.g., client cert set without client key,
    /// TLS enabled without server_name + ca_cert_path).
    ///
    /// Batch 22 ARC-007: this is the tier-1 "make it impossible"
    /// boundary. Downstream consumers pattern-match on TlsMode
    /// and cannot observe half-configured TLS state.
    pub fn to_mode(&self) -> Result<TlsMode, String> {
        if !self.enabled {
            return Ok(TlsMode::Disabled);
        }

        let server_name = self.server_name.as_ref().ok_or_else(|| {
            "TLS enabled but `server_name` is missing (required for SNI validation)".to_string()
        })?;
        let ca_cert_path = self.ca_cert_path.as_ref().ok_or_else(|| {
            "TLS enabled but `ca_cert_path` is missing (required for server cert validation)"
                .to_string()
        })?;

        match (self.client_cert_path.as_ref(), self.client_key_path.as_ref()) {
            (None, None) => Ok(TlsMode::ServerOnly {
                server_name: server_name.clone(),
                ca_cert_path: ca_cert_path.clone(),
                insecure_skip_verify: self.insecure_skip_verify,
            }),
            (Some(cert), Some(key)) => Ok(TlsMode::Full {
                server_name: server_name.clone(),
                ca_cert_path: ca_cert_path.clone(),
                client_cert_path: cert.clone(),
                client_key_path: key.clone(),
                insecure_skip_verify: self.insecure_skip_verify,
            }),
            (Some(_), None) => Err(
                "TLS mTLS requires both `client_cert_path` and `client_key_path`; `client_key_path` is missing"
                    .to_string(),
            ),
            (None, Some(_)) => Err(
                "TLS mTLS requires both `client_cert_path` and `client_key_path`; `client_cert_path` is missing"
                    .to_string(),
            ),
        }
    }
}

// ============================================================================
// RbacManifestConfig — Batch 66 plan §3 R-5 / ADR-018 / Sprint 6.1
// ============================================================================
//
// WHY: Plan §3 R-5 + ADR-018 mandate a cloud-signed RBAC manifest that
// carries operator→role bindings + custom role→permission bindings.
// The edge loads this manifest at boot + on MQTT `update_policy` commands
// (hot-reload per ADR-018 §8). Envelope signature verification (Batch 63
// Gate 7) requires the operator's ed25519 pubkey, which is looked up from
// the verified manifest's `operator_bindings`.
//
// Pre-Sprint-6.1 MODE gate follows the Disabled/Permissive/Enforcing
// discipline consistent with Batches 27/42/45/56 (mtls/config_integrity/
// signature_mode/clock). Operators tuning config.yaml get predictable
// knob semantics regardless of which security surface they're configuring.

/// RBAC manifest verification mode. 3-stage rollout pattern
/// identical to ConfigIntegrityMode / SignatureMode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RbacManifestMode {
    /// No manifest load (pre-Batch-66 behavior). HC-1 backward
    /// compat default — envelope signature verify falls to the
    /// Batch 63 NO-OP closure.
    #[default]
    Disabled,
    /// Manifest loaded + verified; lookup failures log-only.
    /// Early-detection posture for operator migration.
    Permissive,
    /// Manifest required; lookup failures reject.
    Enforcing,
}

/// RBAC manifest loader knobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RbacManifestConfig {
    /// Rollout mode: disabled / permissive / enforcing.
    #[serde(default)]
    pub mode: RbacManifestMode,

    /// Hex-encoded 32-byte ed25519 pubkey for manifest
    /// signature verify. Plan §3 R-4 specifies 3 ayrı keypair
    /// (firmware + rbac_manifest + command); this is the
    /// MANIFEST signing key, distinct from config_integrity
    /// (factory) + command (operator-per-operator). Sprint
    /// 6.1 wires firmware-embedded default; pre-Sprint-6.1
    /// operators supply their own test key.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub manifest_signing_pubkey_hex: Option<String>,

    /// Manifest file path override. None →
    /// `/etc/suderra/rbac_manifest.json`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub manifest_path: Option<std::path::PathBuf>,

    /// Persistent `highest_seen_policy_version` store path
    /// override (Batch 71). None →
    /// `/var/lib/suderra/rbac_version.sqlite`.
    ///
    /// WHY separate from `offline_queue.sqlite` +
    /// `scada_db.sqlite`: single-responsibility — a
    /// `DROP TABLE` or corruption in one domain's database
    /// cannot cascade into the RBAC rollback-protection
    /// invariant. SQLCipher-encrypted via the shared
    /// `offline_queue::derive_db_encryption_key()` helper.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version_store_path: Option<std::path::PathBuf>,
}

impl Default for RbacManifestConfig {
    fn default() -> Self {
        Self {
            mode: RbacManifestMode::default(),
            manifest_signing_pubkey_hex: None,
            manifest_path: None,
            version_store_path: None,
        }
    }
}

/// User-token manifest loader knobs (Batch #249b Faz 5 A-3c wire).
///
/// Parallel to [`RbacManifestConfig`] but gates the OPC UA
/// UserName/Password + X.509 credential side. Distinct signing key
/// (ADR-021 slot 4) + distinct monotonic version stream
/// (ManifestVersionStore::STREAM_ID_USER_TOKEN per Batch #246) so
/// credential rotation is independent of RBAC role rotation.
///
/// **No `mode` field.** The user-token manifest does not need the
/// RBAC manifest's staged-rollout modes (Disabled / Permissive /
/// Enforcing). Authentication is either enrolled (manifest
/// ingested, signing pubkey configured) or NOT enrolled
/// (UserTokenValidator fails closed with NoManifestLoaded). There
/// is no "permissive" middle state — an unauthenticated session
/// cannot upgrade by skipping the check.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserTokenManifestConfig {
    /// Hex-encoded 32-byte ed25519 pubkey for user-token manifest
    /// signature verify (ADR-021 slot 4 / Plan B R-4 3-key
    /// segregation). When `None`, `cmd_update_user_token_manifest`
    /// rejects with `SigningPubkeyNotConfigured` — operator must
    /// populate via config.yaml before the cloud can push
    /// enrollments. No default: the edge agent does not embed a
    /// fallback pubkey.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub manifest_signing_pubkey_hex: Option<String>,

    /// Persistent `highest_seen_policy_version` store path override
    /// for the user-token stream. None →
    /// `/var/lib/suderra/user_token_version.sqlite`.
    ///
    /// **Separate file from `rbac_version.sqlite`** — intentional
    /// blast-radius isolation. A `DROP TABLE` or corruption in one
    /// stream's database cannot cascade into the other's rollback
    /// defense. SQLCipher-encrypted via the shared
    /// `offline_queue::derive_db_encryption_key()` helper.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version_store_path: Option<std::path::PathBuf>,
}

// ============================================================================
// AuditConfig — Batch 78 Sprint 6.2 Phase 2 / ADR-020 / plan §5 Faz 2 item 8
// ============================================================================
//
// WHY: Plan §5 Faz 2 item 8 + ADR-020 mandate an append-only audit log with
// HMAC chain integrity for every regulated action. Batches 74-77 built the
// sink / recovery / SIGHUP / verify primitives; this config surface wires
// them at boot.
//
// Pre-Sprint-6.3 the HMAC key comes from config hex (operator-supplied
// during rollout). Phase 2 / Batch 80 swaps to KeyPurpose::AuditHmacChain
// derivation from the master key once the keystore lands.

/// Audit sink mode. 2-stage rollout (not 3-stage like mtls/
/// config_integrity/rbac_manifest). Audit sink admits no
/// "permissive" fallback: either it's writing the log or it
/// isn't. Plan §5 Faz 2 item 8 + IEC 62443 SL-2 FR6 mandate
/// audit-on-every-regulated-action for compliant deployments;
/// Disabled targets dev-only + pre-rollout environments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditMode {
    /// No audit sink opened (pre-Batch-78 behavior). HC-1
    /// backward compat default. Command handlers that Phase
    /// 2 / Batch 79 wires audit emit into will log-only.
    #[default]
    Disabled,
    /// Sink opened; pre+post events written on every
    /// regulated action. Boot fails-closed if sink cannot
    /// open (permissions / path). The forensic-trail
    /// invariant per IEC 62443 SL-2 FR6 is non-negotiable —
    /// no "permissive" fallback to log-only.
    Enabled,
}

/// Audit sink configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditConfig {
    /// Rollout mode: disabled / enabled.
    #[serde(default)]
    pub mode: AuditMode,

    /// Audit log file path override. None →
    /// `/var/log/suderra/audit.log`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub log_path: Option<std::path::PathBuf>,

    /// Hex-encoded 32-byte HMAC key for chain integrity.
    /// REQUIRED when mode=Enabled until Phase 2 / Batch 80
    /// wires master-key derivation (Sprint 6.3 keystore
    /// dependency). Operators supply a 64-char lowercase hex
    /// value generated via `openssl rand -hex 32` during
    /// provisioning; rotated on compromise via the standard
    /// operator ceremony.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hmac_key_hex: Option<String>,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            mode: AuditMode::default(),
            log_path: None,
            hmac_key_hex: None,
        }
    }
}

// ============================================================================
// KeystoreConfig — Batch 83 Sprint 6.3 / ADR-018 §4
// ============================================================================
//
// WHY: Plan §5 Faz 2 item 1 + ADR-018 §4 mandate a 3-backend priority
// (TPM > systemd-creds > FileBacked). Batch 82 landed the FileBacked
// implementation; Batch 83 exposes the config surface + AppState field
// wiring. Batches 83a/83b land TPM + systemd-creds backends; pre-
// Batch-84 Auto mode falls back to FileBacked with a warn log.

/// Keystore backend selection policy. `Auto` is the
/// recommended production setting — the runtime probes TPM
/// first, then systemd-creds, then FileBacked. Explicit
/// modes are for test/dev OR operators forcing a specific
/// fallback tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeystoreMode {
    /// No keystore opened. HC-1 backward compat default —
    /// existing deployments using config-supplied hex keys
    /// (audit.hmac_key_hex) keep working. Phase 2 / Batch
    /// 84 migrates those surfaces to KeyPurpose::*-derived
    /// keys when this flips away from Disabled.
    #[default]
    Disabled,
    /// Auto-select: TPM probe -> systemd-creds probe ->
    /// FileBacked (requires acceptance token). Matches
    /// ADR-018 §4 priority order. Pre-TPM-landing (Batch
    /// 83a pending) Auto falls through to FileBacked after
    /// logging the downgrade.
    Auto,
    /// Force FileBacked. Operator-explicit choice; requires
    /// acceptance token + passphrase + salt files.
    FileBacked,
}

/// Keystore knobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeystoreConfig {
    /// Backend selection policy.
    #[serde(default)]
    pub mode: KeystoreMode,

    /// Passphrase file path (FileBacked only). Default:
    /// /etc/suderra/keystore.passphrase (0400 owner:suderra).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub passphrase_path: Option<std::path::PathBuf>,

    /// Salt file path (FileBacked only). Default:
    /// /etc/suderra/keystore.salt (0400 owner:suderra). Must
    /// be >= 16 bytes.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub salt_path: Option<std::path::PathBuf>,

    /// Acceptance token JSON path (FileBacked only). The
    /// operator signs an explicit acknowledgment that file-
    /// backed is used instead of TPM. Default:
    /// /etc/suderra/keystore.acceptance.json.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub acceptance_path: Option<std::path::PathBuf>,

    /// Acceptance-ceremony ed25519 verifying key, 64-char hex
    /// (EDGE-HIGH-011). The acceptance token is signed by the
    /// central PLATFORM_KEY_CEREMONY authority (ADR-018 §5); this is
    /// the trust anchor that keeps the weaker FileBacked master-key
    /// tier unavailable unless the ceremony signed off. REQUIRED in
    /// FileBacked mode — boot fails closed when absent (see the
    /// keystore coherence rule in validate_faz2_security_coherence).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub acceptance_pubkey_hex: Option<String>,

    /// Argon2id memory cost (KiB). Default: 65536 (64 MiB).
    /// Must be >= 19456 (OWASP 2024 floor).
    #[serde(default = "default_argon2_memory_kib")]
    pub argon2_memory_kib: u32,

    /// Argon2id iterations. Default: 3. Must be >= 2.
    #[serde(default = "default_argon2_iterations")]
    pub argon2_iterations: u32,

    /// Argon2id parallelism. Default: 4. Must be >= 1.
    #[serde(default = "default_argon2_parallelism")]
    pub argon2_parallelism: u32,
}

fn default_argon2_memory_kib() -> u32 {
    65_536
}
fn default_argon2_iterations() -> u32 {
    3
}
fn default_argon2_parallelism() -> u32 {
    4
}

impl Default for KeystoreConfig {
    fn default() -> Self {
        Self {
            mode: KeystoreMode::default(),
            passphrase_path: None,
            salt_path: None,
            acceptance_path: None,
            acceptance_pubkey_hex: None,
            argon2_memory_kib: default_argon2_memory_kib(),
            argon2_iterations: default_argon2_iterations(),
            argon2_parallelism: default_argon2_parallelism(),
        }
    }
}

// ============================================================================
// FirmwareUpdateConfig — Batch 114 Sprint 6.5 / ADR-019 §3
// ============================================================================
//
// WHY: Plan §3 R-4 mandates that firmware update payloads carry an ed25519
// signed SignedFirmwareManifest. The `verify_firmware_manifest` function
// (Batch 8) is the fail-closed gate; it takes the verifying pubkey as a
// closure-injected parameter. This config surface wires the operator-facing
// knobs: mode selector + trusted pubkey source.
//
// Rollout mode follows the 3-stage pattern shared with mtls/config_integrity/
// signature_mode/rbac_manifest:
// - Disabled: legacy tarball path only (Batch 20k cmd_update_firmware).
//   HC-1 backward compat default.
// - Permissive: signed manifests accepted + preferred; unsigned tarball
//   fallback warn-logged but still works.
// - Enforcing: unsigned tarball rejected; only SignedFirmwareManifest flow.
//
// ## Signing pubkey source
//
// Plan §3 R-4 specifies 3 distinct keypairs — firmware + rbac_manifest +
// command. The firmware pubkey is distinct from the rbac_manifest pubkey
// (different trust domain: firmware can overwrite the entire stack; RBAC
// cannot). Pre-Sprint-6.5 operators supply via config hex. Post-6.5 a
// firmware-embedded default pubkey covers the factory key + config hex
// overrides for field-rotated keys.

/// Firmware update verification mode. 3-stage rollout pattern
/// identical to RbacManifestMode / ConfigIntegrityMode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FirmwareUpdateMode {
    /// No signed-manifest verification. Legacy tarball OTA
    /// (Batch 20k `cmd_update_firmware`) remains the sole
    /// update path. HC-1 backward compat default.
    #[default]
    Disabled,
    /// Signed-manifest path accepted + preferred. Legacy
    /// tarball OTA still works but warn-logs on invocation.
    /// Operator migration posture.
    Permissive,
    /// Signed-manifest path required. Legacy tarball OTA
    /// rejected at command dispatch.
    Enforcing,
}

/// Lifecycle HTTP endpoint authentication mode (Batch 129
/// Sprint 6.6 hardening — closes Batch 122 obs #1).
///
/// Controls whether `POST /lifecycle/confirm-active`
/// requires a per-request HMAC-SHA256 proving knowledge
/// of a systemd-credential-delivered secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleAuthMode {
    /// No auth beyond localhost-binding + same-UID
    /// isolation. HC-1 backward compat default. Acceptable
    /// for isolated-device deployments; production multi-
    /// tenant-host deployments should enable HmacToken.
    #[default]
    Disabled,
    /// HMAC-SHA256 required on every request. Key loaded
    /// at boot from `$CREDENTIALS_DIRECTORY/<name>` via
    /// systemd LoadCredential. 401 on missing / malformed
    /// / out-of-window / mismatched HMAC.
    HmacToken,
}

/// Lifecycle HTTP endpoint config (Batch 129 Sprint 6.6).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LifecycleEndpointConfig {
    #[serde(default)]
    pub auth_mode: LifecycleAuthMode,

    /// Systemd credential filename within
    /// `$CREDENTIALS_DIRECTORY`. None → default
    /// "lifecycle-hmac-key". Operators with non-default
    /// credential naming override here.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub systemd_credential_name: Option<String>,
}

/// Bootloader backend selector (Batch 128 Sprint 6.5).
///
/// Controls which `BootloaderHandle` implementation the
/// agent constructs at boot time.
///
/// - `Noop` (default): non-RPi deployments. Log-only
///   bootloader coord; PartitionStore state machine
///   still functional for forensic-audit purposes.
/// - `Tryboot`: RPi CM4/5 with tryboot support. Reads +
///   writes `/boot/firmware/autoboot.txt` to flip
///   next-boot slot. Real hardware boot behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BootloaderBackend {
    /// HC-1 backward compat default.
    #[default]
    Noop,
    /// RPi tryboot overlay (autoboot.txt manipulator).
    Tryboot,
}

/// Firmware update verification knobs (Batch 114 Sprint 6.5).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FirmwareUpdateConfig {
    /// Rollout mode: disabled / permissive / enforcing.
    #[serde(default)]
    pub mode: FirmwareUpdateMode,

    /// Hex-encoded 32-byte ed25519 pubkey for
    /// SignedFirmwareManifest signature verify. Distinct
    /// from `rbac_manifest.manifest_signing_pubkey_hex` +
    /// `config_integrity.factory_pubkey_hex` — plan §3 R-4
    /// 3-key segregation. Required when mode != Disabled;
    /// config coherence Rule 20 enforces this.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub signing_pubkey_hex: Option<String>,

    /// Bootloader backend selector (Batch 128 Sprint 6.5).
    /// Defaults to Noop (HC-1 backward compat). Operators
    /// on RPi CM4/5 set this to `tryboot` + configure
    /// `tryboot_autoboot_path` below if non-default.
    #[serde(default)]
    pub bootloader_backend: BootloaderBackend,

    /// Path override for `TrybootBootloaderHandle`
    /// autoboot.txt. None → uses
    /// `DEFAULT_AUTOBOOT_TXT_PATH` (/boot/firmware/autoboot.txt).
    /// Ignored when bootloader_backend != Tryboot.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tryboot_autoboot_path: Option<std::path::PathBuf>,

    /// A/B partition mount paths (Batch 123 Sprint 6.5).
    /// Where the cmd_apply_signed_manifest orchestrator
    /// streams signed firmware files before triggering
    /// the SwapToPending transition.
    ///
    /// WHY: The verify-apply-bootloader pipeline needs to
    /// know WHICH filesystem directory corresponds to
    /// `AbPartition::A` vs `AbPartition::B` so the
    /// streaming step can write to the NON-active slot.
    /// On real RPi hardware these are mount points for
    /// separate partitions (e.g. /mnt/slot-a, /mnt/slot-b).
    /// On x86 dev boxes they can be regular directories.
    ///
    /// None in either slot leaves file-streaming disabled;
    /// the manifest verify-preview path still works but
    /// `cmd_apply_signed_manifest` returns
    /// `gate=slot_mounts_not_configured` until both are
    /// set. Fail-open discipline matches the
    /// `firmware_update.mode=Disabled` path: HC-1 backward
    /// compat for deployments not yet A/B-enabled.
    #[serde(default)]
    pub ab_partitions: AbPartitionMountConfig,
}

impl Default for FirmwareUpdateConfig {
    fn default() -> Self {
        Self {
            mode: FirmwareUpdateMode::default(),
            signing_pubkey_hex: None,
            bootloader_backend: BootloaderBackend::default(),
            tryboot_autoboot_path: None,
            ab_partitions: AbPartitionMountConfig::default(),
        }
    }
}

/// Mount paths for A/B partitions (Batch 123 Sprint 6.5).
///
/// Canonical hardware shape (RPi CM4/5 + tryboot):
/// ```yaml
/// firmware_update:
///   ab_partitions:
///     slot_a_mount: /mnt/slot-a
///     slot_b_mount: /mnt/slot-b
/// ```
///
/// Both None (default) = file-streaming path disabled;
/// operators running in Permissive mode without A/B
/// hardware still get manifest verify-preview but not
/// apply. Coherence Rule 22 catches half-configured
/// scenarios (one set, other None) + fails fast.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AbPartitionMountConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub slot_a_mount: Option<std::path::PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub slot_b_mount: Option<std::path::PathBuf>,
}

impl AbPartitionMountConfig {
    /// True when both mount paths are configured — the
    /// file-streaming path is ready to run.
    pub fn is_fully_configured(&self) -> bool {
        self.slot_a_mount.is_some() && self.slot_b_mount.is_some()
    }
}

// ============================================================================
// EnvelopeDedupConfig — Batch 58 plan §4.10 / Sprint 6.4
// ============================================================================
//
// WHY: Plan §4.10 mandates a 72-hour jti dedup window as replay defense.
// The MokaJtiDedupTable (Batch 57) is the hot-window (seconds-to-minutes)
// tier; Sprint 6.4 full wire adds a SQLCipher persistent tier covering
// the 72-hour window. Batch 58 exposes the Moka tier's operator-tunable
// parameters so:
// - Resource-constrained devices (256 MB RAM per ADR-024 §5) can tighten
//   capacity to 10_000 for ~2 MB footprint.
// - Deployments with high command rate can loosen TTL to 120s to match
//   broker-redelivery timing.

/// Envelope dedup cache configuration (Batch 58).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeDedupConfig {
    /// Moka cache capacity (max live entries). Default 100_000
    /// per crate::command_envelope::DEFAULT_MOKA_CAPACITY.
    /// Tighten on low-RAM deployments; loosen on high-rate
    /// deployments.
    #[serde(default = "default_envelope_dedup_capacity")]
    pub moka_capacity: u64,

    /// Moka cache TTL in seconds. Default 60 per crate::
    /// command_envelope::DEFAULT_MOKA_TTL_SECS. Must fit within
    /// the plan §4.10 72-hour full window; values outside
    /// [30, 3600] are almost certainly operator typos (Batch 58
    /// coherence rule caught at config load).
    #[serde(default = "default_envelope_dedup_ttl_secs")]
    pub moka_ttl_secs: u64,

    /// Enable SQLCipher-persistent tier behind the Moka hot
    /// cache (Batch 92 Sprint 6.4 full wire). Default false
    /// — HC-1 backward compat leaves Moka-only (Batch 57).
    /// Set true for reboot-survive 72-hour replay defense
    /// per plan §4.10 threat model.
    ///
    /// When true, the persistent store is opened at
    /// `/var/lib/suderra/jti_dedup.sqlite` (SQLCipher-
    /// encrypted via the shared derive_db_encryption_key
    /// helper). Consumer is the envelope verify path.
    #[serde(default)]
    pub enable_sqlcipher_persist: bool,

    /// SQLCipher jti-dedup file path override. None →
    /// `/var/lib/suderra/jti_dedup.sqlite`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sqlcipher_path: Option<std::path::PathBuf>,
}

fn default_envelope_dedup_capacity() -> u64 {
    100_000
}

fn default_envelope_dedup_ttl_secs() -> u64 {
    60
}

impl Default for EnvelopeDedupConfig {
    fn default() -> Self {
        Self {
            moka_capacity: default_envelope_dedup_capacity(),
            moka_ttl_secs: default_envelope_dedup_ttl_secs(),
            enable_sqlcipher_persist: false,
            sqlcipher_path: None,
        }
    }
}

// ============================================================================
// ClockConfig — Batch 56 plan D-7 / Sprint 6.7
// ============================================================================
//
// WHY: Plan D-7 mandates NTS-authenticated wall-clock discipline. The
// edge agent uses `CLOCK_MONOTONIC` (via Instant) for TTL enforcement +
// `SystemTime` for audit timestamps, BUT SystemTime must be freshness-
// checked against chronyd's last-sync age. A wall clock whose NTS sync
// is > threshold stale cannot be trusted for regulated-action paths
// (audit timestamps, signature freshness windows).
//
// Pre-Sprint-6.7 SystemClockAuthority (Batch 55) reports
// nts_sync_age_secs=0 unconditionally — the threshold check never fires.
// Sprint 6.7 wires the real chronyd query + fail-closed gate.
//
// ClockConfig is the operator knob: `config.clock.nts_sync_max_skew_secs
// = 3600` today (default); operators can tighten to 300 for SCADA
// deployments that require fresh audit timestamps, or loosen to 86400
// for legacy-device compat during NTS rollout.

/// Clock authority configuration (Batch 56, plan D-7).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClockConfig {
    /// Maximum NTS-sync staleness in seconds. Sprint 6.7
    /// `ChronyNtsClockAuthority.trustworthy_wall_clock()`
    /// returns `Err(NtsSyncStale)` when the last chronyd
    /// re-sync is older than this threshold.
    /// Default 3600s (1 hour) per plan D-7.
    #[serde(default = "default_nts_sync_max_skew_secs")]
    pub nts_sync_max_skew_secs: u64,

    /// Enable chronyc-tracking subprocess query for real
    /// NTS sync age (Batch 90 Sprint 6.7 wire). Default
    /// false — HC-1 backward compat leaves the clock
    /// authority at `SystemClockAuthority` (always-trusting
    /// 0-age). Set true to swap to `ChronyNtsClockAuthority`
    /// + get real fail-closed on stale NTS.
    ///
    /// REQUIRES: chronyd running + `chronyc` binary in PATH
    /// + the agent user has query access. See
    /// `docs/runbooks/edge-chrony-setup.md` (Phase 2 /
    /// Batch 91) for the operator checklist.
    #[serde(default)]
    pub enable_chrony_query: bool,
}

fn default_nts_sync_max_skew_secs() -> u64 {
    // Matches `crate::runtime_safety::system_clock::
    // DEFAULT_NTS_SYNC_MAX_SKEW_SECS`. Duplicated here because
    // config.rs runs at module-load time before runtime_safety
    // can be guaranteed to have been linked; keeping a local
    // default avoids circular-init ordering.
    3600
}

impl Default for ClockConfig {
    fn default() -> Self {
        Self {
            nts_sync_max_skew_secs: default_nts_sync_max_skew_secs(),
            enable_chrony_query: false,
        }
    }
}

// ============================================================================
// ConfigIntegrityConfig — Batch 42 plan D-13 / Sprint 6.6
// ============================================================================
//
// WHY: Plan D-13 + ADR-020 §6 mandate that every edge device boots with
// `/etc/suderra/config.yaml.sig` alongside `config.yaml`. The sidecar
// carries a SignedConfigMeta whose ed25519 signature covers SHA-256 of
// the config bytes + device binding + monotonic config version. Fail-
// closed boot on sig invalid prevents an attacker who gains write-access
// to /etc/suderra from swapping in a poisoned config (disable alarms,
// redirect MQTT broker, raise thresholds).
//
// Pre-Sprint-6.6 the VERIFY PATH doesn't exist yet — factory key isn't
// bundled, sidecar writer CLI doesn't ship. Batch 42 pre-stages the
// CONFIG KNOB (mode field) + boot-time log so operators know the rollout
// path exists. Sprint 6.6 wires the actual verify.
//
// ROLLOUT STAGES (3-mode state machine, mirrors MtlsMode pattern):
// - Disabled (default): no sidecar check. Pre-Batch-42 behavior.
// - Permissive: sidecar read + verify attempted; failure LOGGED but boot
//   continues. Early-detection posture for operator-managed migration.
// - Enforcing: sidecar verify required; failure exits boot.
//
// FACTORY KEY: the operator-bundled approach vs firmware-embedded
// approach is a Sprint 6.6 decision. Pre-Sprint-6.6 the factory_pubkey_
// hex field accepts a hex-encoded 32-byte key so operators can test the
// flow against their own keyring before the factory bundle lands.

/// Config-integrity verification mode. 3-stage rollout pattern
/// identical to MtlsMode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigIntegrityMode {
    /// No sidecar verification (pre-Batch-42 behavior). HC-1
    /// backward-compatible default.
    #[default]
    Disabled,
    /// Verify attempted; log-only on failure. Early-detection
    /// posture for operator migration.
    Permissive,
    /// Verify required; fail-closed boot on failure.
    Enforcing,
}

/// Config-integrity sidecar verification knobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigIntegrityConfig {
    /// Rollout mode: disabled / permissive / enforcing.
    #[serde(default)]
    pub mode: ConfigIntegrityMode,

    /// Hex-encoded 32-byte ed25519 public key used to verify
    /// the config signature. Sprint 6.6 replaces with a
    /// firmware-embedded factory key; pre-Sprint-6.6 operators
    /// can test with their own keyring. None = use the
    /// firmware-embedded key (Sprint 6.6 target).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub factory_pubkey_hex: Option<String>,

    /// Sidecar path override. None → `/etc/suderra/config.yaml.sig`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sidecar_path: Option<std::path::PathBuf>,
}

impl Default for ConfigIntegrityConfig {
    fn default() -> Self {
        Self {
            mode: ConfigIntegrityMode::default(),
            factory_pubkey_hex: None,
            sidecar_path: None,
        }
    }
}

/// OPC UA server TLS security policy (Batch 207 Faz 5).
///
/// Plan §5 Faz 5 step 7 mandates Basic256Sha256 — the minimum
/// industrial policy current HMIs (Ignition / UaExpert /
/// Kepware / Wonderware) negotiate without operator override.
/// Deprecated policies (None, Basic128Rsa15) are intentionally
/// excluded at the type level so the config cannot deserialize
/// into an insecure mode. Future policies (Aes128_Sha256_RsaOaep,
/// Aes256_Sha256_RsaPss) extend this enum additively.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpcUaSecurityPolicy {
    /// Basic256Sha256 — the plan's fixed minimum. All 3rd-party
    /// HMIs in the plan interop matrix support this policy.
    Basic256Sha256,
}

impl Default for OpcUaSecurityPolicy {
    fn default() -> Self {
        Self::Basic256Sha256
    }
}

impl OpcUaSecurityPolicy {
    /// async-opcua / OPC UA spec string representation —
    /// stable across versions so this is safe to stringify here.
    pub fn as_uri_suffix(&self) -> &'static str {
        match self {
            Self::Basic256Sha256 => "Basic256Sha256",
        }
    }
}

/// OPC UA server authentication mode (Batch 207 Faz 5).
///
/// Plan §5 Faz 5 step 3 lists three supported modes. The enum
/// captures the operator-selected primary mode; every session
/// always falls through to a final authz gate regardless of
/// mode, so `Anonymous` in the plan's words means "anonymous
/// read-only + write always denied at the policy layer" — not
/// "no authz at all".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpcUaAuthMode {
    /// Anonymous sessions allowed; reads gate only on policy.
    /// Writes are rejected regardless of policy (anonymous
    /// actors cannot satisfy any `Permission::OpcUaWrite`
    /// binding). This is the HC-1 backward-compat default for
    /// the first pilot release.
    AnonymousReadOnly,
    /// Operator user/password. The per-user pubkey binding
    /// lives in the RBAC manifest (Sprint 6.1) — matching the
    /// shape of MQTT-command actor resolution.
    UsernamePassword,
    /// X509 client cert. Operator cert CN resolves to the
    /// RBAC manifest actor entry.
    X509,
}

impl Default for OpcUaAuthMode {
    fn default() -> Self {
        Self::AnonymousReadOnly
    }
}

/// OPC UA server configuration (Batch 207 Faz 5).
///
/// Shape-level primitive — the config block does not start the
/// server (Batch 208+ wires `async-opcua`). Keeping the shape
/// separate from the runtime lets operators pre-stage config
/// for a feature-built binary roll-out, and gives unit tests
/// something stable to validate against without the full
/// async-opcua dep chain.
///
/// Every field is `serde(default)` so existing config.yaml
/// files deserialize unchanged (HC-1 backward compat).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OpcUaServerConfig {
    /// Master switch. `false` (default) leaves the server
    /// subsystem off regardless of Cargo feature build. Set to
    /// `true` only on agents built with the `opc-ua-server`
    /// feature flag; Batch 208 boot wiring logs a CRITICAL warn
    /// when the feature is absent but this flag is true.
    pub enabled: bool,

    /// Bind address. Default `0.0.0.0` — intentional: plan
    /// §5 Faz 5 step 8 notes LAN HMI interop is the primary
    /// consumer. Operators restrict to a VLAN interface by
    /// overriding here (e.g. `10.10.5.1`).
    pub bind: String,

    /// TCP port. Default 4840 is the OPC UA registered well-
    /// known port; operators can override to 48400 etc. when
    /// running multiple tenants on a single host.
    pub port: u16,

    /// Hard cap on concurrent sessions. Plan §5 Faz 5 step 9:
    /// "max 10 concurrent sessions". License-tier overrides this
    /// downward at boot (license_cache clamps at enforce time).
    pub max_sessions: u32,

    /// Brute-force throttle — sessions with more than this many
    /// failed auth attempts in any 60-second sliding window get
    /// IP-throttled. Plan §5 Faz 5 step 9: 20 failed / 60s.
    pub max_failed_auth_per_60s: u32,

    /// Phase B-3 (Plan §B-3 Batch #271) — per-tenant session quota.
    /// On a single-tenant agent this acts as a refined global cap
    /// distinct from `max_sessions` (the absolute hard floor). On a
    /// multi-tenant agent (future) it isolates noisy-neighbor
    /// scenarios. Default 5 — well below `max_sessions=10` so per-user
    /// fairness has room to fan out.
    pub max_sessions_per_tenant: u32,

    /// Phase B-3 (Plan §B-3 Batch #271) — per-user session quota
    /// within a tenant. A single compromised operator credential
    /// cannot starve other operators by opening many parallel
    /// sessions. Default 2 — enough for a primary operator session +
    /// a single supplementary connection (e.g., HMI + UaExpert
    /// debug).
    pub max_sessions_per_user: u32,

    /// Primary auth mode. Secondary gate is always the authz
    /// policy engine — see module doc.
    pub auth_mode: OpcUaAuthMode,

    /// TLS security policy. Fixed at `Basic256Sha256` by type
    /// until a future batch extends the enum; operators cannot
    /// downgrade to `None` or `Basic128Rsa15`.
    pub security_policy: OpcUaSecurityPolicy,

    /// Directory holding the server's own PKI keypair +
    /// self-signed cert. Default matches plan §5 Faz 5 step 7.
    pub own_pki_dir: String,

    /// Directory holding trusted HMI client certs. Operators
    /// drop peer certs here after the first-boot mutual trust
    /// exchange. Default matches plan §5 Faz 5 step 7.
    pub trusted_certs_dir: String,

    /// Phase 1 MVP polling interval — how often the server re-
    /// reads the process image to publish MonitoredItem values.
    /// Batch 209+ swaps this for push via
    /// `ProcessImage::subscribe_changes` (plan §5 Faz 5 step 6);
    /// the polling knob stays available as the fallback path.
    pub subscription_polling_interval_ms: u64,
}

impl Default for OpcUaServerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: "0.0.0.0".to_string(),
            port: 4840,
            max_sessions: 10,
            max_failed_auth_per_60s: 20,
            max_sessions_per_tenant: 5,
            max_sessions_per_user: 2,
            auth_mode: OpcUaAuthMode::default(),
            security_policy: OpcUaSecurityPolicy::default(),
            own_pki_dir: "/var/lib/suderra/pki/own".to_string(),
            trusted_certs_dir: "/var/lib/suderra/pki/trusted/certs".to_string(),
            subscription_polling_interval_ms: 100,
        }
    }
}

impl OpcUaServerConfig {
    /// Load-time validator. Runs regardless of `enabled` so
    /// operators get immediate feedback on mis-configured blocks
    /// at boot — latent bad values cannot survive a feature-flag
    /// flip. Returns on the first violation to keep error
    /// surfaces small + actionable.
    pub fn validate(&self) -> Result<(), String> {
        if self.bind.trim().is_empty() {
            return Err(
                "opc_ua_server.bind must be a non-empty IP address (e.g. 0.0.0.0)".to_string(),
            );
        }
        if std::net::IpAddr::from_str(self.bind.trim()).is_err() {
            return Err(format!(
                "opc_ua_server.bind `{}` is not a parseable IP address",
                self.bind
            ));
        }
        if self.port == 0 {
            return Err("opc_ua_server.port must be non-zero (standard 4840)".to_string());
        }
        if self.max_sessions == 0 {
            return Err(
                "opc_ua_server.max_sessions must be >= 1 so at least one HMI can connect"
                    .to_string(),
            );
        }
        if self.max_failed_auth_per_60s == 0 {
            return Err(
                "opc_ua_server.max_failed_auth_per_60s must be >= 1 (0 disables brute-force throttle)"
                    .to_string(),
            );
        }
        // Phase B-3 — session quota validators. Per-user MUST be <=
        // per-tenant (a single user cannot exceed the tenant cap by
        // construction); per-tenant MUST be <= max_sessions (the
        // global hard floor — the per-tenant cap is a refinement, not
        // an override). Both fields >= 1 — 0 would lock out all
        // operators which is a misconfig.
        if self.max_sessions_per_user == 0 {
            return Err(
                "opc_ua_server.max_sessions_per_user must be >= 1 (0 locks out every operator — misconfig)"
                    .to_string(),
            );
        }
        if self.max_sessions_per_tenant == 0 {
            return Err(
                "opc_ua_server.max_sessions_per_tenant must be >= 1 (0 locks out every tenant — misconfig)"
                    .to_string(),
            );
        }
        if self.max_sessions_per_user > self.max_sessions_per_tenant {
            return Err(format!(
                "opc_ua_server.max_sessions_per_user ({}) cannot exceed max_sessions_per_tenant ({}) — \
                 per-user is refined per-tenant, must be <= the tenant ceiling",
                self.max_sessions_per_user, self.max_sessions_per_tenant
            ));
        }
        if self.max_sessions_per_tenant > self.max_sessions {
            return Err(format!(
                "opc_ua_server.max_sessions_per_tenant ({}) cannot exceed max_sessions ({}) — \
                 the per-tenant cap is a refinement of the global hard floor, must be <= it",
                self.max_sessions_per_tenant, self.max_sessions
            ));
        }
        // Polling below 10ms risks pathological lock contention
        // on ProcessImage::get_all_tags + starves other tasks.
        // The plan's 100ms default comfortably clears this floor.
        if self.subscription_polling_interval_ms < 10 {
            return Err(format!(
                "opc_ua_server.subscription_polling_interval_ms ({}) below 10ms floor — ProcessImage lock contention + task starvation risk",
                self.subscription_polling_interval_ms
            ));
        }
        if self.own_pki_dir.trim().is_empty() {
            return Err("opc_ua_server.own_pki_dir must be a non-empty directory path".to_string());
        }
        if self.trusted_certs_dir.trim().is_empty() {
            return Err(
                "opc_ua_server.trusted_certs_dir must be a non-empty directory path".to_string(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod opc_ua_server_config_tests {
    use super::*;

    #[test]
    fn default_is_disabled_with_plan_specified_values() {
        let cfg = OpcUaServerConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.bind, "0.0.0.0");
        assert_eq!(cfg.port, 4840);
        assert_eq!(cfg.max_sessions, 10);
        assert_eq!(cfg.max_failed_auth_per_60s, 20);
        assert_eq!(cfg.auth_mode, OpcUaAuthMode::AnonymousReadOnly);
        assert_eq!(cfg.security_policy, OpcUaSecurityPolicy::Basic256Sha256);
        assert_eq!(cfg.subscription_polling_interval_ms, 100);
    }

    #[test]
    fn validate_accepts_default() {
        OpcUaServerConfig::default().validate().unwrap();
    }

    #[test]
    fn validate_rejects_empty_bind() {
        let mut c = OpcUaServerConfig::default();
        c.bind = String::new();
        let err = c.validate().unwrap_err();
        assert!(err.contains("bind"), "err={}", err);
    }

    #[test]
    fn validate_rejects_unparseable_bind() {
        let mut c = OpcUaServerConfig::default();
        c.bind = "not an ip".to_string();
        let err = c.validate().unwrap_err();
        assert!(err.contains("parseable IP"), "err={}", err);
    }

    #[test]
    fn validate_rejects_zero_port() {
        let mut c = OpcUaServerConfig::default();
        c.port = 0;
        let err = c.validate().unwrap_err();
        assert!(err.contains("port"), "err={}", err);
    }

    #[test]
    fn validate_rejects_zero_max_sessions() {
        let mut c = OpcUaServerConfig::default();
        c.max_sessions = 0;
        let err = c.validate().unwrap_err();
        assert!(err.contains("max_sessions"), "err={}", err);
    }

    #[test]
    fn validate_rejects_zero_failed_auth_window() {
        let mut c = OpcUaServerConfig::default();
        c.max_failed_auth_per_60s = 0;
        let err = c.validate().unwrap_err();
        assert!(err.contains("max_failed_auth"), "err={}", err);
    }

    #[test]
    fn validate_rejects_polling_below_floor() {
        let mut c = OpcUaServerConfig::default();
        c.subscription_polling_interval_ms = 5;
        let err = c.validate().unwrap_err();
        assert!(err.contains("10ms floor"), "err={}", err);
    }

    #[test]
    fn validate_accepts_ipv6_bind() {
        let mut c = OpcUaServerConfig::default();
        c.bind = "::1".to_string();
        c.validate().unwrap();
    }

    #[test]
    fn serde_round_trip_default_yaml_is_empty_safe() {
        // Existing config.yaml files with no `opc_ua_server`
        // block MUST deserialize — this is HC-1 backward compat.
        let yaml = "";
        let got: OpcUaServerConfig = serde_yaml::from_str(yaml).unwrap_or_default();
        assert!(!got.enabled);
    }

    #[test]
    fn serde_partial_yaml_fills_defaults() {
        // Operator overrides only port + enabled; every other
        // field MUST default to the plan's value.
        let yaml = "enabled: true\nport: 48400\n";
        let got: OpcUaServerConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(got.enabled);
        assert_eq!(got.port, 48400);
        assert_eq!(got.bind, "0.0.0.0");
        assert_eq!(got.max_sessions, 10);
        assert_eq!(got.security_policy, OpcUaSecurityPolicy::Basic256Sha256);
    }

    #[test]
    fn security_policy_uri_suffix_stable() {
        assert_eq!(
            OpcUaSecurityPolicy::Basic256Sha256.as_uri_suffix(),
            "Basic256Sha256"
        );
    }

    #[test]
    fn auth_mode_default_is_anonymous_read_only() {
        assert_eq!(OpcUaAuthMode::default(), OpcUaAuthMode::AnonymousReadOnly);
    }
}

/// TLS mode enum (Batch 22 ARC-007).
///
/// Type-level encoding of the three valid Modbus-over-TLS
/// configurations. A value of type `TlsMode` is statically
/// guaranteed to be ONE of these three states — the consumer
/// path cannot observe a half-configured combination like
/// "client cert set but client key missing".
///
/// WHY NOT KEEP SERDE AT THIS LEVEL: Serde-derived enums with
/// internally-tagged representation would surface discriminator
/// fields in the YAML config, breaking backward compat with the
/// existing `enabled: true` / `client_cert_path: ...` flat
/// schema. The TlsMode enum is the INTERNAL consumer-facing
/// representation; `ModbusTlsConfig` remains the serde-
/// deserialized wire format + `to_mode()` is the load-time
/// conversion boundary.
#[derive(Debug, Clone)]
pub enum TlsMode {
    /// TLS not in use — plaintext Modbus TCP.
    Disabled,
    /// Server-only TLS: agent validates the PLC server cert;
    /// PLC does NOT validate the agent client cert. Minimum
    /// useful TLS posture for legacy PLCs without client-cert
    /// infrastructure.
    ServerOnly {
        server_name: String,
        ca_cert_path: String,
        insecure_skip_verify: bool,
    },
    /// Full mutual TLS: both sides present certs + both validate.
    /// IEC 62443 SL2 FR4 preferred posture.
    Full {
        server_name: String,
        ca_cert_path: String,
        client_cert_path: String,
        client_key_path: String,
        insecure_skip_verify: bool,
    },
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

    /// Security configuration (optional, uses global defaults if not specified)
    #[serde(default)]
    pub security: ModbusSecurityConfig,

    /// TLS configuration for encrypted Modbus TCP (v1.2.0)
    #[serde(default)]
    pub tls: ModbusTlsConfig,
}

/// Byte order for multi-register values
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ByteOrder {
    /// Big Endian (AB CD) - Most common for Modbus
    #[default]
    BigEndian,
    /// Little Endian (CD AB)
    LittleEndian,
    /// Big Endian byte swap (BA DC)
    BigEndianByteSwap,
    /// Little Endian byte swap (DC BA)
    LittleEndianByteSwap,
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

    /// Fail-safe value driven on safe-state (EDGE-HIGH-012). For a
    /// `coil` output, non-zero = energize (e.g. a life-support aerator
    /// that must fail-ON, not de-energize to OFF); for a `holding`
    /// output, the raw register value. `None` defaults to de-energize
    /// (coil=false / register=0), preserving the pre-EDGE-HIGH-012
    /// behavior for unclassified outputs.
    #[serde(default)]
    pub safe_state_value: Option<u16>,
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

    /// Fail-safe level driven on safe-state (EDGE-HIGH-012).
    /// `Some(true)` = HIGH (fail-ON), `Some(false)` = LOW. `None`
    /// defaults to LOW, preserving pre-EDGE-HIGH-012 behavior.
    #[serde(default)]
    pub safe_state_level: Option<bool>,
}

// Default value functions
fn default_mqtt_port() -> u16 {
    8883
}
fn default_keepalive() -> u64 {
    30
}
fn default_true() -> bool {
    true
}
fn default_telemetry_interval() -> u64 {
    30
}
fn default_io_data_interval() -> u64 {
    1000
}

// OpenTelemetry OTLP defaults
fn default_service_name() -> String {
    "suderra-agent".to_string()
}
fn default_sample_ratio() -> f64 {
    1.0 // Sample all traces by default
}

fn default_log_level() -> String {
    "info".to_string()
}
fn default_log_file() -> String {
    "/var/log/suderra-agent.log".to_string()
}
fn default_slave_id() -> u8 {
    1
}
fn default_data_type() -> String {
    "u16".to_string()
}
fn default_scale() -> f64 {
    1.0
}
fn default_pull() -> String {
    "none".to_string()
}

// Modbus security defaults (IEC 62443 SL2)
fn default_modbus_function_whitelist() -> Vec<u8> {
    // Only allow read operations by default:
    // FC 1: Read Coils
    // FC 2: Read Discrete Inputs
    // FC 3: Read Holding Registers
    // FC 4: Read Input Registers
    vec![1, 2, 3, 4]
}
fn default_modbus_rate_limit() -> u64 {
    10 // 10 operations per second (conservative default)
}
fn default_modbus_burst_capacity() -> u64 {
    20 // Allow burst of 20 operations
}
fn default_max_register_count() -> u16 {
    125 // Modbus protocol max is 125 for holding/input registers
}

// Cache defaults (v1.2.0)
fn default_cache_max_capacity() -> u64 {
    1000
}
fn default_cache_ttl_secs() -> u64 {
    3600 // 1 hour
}
fn default_cache_tti_secs() -> u64 {
    1800 // 30 minutes
}

// Circuit breaker defaults (v1.2.0)
fn default_cb_failure_threshold() -> u32 {
    3
}
fn default_cb_success_threshold() -> u32 {
    2
}
fn default_cb_half_open_permits() -> u32 {
    1
}

// Scripting defaults
/// Batch #302 Faz 4 step 5: default 30s task_stats publish interval.
fn default_task_stats_interval_secs() -> u64 {
    30
}

fn default_scan_cycle_ms() -> u64 {
    100
}
fn default_min_scan_cycle_ms() -> u64 {
    10
}
fn default_max_scan_cycle_ms() -> u64 {
    10000
}
fn default_max_function_blocks() -> usize {
    100
}
fn default_max_execution_depth() -> usize {
    10
}
fn default_max_actions() -> usize {
    100
}
fn default_max_execution_time_secs() -> u64 {
    30
}

// Runtime/resilience defaults
fn default_rate_limit_max() -> usize {
    60
}
fn default_rate_limit_window_secs() -> u64 {
    60
}
fn default_gpio_timeout_secs() -> u64 {
    5
}
fn default_modbus_timeout_secs() -> u64 {
    5
}
fn default_modbus_connect_timeout_secs() -> u64 {
    10
}
fn default_circuit_breaker_recovery_secs() -> u64 {
    30
}
fn default_provisioning_timeout_secs() -> u64 {
    30
}
fn default_shutdown_timeout_secs() -> u64 {
    // Batch 32: matches the prior hardcoded SHUTDOWN_TIMEOUT_SECS
    // constant in main.rs (30s). Pre-Batch-32 the config field
    // was DEAD — declared but never read, defaulting to 10s
    // while main.rs used 30s. Operators who explicitly set 10s
    // in config.yaml were getting 30s behavior silently.
    30
}

fn default_drain_timeout_ms() -> u64 {
    // Plan D-15 specifies 50ms. This is the per-task
    // cancel-vs-drain budget: in-flight commands get at most
    // 50ms between shutdown signal and force-cancel. Typical
    // command dispatch completes in sub-millisecond; the 50ms
    // headroom accommodates network-aware commands
    // (plc_upload, firmware fetch) that await a remote
    // response. Force-cancel after 50ms is the outer backstop;
    // actual per-command timeouts are operator-configurable
    // (plc_upload: 30s, firmware download: 300s).
    50
}

fn default_max_command_age_secs() -> u64 {
    // Batch 34: matches the prior hardcoded constant in
    // commands/mod.rs (300s). IEC 62443 SL-2 FR-7 replay
    // protection — commands older than this bound are
    // rejected. 5-minute default balances operator-timezone
    // clock skew against replay-window tightness.
    300
}

fn default_max_command_skew_secs() -> u64 {
    // Batch 34: matches pre-Batch-34 hardcoded 60s. Negative-
    // age tolerance for future-dated commands (cloud clock
    // ahead of edge clock). 60s is generous for well-synced
    // NTS fleets; operators can tighten after verifying sync.
    60
}
fn default_mqtt_reconnect_min_secs() -> u64 {
    1
}
fn default_mqtt_reconnect_max_secs() -> u64 {
    60
}

// Failover defaults (v1.3.4)
fn default_failover_timeout_secs() -> u64 {
    10 // 10 seconds before failover
}
fn default_failover_health_check_secs() -> u64 {
    60 // Check primary every 60 seconds when on backup
}
fn default_failover_max_failures() -> u32 {
    3 // 3 consecutive failures trigger failover
}
fn default_failover_recovery_delay_secs() -> u64 {
    5 // Wait 5 seconds before switching back to primary
}

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

fn default_capabilities_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/capabilities".to_string()
}

fn default_io_data_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/io_data".to_string()
}

fn default_alarms_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/alarms".to_string()
}

fn default_lora_events_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/lora_events".to_string()
}

/// Batch #302 Faz 4 step 5: per-task scheduler stats topic.
fn default_task_stats_topic() -> String {
    "tenants/{tenant_id}/devices/{device_id}/task_stats".to_string()
}

// ============================================================================
// MtlsConfig — Batch 27 plan §5 Faz 2 item 7 (mTLS 3-stage rollout)
// ============================================================================
//
// WHY: Plan §5 Faz 2 item 7 mandates a 3-stage mTLS rollout
// (Legacy → Warn → Strict) to migrate devices off long-lived certs
// without breaking fleet-wide TLS on day-one cutover. The
// `crate::mtls::MtlsMode` enum encodes the stages as a type; this
// struct is the serde-deserialized wire format that puts the mode
// into `config.yaml`.
//
// Pre-Sprint-6.8 the mode field is logged at boot for operator
// visibility but does NOT yet alter rustls handshake behavior.
// Full wire (pinning + leaf-cert-age check + cipher suite allowlist
// + 2-phase rotation) lands in Sprint 6.8 per plan §11 PR #19.
//
// WHAT:
// - `mode: MtlsMode` with default `Legacy` — preserves HC-1 v1.6.0
//   backward compat. Operators must explicitly opt in to Warn/
//   Strict; no automatic cutover.
// - `enforce_fingerprint_pinning: bool` — Sprint 6.8 target. Split
//   from mode so an operator can enable pinning in Legacy mode for
//   early detection without full rollout commitment.
// - `min_tls_version` — TLS 1.2 default; Strict mode may bump to
//   TLS 1.3. Explicit field rather than derived from mode so the
//   cipher-suite allowlist in Sprint 6.8 is operator-tunable.

/// mTLS rollout-stage configuration. See `crate::mtls::MtlsMode`
/// for the type-level state machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MtlsConfig {
    /// Rollout stage: `legacy`, `warn`, or `strict`. Defaults to
    /// `legacy` for v1.6.0 → v2.0.0 backward compat.
    #[serde(default)]
    pub mode: crate::mtls::MtlsMode,

    /// Enforce leaf-cert fingerprint pinning. Independent of
    /// `mode` — an operator can enable pinning in Legacy stage
    /// for early-detection value. Defaults to `false` pre-Sprint-
    /// 6.8; Strict mode will flip the default to `true`.
    #[serde(default)]
    pub enforce_fingerprint_pinning: bool,

    /// Minimum TLS protocol version accepted. Options:
    /// `tls_1_2` (default) or `tls_1_3`. Strict mode deployments
    /// should bump to `tls_1_3` once all PLCs + MQTT brokers in
    /// the fleet support it.
    #[serde(default = "default_min_tls_version")]
    pub min_tls_version: String,

    /// Pinned leaf cert SHA-256 fingerprints (Batch 137 Sprint
    /// 6.6/6.8). 64-char hex strings corresponding to the
    /// DER-over-SHA-256 of every leaf cert the agent will
    /// accept during TLS handshakes.
    ///
    /// Consumed by `SuderraServerCertVerifier` (Batch 136) to
    /// populate `CertRotationStage` at boot.
    ///
    /// - `Legacy` mode: optional. Empty list = no pinning;
    ///   pins present = early-detection logging.
    /// - `Warn` mode: optional. Empty = warn on every
    ///   handshake (degraded posture); pins = audit-emit on
    ///   mismatch.
    /// - `Strict` mode: REQUIRED non-empty. Coherence Rule 24
    ///   enforces ≥1 pin.
    ///
    /// Cloud-signed rotation manifest (future batch) will
    /// replace this static config with a hot-reloadable
    /// source; the static config path persists for test
    /// keyring + pre-manifest-rollout operator use.
    #[serde(default)]
    pub pinned_leaf_fingerprints_hex: Vec<String>,
}

fn default_min_tls_version() -> String {
    "tls_1_2".to_string()
}

impl Default for MtlsConfig {
    fn default() -> Self {
        Self {
            mode: crate::mtls::MtlsMode::default(),
            enforce_fingerprint_pinning: false,
            min_tls_version: default_min_tls_version(),
            pinned_leaf_fingerprints_hex: Vec::new(),
        }
    }
}

impl AgentConfig {
    /// Detect the GPIO platform for this device.
    ///
    /// Delegates to the module-level `detect_gpio_platform()` function which
    /// reads `/proc/device-tree/model` to identify the hardware.
    pub fn gpio_platform(&self) -> GpioPlatform {
        detect_gpio_platform()
    }

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

        // Validate configuration
        config.validate()?;

        Ok(config)
    }

    /// Validate configuration values
    ///
    /// # Security
    /// This validates all configuration parameters to prevent:
    /// - Invalid device IDs that could cause issues
    /// - Invalid GPIO pins that don't exist on hardware
    /// - Invalid Modbus slave IDs outside protocol range
    /// - Invalid port numbers
    pub fn validate(&self) -> Result<()> {
        // Validate device_id - can be empty if tenant_token is set (self-registration mode)
        if self.device_id.trim().is_empty() && self.tenant_token.is_none() {
            anyhow::bail!(
                "device_id cannot be empty (unless tenant_token is set for self-registration)"
            );
        }

        // v1.2.5: Validate device_id looks like a UUID format (basic check)
        // Skip validation if device_id is empty (self-registration mode)
        if !self.device_id.trim().is_empty() {
            if self.device_id.len() != 36
                || self.device_id.chars().filter(|c| *c == '-').count() != 4
                || !self
                    .device_id
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() || c == '-')
            {
                anyhow::bail!(
                    "device_id '{}' is not a valid UUID format (expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)",
                    self.device_id
                );
            }
        }

        // Validate device_code - can be empty if tenant_token is set (self-registration mode)
        if self.device_code.trim().is_empty() && self.tenant_token.is_none() {
            anyhow::bail!(
                "device_code cannot be empty (unless tenant_token is set for self-registration)"
            );
        }

        // Validate API URL format
        if !self.api_url.starts_with("http://") && !self.api_url.starts_with("https://") {
            anyhow::bail!("api_url must start with http:// or https://");
        }

        // In release builds, block plain HTTP for provisioning API (credentials in transit)
        #[cfg(not(debug_assertions))]
        if self.api_url.starts_with("http://") {
            anyhow::bail!(
                "api_url must use https:// in production (plain HTTP exposes provisioning \
                 credentials in transit). Use debug builds for local development."
            );
        }
        #[cfg(debug_assertions)]
        if self.api_url.starts_with("http://") {
            tracing::warn!(
                "api_url uses plain HTTP — provisioning credentials will be sent unencrypted. \
                 Use https:// in production."
            );
        }

        // v1.2.5: Basic URL structure validation (must have host part)
        // v1.2.6: Enhanced validation to reject malformed domains
        let url_without_scheme = self
            .api_url
            .strip_prefix("https://")
            .or_else(|| self.api_url.strip_prefix("http://"))
            .unwrap_or("");

        // Extract host part (before any path, query, or port)
        let host = url_without_scheme
            .split('/')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("");

        // Validate host structure
        if host.is_empty() {
            anyhow::bail!("api_url '{}' appears invalid (missing host)", self.api_url);
        }
        if host.starts_with('.') || host.ends_with('.') {
            anyhow::bail!(
                "api_url '{}' has invalid host (cannot start/end with dot)",
                self.api_url
            );
        }
        if host.contains("..") {
            anyhow::bail!(
                "api_url '{}' has invalid host (consecutive dots not allowed)",
                self.api_url
            );
        }
        // Must have at least one dot (except localhost)
        if !host.contains('.') && host != "localhost" {
            anyhow::bail!(
                "api_url '{}' appears invalid (must have a host like https://api.example.com)",
                self.api_url
            );
        }

        // Validate MQTT port if configured
        if let Some(ref _broker) = self.mqtt.broker {
            if self.mqtt.port == 0 {
                anyhow::bail!("MQTT port cannot be 0");
            }
            // Note: port is u16 so max is already 65535
        }

        // v1.2.2: Platform-aware GPIO validation
        let gpio_platform = detect_gpio_platform();
        let (min_pin, max_pin) = gpio_platform.valid_range();

        for gpio in &self.gpio {
            if gpio.pin < min_pin || gpio.pin > max_pin {
                anyhow::bail!(
                    "Invalid GPIO pin {}: {:?} supports GPIO {}-{}",
                    gpio.pin,
                    gpio_platform,
                    min_pin,
                    max_pin
                );
            }

            // Validate direction
            let valid_directions = ["input", "output", "in", "out"];
            if !valid_directions.contains(&gpio.direction.to_lowercase().as_str()) {
                anyhow::bail!(
                    "Invalid GPIO direction '{}' for pin {}: must be 'input' or 'output'",
                    gpio.direction,
                    gpio.pin
                );
            }

            // Validate pull mode
            let valid_pulls = ["up", "down", "none", ""];
            if !valid_pulls.contains(&gpio.pull.to_lowercase().as_str()) {
                anyhow::bail!(
                    "Invalid GPIO pull mode '{}' for pin {}: must be 'up', 'down', or 'none'",
                    gpio.pull,
                    gpio.pin
                );
            }
        }

        // 2026-04-29 PLC command endpoint inventory validation:
        // Direct PLC write commands use connection names as stable
        // authorization/audit targets. Duplicate names would make the command
        // target ambiguous, so config load fails before any command can run.
        let mut plc_names = std::collections::HashSet::new();
        for cfg in &self.plc_programming.opcua {
            if cfg.name.trim().is_empty() {
                anyhow::bail!("OPC UA PLC connection name cannot be empty");
            }
            if !plc_names.insert(format!("opcua:{}", cfg.name)) {
                anyhow::bail!("Duplicate OPC UA PLC connection name '{}'", cfg.name);
            }
            if cfg.endpoint_url.trim().is_empty() {
                anyhow::bail!(
                    "OPC UA PLC connection '{}' endpoint_url cannot be empty",
                    cfg.name
                );
            }
        }
        for cfg in &self.plc_programming.s7 {
            if cfg.name.trim().is_empty() {
                anyhow::bail!("S7 PLC connection name cannot be empty");
            }
            if !plc_names.insert(format!("s7:{}", cfg.name)) {
                anyhow::bail!("Duplicate S7 PLC connection name '{}'", cfg.name);
            }
            if cfg.address.trim().is_empty() {
                anyhow::bail!("S7 PLC connection '{}' address cannot be empty", cfg.name);
            }
            if cfg.port == 0 {
                anyhow::bail!("S7 PLC connection '{}' port cannot be 0", cfg.name);
            }
        }

        // Validate Modbus devices
        for device in &self.modbus {
            // Validate slave_id (Modbus uses 1-247, 0 is broadcast)
            if device.slave_id == 0 || device.slave_id > 247 {
                anyhow::bail!(
                    "Invalid Modbus slave_id {} for device '{}': must be 1-247",
                    device.slave_id,
                    device.name
                );
            }

            // Validate connection_type
            let valid_types = ["tcp", "rtu"];
            if !valid_types.contains(&device.connection_type.to_lowercase().as_str()) {
                anyhow::bail!(
                    "Invalid Modbus connection_type '{}' for device '{}': must be 'tcp' or 'rtu'",
                    device.connection_type,
                    device.name
                );
            }

            // Validate address is not empty
            if device.address.trim().is_empty() {
                anyhow::bail!("Modbus device '{}' has empty address", device.name);
            }

            // 2026-04-29 enterprise Modbus write policy:
            // Write-enabled devices must either declare bounded address ranges
            // or explicitly opt into all-address writes. This removes the
            // legacy accidental "empty whitelist means all registers" posture.
            if device.security.enabled && device.security.allow_writes {
                if device.security.allowed_write_ranges.is_empty()
                    && !device.security.allow_all_write_addresses
                {
                    anyhow::bail!(
                        "Modbus device '{}': allow_writes=true requires non-empty allowed_write_ranges or explicit allow_all_write_addresses=true",
                        device.name
                    );
                }

                let mut ranges = device.security.allowed_write_ranges.clone();
                ranges.sort_unstable_by_key(|(start, end)| (*start, *end));
                let mut previous_end: Option<u16> = None;
                for (start, end) in ranges {
                    if start > end {
                        anyhow::bail!(
                            "Modbus device '{}': invalid allowed_write_ranges entry {}..{} (start must be <= end)",
                            device.name,
                            start,
                            end
                        );
                    }
                    if let Some(prev_end) = previous_end {
                        if start <= prev_end {
                            anyhow::bail!(
                                "Modbus device '{}': overlapping allowed_write_ranges around {}..{}",
                                device.name,
                                start,
                                end
                            );
                        }
                    }
                    previous_end = Some(end);
                }
            }

            // Validate Modbus TLS configuration (v1.2.0 - IEC 62443 SL2 FR4)
            if device.tls.enabled {
                // TLS only supported for TCP connections
                if device.connection_type.to_lowercase() != "tcp" {
                    anyhow::bail!(
                        "Modbus device '{}': TLS is only supported for TCP connections",
                        device.name
                    );
                }

                // Server name required for TLS
                if device.tls.server_name.is_none() && !device.tls.insecure_skip_verify {
                    anyhow::bail!(
                        "Modbus device '{}': server_name required for TLS (or set insecure_skip_verify)",
                        device.name
                    );
                }

                // Validate certificate paths if provided
                if let Some(ref ca_path) = device.tls.ca_cert_path {
                    if !std::path::Path::new(ca_path).exists() {
                        anyhow::bail!(
                            "Modbus device '{}': CA certificate not found: {}",
                            device.name,
                            ca_path
                        );
                    }
                }
                if let Some(ref cert_path) = device.tls.client_cert_path {
                    if !std::path::Path::new(cert_path).exists() {
                        anyhow::bail!(
                            "Modbus device '{}': client certificate not found: {}",
                            device.name,
                            cert_path
                        );
                    }
                }
                if let Some(ref key_path) = device.tls.client_key_path {
                    let key_path_obj = std::path::Path::new(key_path);
                    if !key_path_obj.exists() {
                        anyhow::bail!(
                            "Modbus device '{}': client key not found: {}",
                            device.name,
                            key_path
                        );
                    }
                    // v1.2.2: Validate private key file permissions (Unix only)
                    #[cfg(unix)]
                    {
                        if let Err(e) = validate_key_file_permissions(key_path_obj) {
                            anyhow::bail!("Modbus device '{}': {}", device.name, e);
                        }
                    }
                }
                // Validate mTLS consistency
                if device.tls.client_cert_path.is_some() != device.tls.client_key_path.is_some() {
                    anyhow::bail!(
                        "Modbus device '{}': mTLS requires both client_cert_path and client_key_path",
                        device.name
                    );
                }

                // v1.2.2: Block insecure configuration in release builds
                if device.tls.insecure_skip_verify {
                    #[cfg(not(debug_assertions))]
                    {
                        anyhow::bail!(
                            "Modbus device '{}': insecure_skip_verify is not allowed in release builds (IEC 62443 FR4)",
                            device.name
                        );
                    }
                    #[cfg(debug_assertions)]
                    {
                        warn!(
                            "Modbus device '{}': TLS verification disabled - NOT allowed in production",
                            device.name
                        );
                    }
                }
            }
        }

        // Validate telemetry interval (minimum 5 seconds, maximum 1 hour)
        if self.telemetry.interval_seconds < 5 {
            anyhow::bail!(
                "Telemetry interval {} is too low: minimum is 5 seconds",
                self.telemetry.interval_seconds
            );
        }
        if self.telemetry.interval_seconds > 3600 {
            anyhow::bail!(
                "Telemetry interval {} is too high: maximum is 3600 seconds (1 hour)",
                self.telemetry.interval_seconds
            );
        }

        // 2026-04-29 enterprise transport hardening:
        // MQTT TLS disabled in a release build is a configuration error, not
        // an operator warning.
        //
        // What it solves: the edge command/control channel carries mutating
        // commands. Release builds must not boot with plaintext MQTT because
        // that turns a production misconfiguration into a supported runtime
        // posture.
        #[cfg(not(debug_assertions))]
        if !self.mqtt.tls.enabled {
            anyhow::bail!(
                "Config coherence: mqtt.tls.enabled=false is not allowed in release builds. \
                 Enable MQTT TLS for production command/control traffic."
            );
        }

        // Validate MQTT TLS certificate paths exist (IEC 62443 SL2 FR4)
        // v1.2.0: Fail-fast if TLS is enabled but certificates are missing
        if self.mqtt.tls.enabled {
            if let Some(ref ca_path) = self.mqtt.tls.ca_cert_path {
                if !std::path::Path::new(ca_path).exists() {
                    anyhow::bail!("MQTT CA certificate not found: {}", ca_path);
                }
            } else {
                // No custom CA - system CA store will be used
                warn!("MQTT TLS enabled without custom CA certificate - using system CA store");
            }
            if let Some(ref cert_path) = self.mqtt.tls.client_cert_path {
                if !std::path::Path::new(cert_path).exists() {
                    anyhow::bail!("MQTT client certificate not found: {}", cert_path);
                }
            }
            if let Some(ref key_path) = self.mqtt.tls.client_key_path {
                let key_path_obj = std::path::Path::new(key_path);
                if !key_path_obj.exists() {
                    anyhow::bail!("MQTT client key not found: {}", key_path);
                }
                // v1.2.2: Validate private key file permissions (Unix only)
                #[cfg(unix)]
                {
                    if let Err(e) = validate_key_file_permissions(key_path_obj) {
                        anyhow::bail!("MQTT: {}", e);
                    }
                }
            }
            // Validate mTLS consistency - if one is set, both must be set
            if self.mqtt.tls.client_cert_path.is_some() != self.mqtt.tls.client_key_path.is_some() {
                anyhow::bail!(
                    "MQTT mTLS requires both client_cert_path and client_key_path to be set"
                );
            }
        }

        // LoRaWAN yapilandirma validasyonu (v1.5.0)
        if let Some(ref lora) = self.lorawan {
            if lora.enabled {
                // Bolge gecerli mi?
                let valid_regions = [
                    "EU868", "US915", "CN470", "AU915", "AS923", "KR920", "IN865",
                ];
                if !valid_regions.contains(&lora.region.to_uppercase().as_str()) {
                    anyhow::bail!(
                        "Gecersiz LoRa bolgesi '{}': gecerli bolgeler: {:?}",
                        lora.region,
                        valid_regions
                    );
                }

                // net_id 6 hex karakter mi?
                let net_id_clean = lora
                    .net_id
                    .trim_start_matches("0x")
                    .trim_start_matches("0X");
                if net_id_clean.len() != 6 || !net_id_clean.chars().all(|c| c.is_ascii_hexdigit()) {
                    anyhow::bail!(
                        "LoRa net_id '{}' gecersiz: 6 hex karakter olmali (orn: '000001')",
                        lora.net_id
                    );
                }

                // rx1_delay 0-15 araliginda mi?
                if lora.rx1_delay > 15 {
                    anyhow::bail!(
                        "LoRa rx1_delay {} gecersiz: 0-15 araliginda olmali",
                        lora.rx1_delay
                    );
                }

                // Her cihaz config'inde dev_eui, app_eui, app_key format kontrolu
                for (i, device) in lora.devices.iter().enumerate() {
                    // dev_eui: 16 hex karakter
                    if device.dev_eui.len() != 16
                        || !device.dev_eui.chars().all(|c| c.is_ascii_hexdigit())
                    {
                        anyhow::bail!(
                            "LoRa cihaz [{}] dev_eui '{}' gecersiz: 16 hex karakter olmali",
                            i,
                            device.dev_eui
                        );
                    }
                    // app_eui: 16 hex karakter
                    if device.app_eui.len() != 16
                        || !device.app_eui.chars().all(|c| c.is_ascii_hexdigit())
                    {
                        anyhow::bail!(
                            "LoRa cihaz [{}] app_eui '{}' gecersiz: 16 hex karakter olmali",
                            i,
                            device.app_eui
                        );
                    }
                    // app_key: 32 hex karakter
                    if device.app_key.len() != 32
                        || !device.app_key.chars().all(|c| c.is_ascii_hexdigit())
                    {
                        anyhow::bail!(
                            "LoRa cihaz [{}] app_key gecersiz: 32 hex karakter olmali",
                            i
                        );
                    }
                }
            }
        }

        // Batch 207 Faz 5: OPC UA server config shape check.
        // Runs regardless of `opc_ua_server.enabled` so operators
        // cannot ship a latent bad value that flips live the
        // moment the feature flag gets toggled on.
        if let Err(e) = self.opc_ua_server.validate() {
            anyhow::bail!("opc_ua_server config invalid: {}", e);
        }

        // Batch 39: Faz 2 security-posture coherence checks.
        // Catches operator typos that produce nonsensical
        // combinations BEFORE the agent boots with them.
        // Pre-Batch-39 a config like `mtls.mode: strict` with
        // `enforce_fingerprint_pinning: false` would load
        // silently, producing a confusing runtime log where
        // Strict mode claims fingerprint verification but
        // silently skips it.
        self.validate_faz2_security_coherence()?;

        debug!("Configuration validation passed");
        Ok(())
    }

    /// Faz 2 security-posture coherence checks (Batch 39).
    ///
    /// Catches operator typos that produce nonsensical
    /// combinations. Each rule returns an error string that
    /// points operators directly at the conflicting fields
    /// AND the expected relationship — fail-to-boot messages
    /// are the LAST chance to guide operators before silent
    /// misbehavior.
    fn validate_faz2_security_coherence(&self) -> Result<()> {
        // Rule 1: mtls.mode=strict implies fingerprint pinning
        // enforced. Strict mode's whole point is "reject TLS
        // handshake on fingerprint mismatch"; disabling
        // pinning in Strict mode is self-contradictory.
        if matches!(self.mtls.mode, crate::mtls::MtlsMode::Strict)
            && !self.mtls.enforce_fingerprint_pinning
        {
            anyhow::bail!(
                "Config coherence: mtls.mode=strict requires mtls.enforce_fingerprint_pinning=true (Strict mode's primary contract is fingerprint enforcement)"
            );
        }

        // EDGE-HIGH-010: release builds MUST NOT run a fail-open
        // command-authentication or TLS-pinning posture.
        // `signature_mode=disabled` accepts any command with no
        // signature check (FR1/FR2) and `mtls.mode=legacy` makes
        // cert pinning log-only (FR4). Both are intentional
        // debug/dev-rollout defaults (HC-1 / Batch-27 backward
        // compat) — the enums keep those `#[default]`s so debug
        // builds and staged rollouts still work — but shipping them
        // in a RELEASE build silently disables the controls the
        // product asserts. Fail closed; mirror the api_url release
        // gate above. Operators stage a rollout via a debug build or
        // an explicit `permissive`/`warn` step, never Disabled/Legacy
        // in release.
        #[cfg(not(debug_assertions))]
        {
            if matches!(
                self.signature_mode,
                crate::command_envelope::envelope::SignatureMode::Disabled
            ) {
                anyhow::bail!(
                    "Config coherence: signature_mode=disabled is not allowed in release \
                     builds (unsigned commands accepted — IEC 62443 FR1/FR2). Set \
                     signature_mode to `permissive` or `enforcing`; use a debug build for \
                     local development."
                );
            }
            if matches!(self.mtls.mode, crate::mtls::MtlsMode::Legacy) {
                anyhow::bail!(
                    "Config coherence: mtls.mode=legacy is not allowed in release builds \
                     (cert pinning is log-only — IEC 62443 FR4). Set mtls.mode to `warn` \
                     or `strict`; use a debug build for local development."
                );
            }
        }

        // Rule 2: max_command_skew_secs should be reasonable
        // relative to max_command_age_secs. A skew larger than
        // age would mean the agent accepts future-dated
        // commands beyond the replay window — logically
        // unsound (any command in the future-skew envelope
        // would also be within the age envelope when clocks
        // re-sync).
        if self.runtime.max_command_skew_secs > self.runtime.max_command_age_secs {
            anyhow::bail!(
                "Config coherence: runtime.max_command_skew_secs ({}) must be <= runtime.max_command_age_secs ({}) — skew larger than age is logically unsound",
                self.runtime.max_command_skew_secs,
                self.runtime.max_command_age_secs
            );
        }

        // Rule 3: drain_timeout_ms should be reasonable
        // relative to shutdown_timeout_secs. Drain budget in
        // milliseconds converting to seconds MUST be less
        // than the outer shutdown budget — otherwise a drain
        // that hits its timeout would exhaust the outer budget
        // leaving no time for safe-state + flush + MQTT
        // disconnect phases.
        let drain_as_secs = self.runtime.drain_timeout_ms / 1000;
        if drain_as_secs >= self.runtime.shutdown_timeout_secs {
            anyhow::bail!(
                "Config coherence: runtime.drain_timeout_ms ({}ms = {}s) must be < runtime.shutdown_timeout_secs ({}s) — leaving no time for safe-state + flush phases",
                self.runtime.drain_timeout_ms,
                drain_as_secs,
                self.runtime.shutdown_timeout_secs
            );
        }

        // Rule 4: config_integrity Permissive/Enforcing mode
        // requires a factory pubkey to be usable. Pre-Sprint-
        // 6.6 the firmware-embedded key doesn't exist yet, so
        // operators MUST supply `factory_pubkey_hex` when
        // opting into Permissive/Enforcing. Once Sprint 6.6
        // bundles the default key, `factory_pubkey_hex = None`
        // will mean "use firmware default" — a rule update
        // lands with that sprint.
        if !matches!(self.config_integrity.mode, ConfigIntegrityMode::Disabled)
            && self.config_integrity.factory_pubkey_hex.is_none()
        {
            anyhow::bail!(
                "Config coherence: config_integrity.mode={:?} requires config_integrity.factory_pubkey_hex (pre-Sprint-6.6 firmware key bundle). Set factory_pubkey_hex to a 64-char hex string OR set mode=disabled",
                self.config_integrity.mode
            );
        }

        // Rule 5: factory_pubkey_hex if present MUST be a
        // 64-char lowercase hex string (32 bytes ed25519
        // public key). Prevents operator typos from getting
        // past config load into the verify path where an
        // invalid key would cause all sigs to fail with a
        // confusing `InvalidSignature` error — catching it
        // at config-load time gives a specific `invalid key
        // format` error.
        if let Some(ref hex) = self.config_integrity.factory_pubkey_hex {
            if hex.len() != 64 {
                anyhow::bail!(
                    "Config coherence: config_integrity.factory_pubkey_hex must be 64 hex chars (32 bytes ed25519 pubkey), got {} chars",
                    hex.len()
                );
            }
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                anyhow::bail!(
                    "Config coherence: config_integrity.factory_pubkey_hex contains non-hex characters"
                );
            }
        }

        // Rule 6 (Batch 49): rate_limit_max_commands must be
        // positive. Setting 0 would either deadlock the
        // command handler (no command ever allowed) OR the
        // RateLimiter::check() would divide-by-zero-in-spirit
        // (any command count would be >= 0 = "not under
        // limit" so everything rejected). A nonsense config
        // MUST fail-fast rather than produce a mysteriously
        // unresponsive agent.
        if self.runtime.rate_limit_max_commands == 0 {
            anyhow::bail!(
                "Config coherence: runtime.rate_limit_max_commands must be > 0 (0 would reject every command)"
            );
        }

        // Rule 7: rate_limit_window_secs must be positive.
        // A 0-second window would make every command
        // instantaneously "expired" — RateLimiter evicts
        // timestamps older than window on each check. Same
        // fail-fast rationale as Rule 6.
        if self.runtime.rate_limit_window_secs == 0 {
            anyhow::bail!(
                "Config coherence: runtime.rate_limit_window_secs must be > 0 (0 would make every timestamp instantly-expired)"
            );
        }

        // Rule 8: max_command_age_secs must be positive.
        // A 0-second max_age would reject every command
        // with a timestamp older than "right now" (i.e.,
        // every command, since network + parse takes > 0s).
        if self.runtime.max_command_age_secs == 0 {
            anyhow::bail!(
                "Config coherence: runtime.max_command_age_secs must be > 0 (0 would reject every command due to parse+network latency)"
            );
        }

        // Rule 9 (Batch 56): clock.nts_sync_max_skew_secs
        // must be positive. A 0-second threshold would make
        // Sprint 6.7 ChronyNtsClockAuthority reject every
        // wall-clock read (any NTS sync age > 0 would fail
        // freshness check). Operators wanting "immediate
        // rejection" should set `clock.mode: disabled` (or
        // leave the authority un-wired in AppState) rather
        // than 0-threshold — clearer operator intent.
        if self.clock.nts_sync_max_skew_secs == 0 {
            anyhow::bail!(
                "Config coherence: clock.nts_sync_max_skew_secs must be > 0 (0 would reject every wall-clock read under Sprint 6.7 Chrony wire)"
            );
        }

        // Rule 10 (Batch 58): envelope_dedup.moka_capacity
        // must be positive. Zero capacity would disable dedup
        // entirely (no entries retained) — replay defense
        // silently off. Operators wanting dedup disabled
        // should leave signature_mode = Disabled rather than
        // 0-capacity (clearer intent).
        if self.envelope_dedup.moka_capacity == 0 {
            anyhow::bail!(
                "Config coherence: envelope_dedup.moka_capacity must be > 0 (0 silently disables replay defense)"
            );
        }

        // Rule 11 (Batch 58): envelope_dedup.moka_ttl_secs
        // must be in the sane range [30, 3600]. Below 30s:
        // TTL shorter than MQTT broker redelivery window,
        // replays sneak through. Above 3600s: Moka grows into
        // the SQLCipher tier's territory (Sprint 6.4 covers
        // 72-hour window) — operator likely confused about
        // which tier is which.
        if self.envelope_dedup.moka_ttl_secs < 30 || self.envelope_dedup.moka_ttl_secs > 3600 {
            anyhow::bail!(
                "Config coherence: envelope_dedup.moka_ttl_secs ({}) must be in [30, 3600] seconds — hot-window tier bounds",
                self.envelope_dedup.moka_ttl_secs
            );
        }

        // Rule 12 (Batch 66): rbac_manifest Permissive/
        // Enforcing mode requires manifest_signing_pubkey_hex.
        // Same rationale as Rule 4 (config_integrity): pre-
        // Sprint-6.1 the firmware-embedded default key
        // doesn't exist; operators opting into Permissive/
        // Enforcing MUST supply their own test key.
        if !matches!(self.rbac_manifest.mode, RbacManifestMode::Disabled)
            && self.rbac_manifest.manifest_signing_pubkey_hex.is_none()
        {
            anyhow::bail!(
                "Config coherence: rbac_manifest.mode={:?} requires rbac_manifest.manifest_signing_pubkey_hex (pre-Sprint-6.1 firmware key bundle). Set manifest_signing_pubkey_hex to a 64-char hex string OR set mode=disabled",
                self.rbac_manifest.mode
            );
        }

        // Rule 13 (Batch 66): manifest_signing_pubkey_hex if
        // present MUST be 64-char lowercase hex. Same rationale
        // as Rule 5 (config_integrity): catches typos at
        // config-load time instead of producing confusing
        // `InvalidSignature` runtime errors downstream.
        if let Some(ref hex) = self.rbac_manifest.manifest_signing_pubkey_hex {
            if hex.len() != 64 {
                anyhow::bail!(
                    "Config coherence: rbac_manifest.manifest_signing_pubkey_hex must be 64 hex chars (32 bytes ed25519 pubkey), got {} chars",
                    hex.len()
                );
            }
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                anyhow::bail!(
                    "Config coherence: rbac_manifest.manifest_signing_pubkey_hex contains non-hex characters"
                );
            }
        }

        // Rule 14 (Batch 71): rbac_manifest.version_store_path
        // if set MUST point to a writable location (same
        // filesystem permission class as offline_queue.sqlite
        // + scada_db.sqlite). We cannot check writability at
        // config-load time (the path may not yet exist) — we
        // DO check that it has a parent component so
        // `std::fs::create_dir_all` in ManifestVersionStore::
        // open can succeed. An empty or root-only path is a
        // likely misconfiguration.
        if let Some(ref path) = self.rbac_manifest.version_store_path {
            if path.as_os_str().is_empty() {
                anyhow::bail!(
                    "Config coherence: rbac_manifest.version_store_path is set to an empty path. \
                     Either omit the field (defaults to /var/lib/suderra/rbac_version.sqlite) or \
                     provide a valid filesystem path."
                );
            }
            if path
                .parent()
                .map(|p| p.as_os_str().is_empty())
                .unwrap_or(true)
            {
                anyhow::bail!(
                    "Config coherence: rbac_manifest.version_store_path={} has no parent directory. \
                     Provide an absolute path with a parent dir (e.g. /var/lib/suderra/rbac_version.sqlite).",
                    path.display()
                );
            }
        }

        // Rule 15 (Batch 78, relaxed Batch 84): audit.mode=
        // Enabled requires EITHER a live keystore (keystore.
        // mode != Disabled) OR audit.hmac_key_hex. The
        // keystore-derived path (preferred) derives the HMAC
        // key via KeyPurpose::AuditHmacChain; hex config is
        // the rollout-stage fallback.
        if matches!(self.audit.mode, AuditMode::Enabled)
            && self.audit.hmac_key_hex.is_none()
            && matches!(self.keystore.mode, KeystoreMode::Disabled)
        {
            anyhow::bail!(
                "Config coherence: audit.mode=Enabled requires EITHER keystore.mode != Disabled (preferred — \
                 derives HMAC key via KeyPurpose::AuditHmacChain) OR audit.hmac_key_hex (rollout-stage fallback, \
                 64-char lowercase hex). Both are currently unset."
            );
        }

        // Rule 16 (Batch 78): audit.hmac_key_hex if present
        // MUST be 64-char lowercase hex. Matches Rule 13
        // discipline for manifest_signing_pubkey_hex.
        if let Some(ref hex) = self.audit.hmac_key_hex {
            if hex.len() != 64 {
                anyhow::bail!(
                    "Config coherence: audit.hmac_key_hex must be 64 hex chars (32-byte HMAC key), got {} chars",
                    hex.len()
                );
            }
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                anyhow::bail!("Config coherence: audit.hmac_key_hex contains non-hex characters");
            }
        }

        // Rule 17 (Batch 78): audit.log_path if set must
        // have a parent component. Same sanity check as Rule
        // 14 for rbac_manifest.version_store_path.
        if let Some(ref path) = self.audit.log_path {
            if path.as_os_str().is_empty() {
                anyhow::bail!(
                    "Config coherence: audit.log_path is set to an empty path. \
                     Either omit the field (defaults to /var/log/suderra/audit.log) or \
                     provide a valid filesystem path."
                );
            }
            if path
                .parent()
                .map(|p| p.as_os_str().is_empty())
                .unwrap_or(true)
            {
                anyhow::bail!(
                    "Config coherence: audit.log_path={} has no parent directory. \
                     Provide an absolute path with a parent dir.",
                    path.display()
                );
            }
        }

        // Rule 18 (Batch 83): Argon2id params MUST meet
        // OWASP 2024 floor (memory >= 19456 KiB, iterations
        // >= 2, parallelism >= 1) when keystore.mode !=
        // Disabled. Matches Argon2idParams::validate()
        // semantic in keystore/file_backed.rs but fails
        // early at config-load (better operator UX than
        // letting the keystore::open call surface the same
        // error at boot).
        if !matches!(self.keystore.mode, KeystoreMode::Disabled) {
            if self.keystore.argon2_memory_kib < 19_456 {
                anyhow::bail!(
                    "Config coherence: keystore.argon2_memory_kib={} below OWASP 2024 floor (19456 KiB = 19 MiB). \
                     Set to >= 19456, or set keystore.mode=disabled to skip keystore.",
                    self.keystore.argon2_memory_kib
                );
            }
            if self.keystore.argon2_iterations < 2 {
                anyhow::bail!(
                    "Config coherence: keystore.argon2_iterations={} below OWASP 2024 floor (2). \
                     Set to >= 2, or set keystore.mode=disabled.",
                    self.keystore.argon2_iterations
                );
            }
            if self.keystore.argon2_parallelism == 0 {
                anyhow::bail!("Config coherence: keystore.argon2_parallelism must be >= 1, got 0.");
            }
        }

        // Rule 19 (Batch 83): keystore.mode=FileBacked
        // requires all three file paths (passphrase, salt,
        // acceptance) — when explicit FileBacked is chosen,
        // the operator CANNOT rely on defaults for one and
        // set another explicitly. Auto mode uses defaults
        // for any unset path.
        if matches!(self.keystore.mode, KeystoreMode::FileBacked) {
            let has_any = self.keystore.passphrase_path.is_some()
                || self.keystore.salt_path.is_some()
                || self.keystore.acceptance_path.is_some();
            let has_all = self.keystore.passphrase_path.is_some()
                && self.keystore.salt_path.is_some()
                && self.keystore.acceptance_path.is_some();
            if has_any && !has_all {
                anyhow::bail!(
                    "Config coherence: keystore.mode=file_backed with SOME paths set requires ALL paths set \
                     (passphrase_path, salt_path, acceptance_path). Either set all three explicitly or \
                     omit all three to use /etc/suderra/keystore.* defaults."
                );
            }
        }

        // Rule 20 (Batch 114): firmware_update mode != Disabled
        // requires a parseable 64-char hex ed25519 pubkey.
        // Same fail-fast discipline as Rule 12 (rbac_manifest)
        // + Rule 4 (config_integrity): catches operator typos
        // + unconfigured production deployments at boot time
        // rather than at first firmware-deploy attempt.
        if !matches!(self.firmware_update.mode, FirmwareUpdateMode::Disabled)
            && self.firmware_update.signing_pubkey_hex.is_none()
        {
            anyhow::bail!(
                "Config coherence: firmware_update.mode={:?} requires firmware_update.signing_pubkey_hex \
                 (64-char hex ed25519 pubkey). Set signing_pubkey_hex OR set mode=disabled.",
                self.firmware_update.mode
            );
        }

        // Rule 21 (Batch 114): firmware_update.signing_pubkey_hex
        // if set MUST be a parseable 64-char hex string.
        // Same validation as Rule 13 (rbac_manifest) + Rule 5
        // (config_integrity) — catches typos at config load
        // rather than at first verify.
        if let Some(ref hex) = self.firmware_update.signing_pubkey_hex {
            if hex.len() != 64 {
                anyhow::bail!(
                    "Config coherence: firmware_update.signing_pubkey_hex must be 64 hex chars (32 bytes ed25519 pubkey), got {} chars",
                    hex.len()
                );
            }
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                anyhow::bail!(
                    "Config coherence: firmware_update.signing_pubkey_hex contains non-hex characters"
                );
            }
        }

        // Rule 22 (Batch 123): firmware_update.ab_partitions
        // must be BOTH-SET or BOTH-UNSET. Half-configured is
        // an operator typo signal — either fully A/B enable
        // the device or leave the file-streaming path
        // disabled. Mirrors the Rule 19 FileBacked-keystore
        // all-or-none discipline.
        let a_set = self.firmware_update.ab_partitions.slot_a_mount.is_some();
        let b_set = self.firmware_update.ab_partitions.slot_b_mount.is_some();
        if a_set != b_set {
            anyhow::bail!(
                "Config coherence: firmware_update.ab_partitions must have BOTH slot_a_mount \
                 AND slot_b_mount set, or BOTH unset. Half-configured A/B mounts \
                 (slot_a_mount.is_some={}, slot_b_mount.is_some={}) would leave \
                 cmd_apply_signed_manifest unable to determine the target standby slot.",
                a_set,
                b_set
            );
        }

        // Rule 23 (Batch 123): if ab_partitions paths are
        // set, they MUST NOT be equal. Same-path for both
        // slots would overwrite the active firmware on
        // every deploy attempt. Tier-1 make-it-impossible.
        if let (Some(a), Some(b)) = (
            self.firmware_update.ab_partitions.slot_a_mount.as_ref(),
            self.firmware_update.ab_partitions.slot_b_mount.as_ref(),
        ) {
            if a == b {
                anyhow::bail!(
                    "Config coherence: firmware_update.ab_partitions.slot_a_mount and \
                     slot_b_mount are identical ({}). A/B requires two DISTINCT mount \
                     points — pointing both at the same path would overwrite the \
                     active firmware on every apply_signed_manifest invocation.",
                    a.display()
                );
            }
        }

        // Rule 24 (Batch 137): mtls.mode=Strict REQUIRES at
        // least one pinned leaf fingerprint. Plan §3 R-6 +
        // ADR-021 §10: Strict mode is "reject handshake on
        // any mismatch" — with an empty pin set, EVERY
        // handshake would mismatch + reject, bricking the
        // device's TLS connectivity. Fail-fast at config
        // load so operators don't discover this at first
        // MQTT connect.
        if matches!(self.mtls.mode, crate::mtls::MtlsMode::Strict)
            && self.mtls.pinned_leaf_fingerprints_hex.is_empty()
        {
            anyhow::bail!(
                "Config coherence: mtls.mode=Strict requires at least one entry in \
                 mtls.pinned_leaf_fingerprints_hex. Supply the expected leaf cert \
                 SHA-256 hex digest(s) or downgrade mode to Warn during rollout."
            );
        }

        // Rule 25 (Batch 137): each pinned fingerprint hex
        // MUST be 64 chars of ASCII hex. Same validation
        // discipline as Rule 21 (firmware signing pubkey).
        for (idx, hex) in self.mtls.pinned_leaf_fingerprints_hex.iter().enumerate() {
            if hex.len() != 64 {
                anyhow::bail!(
                    "Config coherence: mtls.pinned_leaf_fingerprints_hex[{}] must be 64 hex chars (32-byte SHA-256), got {} chars",
                    idx,
                    hex.len()
                );
            }
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                anyhow::bail!(
                    "Config coherence: mtls.pinned_leaf_fingerprints_hex[{}] contains non-hex characters",
                    idx
                );
            }
        }

        Ok(())
    }

    /// Save configuration to file
    pub fn save(&self) -> Result<()> {
        self.save_to(DEFAULT_CONFIG_PATH)
    }

    /// Save configuration to specified path
    ///
    /// # Security
    /// On Unix systems, this sets file permissions to 0600 (owner read/write only)
    /// to protect sensitive credentials stored in the config file.
    pub fn save_to(&self, path: &str) -> Result<()> {
        let path = PathBuf::from(path);

        let content = serde_yaml::to_string(self).context("Failed to serialize config")?;

        // Atomic write: write to .tmp file then rename, preventing partial writes
        // and ensuring restrictive permissions from the start (no TOCTOU race).
        let tmp_path = path.with_extension("yaml.tmp");

        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp_path)
                .with_context(|| {
                    format!("Failed to create temp config file: {}", tmp_path.display())
                })?;
            std::io::Write::write_all(&mut file, content.as_bytes()).with_context(|| {
                format!("Failed to write temp config file: {}", tmp_path.display())
            })?;
            file.sync_all().with_context(|| {
                format!("Failed to sync temp config file: {}", tmp_path.display())
            })?;
        }

        #[cfg(not(unix))]
        {
            fs::write(&tmp_path, &content).with_context(|| {
                format!("Failed to write temp config file: {}", tmp_path.display())
            })?;
        }

        fs::rename(&tmp_path, &path).with_context(|| {
            format!(
                "Failed to rename config file: {} -> {}",
                tmp_path.display(),
                path.display()
            )
        })?;

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

    // ====================================================================
    // Batch 192 Faz 4 — ScriptingConfig.tasks schema round-trip
    // ====================================================================

    #[test]
    fn scripting_config_tasks_default_is_empty_vec() {
        let cfg = ScriptingConfig::default();
        assert!(cfg.tasks.is_empty());
    }

    #[test]
    fn scripting_config_tasks_missing_key_deserializes_to_empty() {
        // Legacy config.yaml without `tasks:` still
        // parses cleanly — backward compat.
        let yaml = r#"
enabled: true
default_scan_cycle_ms: 1000
min_scan_cycle_ms: 10
max_scan_cycle_ms: 10000
max_function_blocks: 50
max_execution_depth: 10
max_actions: 1000
max_execution_time_secs: 30
bytecode_store_path: ""
"#;
        let cfg: ScriptingConfig = serde_yaml::from_str(yaml).expect("ok");
        assert!(cfg.tasks.is_empty());
    }

    #[test]
    fn scripting_config_tasks_round_trip_with_populated_vec() {
        use crate::scripting::task_scheduler::{SloTier, TaskKind};

        let yaml = r#"
enabled: true
default_scan_cycle_ms: 1000
min_scan_cycle_ms: 10
max_scan_cycle_ms: 10000
max_function_blocks: 50
max_execution_depth: 10
max_actions: 1000
max_execution_time_secs: 30
bytecode_store_path: "/var/lib/suderra/bytecode.db"
tasks:
  - name: safety_alarms
    kind:
      kind: cyclic
      period_ms: 500
    slo_tier: safety_critical
    watchdog_ms: 400
    programs:
      - o2_guard
      - ph_guard
  - name: feed_schedule
    kind:
      kind: cyclic
      period_ms: 1200
    slo_tier: routine
    watchdog_ms: 1000
    programs:
      - feeder_cron
  - name: on_temp_change
    kind:
      kind: event
      event_tag: water_temp
    slo_tier: safety_critical
    watchdog_ms: 300
    programs:
      - temp_alarm_eval
"#;
        let cfg: ScriptingConfig = serde_yaml::from_str(yaml).expect("ok");
        assert_eq!(cfg.tasks.len(), 3);

        assert_eq!(cfg.tasks[0].name, "safety_alarms");
        assert_eq!(cfg.tasks[0].slo_tier, SloTier::SafetyCritical);
        assert_eq!(cfg.tasks[0].programs, vec!["o2_guard", "ph_guard"]);
        assert_eq!(cfg.tasks[0].kind, TaskKind::Cyclic { period_ms: 500 });

        assert_eq!(cfg.tasks[1].name, "feed_schedule");
        assert_eq!(cfg.tasks[1].slo_tier, SloTier::Routine);

        assert_eq!(cfg.tasks[2].name, "on_temp_change");
        assert_eq!(
            cfg.tasks[2].kind,
            TaskKind::Event {
                event_tag: "water_temp".into()
            }
        );
    }

    #[test]
    fn test_topic_resolution() {
        let topics = MqttTopics::default();
        let resolved = topics.resolve("tenant-123", "device-456");

        assert_eq!(
            resolved.status,
            "tenants/tenant-123/devices/device-456/status"
        );
        assert_eq!(
            resolved.telemetry,
            "tenants/tenant-123/devices/device-456/telemetry"
        );
        assert_eq!(
            resolved.commands,
            "tenants/tenant-123/devices/device-456/commands"
        );
    }

    // ========================================================================
    // Cache Config Tests (v1.2.0)
    // ========================================================================

    #[test]
    fn test_cache_config_defaults() {
        let config = CacheConfig::default();

        assert_eq!(config.max_capacity, 1000);
        assert_eq!(config.ttl_secs, 3600); // 1 hour
        assert_eq!(config.tti_secs, 1800); // 30 minutes
    }

    #[test]
    fn test_cache_config_serialization() {
        let config = CacheConfig {
            max_capacity: 5000,
            ttl_secs: 7200,
            tti_secs: 3600,
        };

        let yaml = serde_yaml::to_string(&config).unwrap();
        assert!(yaml.contains("max_capacity: 5000"));
        assert!(yaml.contains("ttl_secs: 7200"));
        assert!(yaml.contains("tti_secs: 3600"));

        // Deserialize back
        let parsed: CacheConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.max_capacity, 5000);
        assert_eq!(parsed.ttl_secs, 7200);
        assert_eq!(parsed.tti_secs, 3600);
    }

    // ========================================================================
    // Circuit Breaker Config Tests (v1.2.0)
    // ========================================================================

    #[test]
    fn test_circuit_breaker_config_defaults() {
        let config = CircuitBreakerConfig::default();

        assert_eq!(config.failure_threshold, 3);
        assert_eq!(config.success_threshold, 2);
        assert_eq!(config.recovery_secs, 30);
        assert_eq!(config.half_open_permits, 1);
    }

    #[test]
    fn test_circuit_breaker_config_serialization() {
        let config = CircuitBreakerConfig {
            failure_threshold: 5,
            success_threshold: 3,
            recovery_secs: 60,
            half_open_permits: 2,
        };

        let yaml = serde_yaml::to_string(&config).unwrap();
        assert!(yaml.contains("failure_threshold: 5"));
        assert!(yaml.contains("success_threshold: 3"));
        assert!(yaml.contains("recovery_secs: 60"));
        assert!(yaml.contains("half_open_permits: 2"));

        // Deserialize back
        let parsed: CircuitBreakerConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.failure_threshold, 5);
        assert_eq!(parsed.success_threshold, 3);
        assert_eq!(parsed.recovery_secs, 60);
        assert_eq!(parsed.half_open_permits, 2);
    }

    #[test]
    fn test_circuit_breaker_config_partial_yaml() {
        // Test that missing fields use defaults
        let yaml = "failure_threshold: 10\n";
        let config: CircuitBreakerConfig = serde_yaml::from_str(yaml).unwrap();

        assert_eq!(config.failure_threshold, 10);
        assert_eq!(config.success_threshold, 2); // default
        assert_eq!(config.recovery_secs, 30); // default
        assert_eq!(config.half_open_permits, 1); // default
    }

    // ========================================================================
    // Modbus TLS Config Tests (v1.2.0)
    // ========================================================================

    #[test]
    fn test_modbus_tls_config_defaults() {
        let config = ModbusTlsConfig::default();

        assert!(!config.enabled);
        assert!(config.server_name.is_none());
        assert!(config.ca_cert_path.is_none());
        assert!(config.client_cert_path.is_none());
        assert!(config.client_key_path.is_none());
        assert!(!config.insecure_skip_verify);
    }

    #[test]
    fn test_modbus_tls_config_serialization() {
        let config = ModbusTlsConfig {
            enabled: true,
            server_name: Some("plc.example.com".to_string()),
            ca_cert_path: Some("/etc/certs/ca.pem".to_string()),
            client_cert_path: Some("/etc/certs/client.pem".to_string()),
            client_key_path: Some("/etc/certs/client.key".to_string()),
            insecure_skip_verify: false,
        };

        let yaml = serde_yaml::to_string(&config).unwrap();
        assert!(yaml.contains("enabled: true"));
        assert!(yaml.contains("server_name: plc.example.com"));
        assert!(yaml.contains("ca_cert_path:"));

        // Deserialize back
        let parsed: ModbusTlsConfig = serde_yaml::from_str(&yaml).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.server_name, Some("plc.example.com".to_string()));
    }

    #[test]
    fn test_modbus_device_config_with_tls() {
        let yaml = r#"
name: "PLC-001"
connection_type: "tcp"
address: "192.168.1.100:502"
slave_id: 1
tls:
  enabled: true
  server_name: "plc.local"
  insecure_skip_verify: true
"#;

        let config: ModbusDeviceConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.name, "PLC-001");
        assert!(config.tls.enabled);
        assert_eq!(config.tls.server_name, Some("plc.local".to_string()));
        assert!(config.tls.insecure_skip_verify);
    }

    #[test]
    fn test_modbus_device_config_without_tls() {
        let yaml = r#"
name: "PLC-002"
connection_type: "tcp"
address: "192.168.1.101:502"
"#;

        let config: ModbusDeviceConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.name, "PLC-002");
        assert!(!config.tls.enabled); // Default: TLS disabled
    }

    // ========================================================================
    // Installer-generated config parsing test
    // ========================================================================

    #[test]
    fn test_parse_installer_generated_config() {
        let yaml = r#"
# Suderra Edge Agent Configuration
# Generated: 2026-02-26T17:42:53.971Z

device_id: "fd23af6b-167f-4afd-a62a-ceace2a4046b"
device_code: "PI-32F7A01B"
api_url: "https://app.suderra.com"
provisioning_token: "06903c054e5122df8f024ca09ade5cbad8724997598712772788a023f841c552"

mqtt:
  broker: "mosquitto"
  port: 1883
  keepalive_secs: 60
  clean_session: false

telemetry:
  interval_seconds: 30
  include_cpu: true
  include_memory: true
  include_disk: true
  include_temperature: true

modbus: []

gpio: []
"#;

        let config: AgentConfig =
            serde_yaml::from_str(yaml).expect("Failed to parse installer-generated config");

        assert_eq!(config.device_id, "fd23af6b-167f-4afd-a62a-ceace2a4046b");
        assert_eq!(config.device_code, "PI-32F7A01B");
        assert_eq!(config.api_url, "https://app.suderra.com");
        assert_eq!(config.mqtt.broker, Some("mosquitto".to_string()));
        assert_eq!(config.mqtt.port, 1883);
        assert_eq!(config.mqtt.keepalive_secs, 60);
        assert!(!config.mqtt.clean_session);
        assert_eq!(config.telemetry.interval_seconds, 30);
        assert!(config.modbus.is_empty());
        assert!(config.gpio.is_empty());
    }

    // ========================================================================
    // Firmware Update Config Tests (Batch 114 Sprint 6.5)
    // ========================================================================

    #[test]
    fn test_firmware_update_config_default_is_disabled() {
        let config = FirmwareUpdateConfig::default();
        assert!(matches!(config.mode, FirmwareUpdateMode::Disabled));
        assert!(config.signing_pubkey_hex.is_none());
    }

    #[test]
    fn test_firmware_update_config_yaml_roundtrip() {
        let config = FirmwareUpdateConfig {
            mode: FirmwareUpdateMode::Enforcing,
            signing_pubkey_hex: Some("a".repeat(64)),
            bootloader_backend: BootloaderBackend::default(),
            tryboot_autoboot_path: None,
            ab_partitions: AbPartitionMountConfig::default(),
        };
        let yaml = serde_yaml::to_string(&config).unwrap();
        assert!(yaml.contains("mode: enforcing"));
        assert!(yaml.contains(&"a".repeat(64)));
        let parsed: FirmwareUpdateConfig = serde_yaml::from_str(&yaml).unwrap();
        assert!(matches!(parsed.mode, FirmwareUpdateMode::Enforcing));
        assert_eq!(parsed.signing_pubkey_hex, Some("a".repeat(64)));
    }

    #[test]
    fn test_firmware_update_mode_disabled_accepts_none_pubkey() {
        let yaml = r#"
mode: disabled
"#;
        let config: FirmwareUpdateConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(matches!(config.mode, FirmwareUpdateMode::Disabled));
        assert!(config.signing_pubkey_hex.is_none());
    }

    #[test]
    fn test_firmware_update_permissive_mode_parses() {
        let yaml = r#"
mode: permissive
signing_pubkey_hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
"#;
        let config: FirmwareUpdateConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(matches!(config.mode, FirmwareUpdateMode::Permissive));
        assert_eq!(
            config.signing_pubkey_hex.as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
    }

    // ========================================================================
    // AbPartitionMountConfig tests (Batch 123 Sprint 6.5)
    // ========================================================================

    #[test]
    fn test_ab_partitions_default_is_both_none() {
        let c = AbPartitionMountConfig::default();
        assert!(c.slot_a_mount.is_none());
        assert!(c.slot_b_mount.is_none());
        assert!(!c.is_fully_configured());
    }

    #[test]
    fn test_ab_partitions_is_fully_configured_requires_both() {
        let mut c = AbPartitionMountConfig::default();
        assert!(!c.is_fully_configured());

        c.slot_a_mount = Some(std::path::PathBuf::from("/mnt/slot-a"));
        assert!(!c.is_fully_configured());

        c.slot_b_mount = Some(std::path::PathBuf::from("/mnt/slot-b"));
        assert!(c.is_fully_configured());

        c.slot_a_mount = None;
        assert!(!c.is_fully_configured());
    }

    #[test]
    fn test_ab_partitions_yaml_roundtrip() {
        let yaml = r#"
slot_a_mount: /mnt/slot-a
slot_b_mount: /mnt/slot-b
"#;
        let c: AbPartitionMountConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(
            c.slot_a_mount,
            Some(std::path::PathBuf::from("/mnt/slot-a"))
        );
        assert_eq!(
            c.slot_b_mount,
            Some(std::path::PathBuf::from("/mnt/slot-b"))
        );
        assert!(c.is_fully_configured());
    }

    #[test]
    fn test_firmware_update_config_embeds_ab_partitions() {
        let yaml = r#"
mode: permissive
signing_pubkey_hex: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
ab_partitions:
  slot_a_mount: /mnt/slot-a
  slot_b_mount: /mnt/slot-b
"#;
        let c: FirmwareUpdateConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(c.ab_partitions.is_fully_configured());
        assert_eq!(
            c.ab_partitions.slot_a_mount,
            Some(std::path::PathBuf::from("/mnt/slot-a"))
        );
    }

    #[test]
    fn test_firmware_update_config_omitted_ab_partitions_defaults_to_none() {
        let yaml = r#"
mode: disabled
"#;
        let c: FirmwareUpdateConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(!c.ab_partitions.is_fully_configured());
        assert!(c.ab_partitions.slot_a_mount.is_none());
        assert!(c.ab_partitions.slot_b_mount.is_none());
    }

    // ========================================================================
    // BootloaderBackend tests (Batch 128 Sprint 6.5)
    // ========================================================================

    #[test]
    fn test_bootloader_backend_default_is_noop() {
        let b = BootloaderBackend::default();
        assert!(matches!(b, BootloaderBackend::Noop));
    }

    #[test]
    fn test_bootloader_backend_yaml_parses_tryboot() {
        let yaml = r#"
mode: permissive
signing_pubkey_hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
bootloader_backend: tryboot
tryboot_autoboot_path: /boot/firmware/autoboot.txt
"#;
        let c: FirmwareUpdateConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(matches!(c.bootloader_backend, BootloaderBackend::Tryboot));
        assert_eq!(
            c.tryboot_autoboot_path,
            Some(std::path::PathBuf::from("/boot/firmware/autoboot.txt"))
        );
    }

    // ========================================================================
    // Batch 137 Sprint 6.6/6.8 — mtls.pinned_leaf_fingerprints_hex tests
    // ========================================================================

    #[test]
    fn test_mtls_config_default_pinned_list_is_empty() {
        let c = MtlsConfig::default();
        assert!(c.pinned_leaf_fingerprints_hex.is_empty());
    }

    #[test]
    fn test_mtls_config_yaml_accepts_pinned_list() {
        let yaml = r#"
mode: warn
pinned_leaf_fingerprints_hex:
  - "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  - "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
"#;
        let c: MtlsConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(c.pinned_leaf_fingerprints_hex.len(), 2);
        assert!(matches!(c.mode, crate::mtls::MtlsMode::Warn));
    }

    #[test]
    fn test_mtls_config_yaml_omitted_pins_yields_empty_vec() {
        let yaml = r#"
mode: legacy
"#;
        let c: MtlsConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(c.pinned_leaf_fingerprints_hex.is_empty());
    }

    #[test]
    fn test_bootloader_backend_yaml_defaults_to_noop_when_omitted() {
        let yaml = r#"
mode: disabled
"#;
        let c: FirmwareUpdateConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(matches!(c.bootloader_backend, BootloaderBackend::Noop));
        assert!(c.tryboot_autoboot_path.is_none());
    }
}
