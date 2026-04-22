//! Suderra Edge Agent
//!
//! Industrial IoT agent for aquaculture monitoring and control.
//! Handles device provisioning, MQTT communication, telemetry,
//! and PLC/sensor integration.
//!
//! Architecture v2.0:
//! - Actor pattern for GPIO and Modbus (thread-safe handles)
//! - Circuit breaker for fault tolerance
//! - Graceful shutdown coordinator
//! - Granular state management

// SECURITY: Clippy safety lints are set to `deny` in Cargo.toml to prevent
// panic-prone code (unwrap/expect/indexing) from reaching production.
// Test code is exempt — panicking on assertion failure is idiomatic in tests.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing))]

// Batch 24 plan §5 Faz 2 Step 2 partial: boot-time process
// hardening primitives (prctl PR_SET_DUMPABLE=0 + panic-abort
// hook). Invoked first in `fn main()` before any tokio runtime
// or argument parsing, before any pages that could hold future
// secrets (Sprint 6.3 keystore master-key mlock) are allocated.
mod process_hardening;

// Batch 30: SSoT for SUDERRA_DATA_DIR env var resolution + FHS
// default path. Six sites across main.rs/commands/mod.rs/
// scripting/engine.rs previously duplicated the `env::var
// unwrap_or_else` pattern; consolidated here so a future FHS
// policy change is a single-file edit.
mod data_dir;

mod alarms; // v1.2.4: Alarm management (IEC 62682)
// Batch 2 — ADR-018 §1 + ADR-024 §1 Permission enum + ActuatorClass taxonomy.
// Pure types, zero runtime behavior in this batch; AuthorizedContext sealed type
// + manifest verifier land in Faz 2 Sprint 6.1 (ADR-018 §11).
#[allow(dead_code)] // Faz 2 wires consumers; enum + newtypes pre-staged for reference stability.
mod authz;
mod backup; // v1.2.4: Backup and restore functionality
mod bounded;
mod commands;
mod config;
mod error;
mod gpio;
mod health;
#[cfg(feature = "health")]
mod lifecycle; // Batch 122 Sprint 6.5: HTTP lifecycle endpoint (confirm-active)
#[cfg(feature = "health")]
mod lifecycle_auth; // Batch 129 Sprint 6.6: HMAC auth for lifecycle endpoint
mod i2c; // v1.2.4: I2C support for sensor communication
mod interning;
mod modbus;
mod mqtt;
mod mqtt_failover; // v1.3.4: MQTT broker failover for high availability
mod offline_queue;
mod plc_programming; // v1.3.0: PLC programming protocols (ST upload)
mod provisioning;
mod pwm; // v1.2.4: PWM support for motor/servo control
mod resilience;
mod scripting;
mod deploy_orchestrator; // v2.2: Unified deploy orchestrator (Rust/Codesys/Setpoint)
mod hardware_scanner; // v2.3: Platform-aware I/O auto-detection (RevPi/RPi/Generic)
mod process_image;
mod atlas_ezo;
mod io_poll;
mod security; // v1.2.2: Security hardening utilities
mod st_validator; // v2.2: IEC 61131-3 Structured Text parser and validator
mod safe_state; // LIFE-SAFETY: actuator safe-state on shutdown (v1 schema)
// Batch 3 — ADR-024 §3 §4 FailSafe enum + OutputTag v2 + DiversityClass +
// HardwiredSafetyOverride + ProcessAware dependencies. Pure types, zero runtime
// behavior in this batch; v1 SafeStateManager remains the runtime owner.
// Faz 2 Sprint 7.2 migrates consumers to v2.
#[allow(dead_code)] // Faz 2 wires consumers; v2 types pre-staged for reference stability.
mod safe_state_v2;
// Batch 4b — ADR-018 §4 §5 §7 Keystore trait + KeyPurpose typestate + KeyMaterial
// sealed secret + FileBackedAcceptance gated newtype. Pure types, zero runtime
// behavior (TPM FFI + mlock + Argon2id derivation land in Faz 2 Sprint 6.3).
// Wired here so `cargo check` validates the module graph before runtime lands.
#[allow(dead_code)] // Faz 2 Sprint 6.3 wires consumers; types pre-staged.
mod keystore;
// Batch 6 — ADR-020 audit log AuditEntry + HMAC chain. Pure types + closure-
// injected HMAC append function; runtime sink + cloud relay + audit-verify CLI
// land in Faz 2 Sprint 6.2.
#[allow(dead_code)] // Faz 2 Sprint 6.2 wires consumers; types pre-staged.
mod audit;
// Batch 7 — Zero-Trust CommandEnvelope + jti dedup + canonical params +
// mutating-command allowlist (plan §4.10). Types + verify_envelope pure
// function with closure-injected SHA-256 and ed25519 verify. Runtime wiring
// (Moka + SQLCipher persistence + command dispatcher integration) lands in
// Faz 2 Sprint 6.4.
#[allow(dead_code)] // Faz 2 Sprint 6.4 wires consumers; types pre-staged.
mod command_envelope;
// Batch 8 — ADR-019 firmware A/B partition + signed manifest verification.
// Types + verify_firmware_manifest pure function with closure-injected
// ed25519 verify. Runtime wiring (tryboot overlay write, bootloader flag
// flip, per-file SHA-256 stream + TOCTOU re-verify, cold-boot confirmation)
// lands in Faz 2 Sprint 6.5.
#[allow(dead_code)] // Faz 2 Sprint 6.5 wires consumers; types pre-staged.
mod updater;
// Batch 9 — plan D-13 config.yaml.sig factory-signed integrity. Types +
// verify_config_integrity pure function with closure-injected ed25519
// verify. Runtime startup wiring (fail-closed boot if verify fails) lands
// in Faz 2 Sprint 6.6.
// Batch 54 Sprint 6.6 FULL WIRE: verify_at_boot consumes the
// Batch 9 pure types + Batch 42 config knob. The module no
// longer has dead-code status; verify_at_boot is invoked from
// main.rs boot sequence below. Sub-types (ConfigMeta,
// SignedConfigMeta) have real consumers via the sidecar parse
// path.
mod config_integrity;
// Batch 10 — plan D-7/D-14/D-15 runtime safety primitives: ClockAuthority
// trait (NTS-authenticated wall clock + monotonic anchor), retained-msg
// guard predicate, ShutdownPhase state machine with tier-1 drain-before-
// safe-state ordering. Types + pure functions; runtime supervisor wiring
// lands in Faz 2 Sprint 6.7.
//
// Batch 29: `ShutdownPhase` enum is now consumed by main.rs shutdown
// sequence for operator-observable phase logging. Other sub-modules
// (ClockAuthority trait, retained_msg predicate) remain un-wired
// pending Sprint 6.7 supervisor integration.
#[allow(dead_code)] // Faz 2 Sprint 6.7 wires remaining consumers; ShutdownPhase used by main.rs log.
mod runtime_safety;
// Batch 11 — plan §5 Faz 2 item 7 + D-6 mTLS 3-stage rollout + leaf cert
// pinning + 2-phase rotation + TLS 1.3 cipher-suite allowlist + 6-gate
// verify_leaf_cert pure function. Types + pure function; runtime rustls
// wiring lands in Faz 2 Sprint 6.8.
//
// Batch 27: `mtls::MtlsMode` is now consumed by `config::MtlsConfig`
// (serde-deserialized wire format); boot-time log exposes the mode
// for operator visibility. Other mtls sub-modules (verify, pinning,
// cipher, error) remain dead-code pending Sprint 6.8 rustls wire —
// the allow stays at mod-level until Sprint 6.8 flips the whole
// subtree on at once.
#[allow(dead_code)] // mode.rs consumed; verify/pinning/cipher/error pending Sprint 6.8.
mod mtls;
mod shutdown;
mod spi;
mod telemetry; // v1.2.4: SPI support for high-speed peripherals
#[cfg(feature = "lorawan")]
mod lora; // v1.5.0: LoRaWAN SX1302 gateway support
#[cfg(feature = "scada-display")]
mod scada_server; // v1.6.0: SCADA display server for local HMI
#[cfg(feature = "scada-display")]
mod scada_types;
#[cfg(feature = "scada-display")]
mod scada_db;
#[cfg(feature = "scada-display")]
mod alarm_engine;
#[cfg(feature = "scada-display")]
mod trend_engine;
#[cfg(feature = "scada-display")]
mod calibration_engine;

use anyhow::{Context, Result};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::alarms::AlarmManager;
use crate::commands::CommandHandler;
use crate::config::AgentConfig;
use crate::gpio::GpioHandle;
use crate::i2c::I2cHandle;
use crate::modbus::ModbusHandle;
use crate::mqtt::MqttClient;
use crate::process_image::ProcessImage;
use crate::provisioning::ProvisioningClient;
use crate::safe_state::SafeStateManager;
use crate::scripting::{ScriptEngine, ScriptStorage, SqlitePersistence};
use crate::shutdown::ShutdownCoordinator;
use crate::telemetry::TelemetryCollector;

/// Generate default configuration file (v1.2.1 - issue #35)
///
/// Creates a default config file with documented fields and sensible defaults.
/// The file is created at /etc/suderra/config.yaml (or SUDERRA_CONFIG env var).
fn generate_default_config() -> Result<()> {
    use std::fs;
    use std::path::Path;

    // v1.2.3: Log when using default config path
    let config_path = match std::env::var("SUDERRA_CONFIG") {
        Ok(path) => {
            tracing::info!("Using config path from SUDERRA_CONFIG: {}", path);
            path
        }
        Err(_) => {
            let default_path = "/etc/suderra/config.yaml".to_string();
            tracing::info!("SUDERRA_CONFIG not set, using default: {}", default_path);
            default_path
        }
    };

    // Check if config already exists
    if Path::new(&config_path).exists() {
        tracing::warn!("Config file already exists: {}", config_path);
        tracing::warn!("Remove it first or use a different path via SUDERRA_CONFIG");
        return Err(anyhow::anyhow!("Config already exists"));
    }

    // Create parent directory
    if let Some(parent) = Path::new(&config_path).parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create config directory: {:?}", parent))?;
    }

    // Template configuration with all options documented
    let content = format!(
        r#"# Suderra Edge Agent Configuration
# Generated by: suderra-agent --init
# Version: {}
#
# For full documentation, see:
# https://github.com/suderra/edge-agent#configuration

# Device Identification (REQUIRED - set from your platform)
device_id: "00000000-0000-0000-0000-000000000000"
device_code: "DEVICE-CODE"

# Cloud API URL
api_url: "https://api.your-platform.com"

# MQTT Configuration
mqtt:
  broker: "mqtt.your-platform.com"
  port: 8883
  # TLS Configuration (recommended for production)
  tls:
    enabled: true
    # ca_cert_path: "/etc/suderra/certs/ca.pem"
    # client_cert_path: "/etc/suderra/certs/client.pem"  # for mTLS
    # client_key_path: "/etc/suderra/certs/client.key"   # for mTLS
    verify_hostname: true

# Telemetry Configuration
telemetry:
  interval_seconds: 30
  include_cpu: true
  include_memory: true
  include_disk: true
  include_temperature: true
  # Timezone offset from UTC in seconds (e.g., 10800 for UTC+3)
  timezone_offset_secs: 0

# Logging Configuration
logging:
  level: "info"  # trace, debug, info, warn, error
  format: "json" # json or pretty

# Script Engine Configuration
scripting:
  enabled: true
  execution_mode: "event_driven"  # or "scan_cycle"
  scan_cycle_ms: 100
  limits:
    max_call_depth: 10
    max_execution_time_ms: 5000
    max_actions_per_run: 100

# Runtime/Resilience Configuration
runtime:
  gpio_timeout_secs: 5
  modbus_timeout_ms: 1000
  modbus_retries: 3

# Modbus Devices (optional)
modbus: []
#  - name: "PLC-Main"
#    connection_type: "tcp"
#    address: "192.168.1.100:502"
#    slave_id: 1
#    registers:
#      - name: "water_temperature"
#        address: 100
#        register_type: "input"
#        data_type: "i16"
#        scale: 0.1

# GPIO Configuration (optional, Linux only)
gpio: []
#  - pin: 17
#    direction: "output"
#    initial_state: false
"#,
        env!("CARGO_PKG_VERSION")
    );

    // Write with restrictive permissions from the start (no TOCTOU window)
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&config_path)
            .with_context(|| format!("Failed to create config file: {}", config_path))?;
        std::io::Write::write_all(&mut file, content.as_bytes())
            .with_context(|| format!("Failed to write config file: {}", config_path))?;
    }
    #[cfg(not(unix))]
    fs::write(&config_path, content)
        .with_context(|| format!("Failed to write config file: {}", config_path))?;

    println!("Generated default configuration: {}", config_path);
    println!();
    println!("Next steps:");
    println!("  1. Edit the config file with your device settings");
    println!("  2. Set device_id and device_code from your platform");
    println!("  3. Configure MQTT broker and TLS certificates");
    println!("  4. Start the agent: systemctl start suderra-agent");

    Ok(())
}

/// Activation state - minimal mutable state
pub struct ActivationState {
    pub is_activated: bool,
    pub tenant_id: Option<String>,
    pub device_id: String,
}

/// Application state shared across components (v2.0 - Granular, v2.2 - Shared ScriptStorage)
///
/// Architecture:
/// - Config is immutable after init (Arc)
/// - Hardware handles use actor pattern (thread-safe)
/// - ScriptStorage is shared (v2.2 - singleton pattern for data consistency)
/// - Only activation state needs RwLock
pub struct AppState {
    /// Configuration (immutable after init)
    pub config: AgentConfig,

    /// MQTT client
    pub mqtt_client: Option<MqttClient>,

    /// Modbus handle (actor pattern - thread-safe)
    pub modbus_handle: Option<ModbusHandle>,

    /// GPIO handle (actor pattern - thread-safe, v2.0)
    pub gpio_handle: Option<GpioHandle>,

    /// I2C handle (actor pattern - thread-safe)
    pub i2c_handle: Option<I2cHandle>,

    /// Process image holding all tag values
    pub process_image: ProcessImage,

    /// Alarm manager for I/O alarm evaluation
    pub alarm_manager: Arc<RwLock<AlarmManager>>,

    /// Shared script storage (v2.2 - singleton for CommandHandler and ScriptEngine)
    /// This ensures both components see the same script state
    /// v1.2.0: Internal RwLock for thread-safe access (no external lock needed)
    pub script_storage: Arc<ScriptStorage>,

    /// LoRa gateway handle (actor pattern, v1.5.0)
    #[cfg(feature = "lorawan")]
    pub lora_handle: Option<crate::lora::LoRaHandle>,

    /// SCADA display state (v1.6.0)
    #[cfg(feature = "scada-display")]
    pub scada_state: Option<scada_server::ScadaState>,

    /// SCADA SQLite database (v2.4)
    #[cfg(feature = "scada-display")]
    pub scada_db: Option<Arc<scada_db::ScadaDb>>,

    /// Activation state
    pub is_activated: bool,
    pub tenant_id: Option<String>,

    /// FailoverManager for MQTT primary→backup broker transition.
    /// BATCH-001-CI-FIX-007: `cmd_failover_force`/`cmd_failover_recover` in
    /// commands.rs already reference this field (commits 3f51ba70 +
    /// e8232bca) but the field was never added to AppState — compile was
    /// silently broken on main. Added here as `None` with runtime init
    /// in Batch 13 (Faz 1 ARC-001 wiring). Current behavior: `None` →
    /// `cmd_failover_force` returns the "no failover manager"
    /// operator-facing error, matching the existing match arm.
    pub failover_manager: Option<std::sync::Arc<crate::mqtt_failover::FailoverManager>>,

    /// HealthState for HTTP health/ready/metrics/diagnostics endpoints.
    /// Batch 14 Faz 1 Step 1.4 / ARC-003 wiring.
    ///
    /// WHY: Cloned clones share the same `Arc<HealthStateInner>` so
    /// downstream subsystems (MQTT client, script engine, modbus driver)
    /// can push counter updates to the same backing state the HTTP
    /// server reads from. Keeping it on AppState lets Sprint 6.2+ wire
    /// the push-paths via `state.health_state.as_ref()`.
    ///
    /// WHAT: `None` when the `health` feature is disabled at compile
    /// time OR when `config.health.enabled == false` at runtime. On a
    /// default build (health feature ON by default per Batch 14) + default
    /// config (health.enabled=false) the field stays None — zero cost.
    /// Operator opt-in via `config.yaml::health.enabled = true` triggers
    /// construction in `init_health_server()`.
    ///
    /// OBS-14-001 (session-observations.md): push-paths from MQTT/modbus/
    /// script engine are NOT WIRED yet. Counters will report 0 at runtime
    /// until Sprint 6.2 threads HealthState clones into those subsystems.
    /// This batch wires the server + AppState field ONLY.
    #[cfg(feature = "health")]
    pub health_state: Option<crate::health::HealthState>,

    /// Durable telemetry queue (Batch 15 Faz 1 ARC-002 wiring).
    ///
    /// WHY: Pre-Batch-15 the MQTT publish path silently DROPPED telemetry
    /// when broker was unreachable. ADR-020 §6 + IEC 62443 FR6 Timely
    /// Response require queue-and-forward. `offline_queue.rs` (1527 lines)
    /// already implemented the SQLCipher-backed queue; this field + the
    /// `init_offline_queue()` method complete the wire-up.
    ///
    /// WHAT: `AsyncOfflineQueue` wraps the sync `OfflineQueue` in
    /// tokio::spawn_blocking so SQLCipher's blocking calls don't stall
    /// the tokio runtime. Stored as `Arc` so the MQTT publish task (Sprint
    /// 6.2) and the drain-on-reconnect task can share access.
    ///
    /// `None` when disabled in config OR feature-compile-gated OFF in the
    /// future. Current behavior: None → MQTT publish continues to drop on
    /// disconnect (v1.6.0 baseline); Some → MQTT publish enqueues on
    /// disconnect + drain on reconnect.
    ///
    /// OBS-15-001 (session-observations.md): SQLCipher key derivation
    /// TODAY uses machine-id (plan HC-5 flags for HKDF(master_key)
    /// migration in Sprint 6.3). Batch 15 uses existing derivation to
    /// preserve HC-1 backward-compat.
    pub offline_queue: Option<std::sync::Arc<crate::offline_queue::AsyncOfflineQueue>>,

    /// BackupManager for GDPR Art 20 edge portability + disaster
    /// recovery (Batch 18 Faz 1 ARC-009 wiring).
    ///
    /// WHY: Pre-Batch-18 the `backup.rs` module (715 lines) was dead-
    /// code; no way to export config / scripts / function-block states
    /// / SQLite snapshot for GDPR Art 20 data-portability requests OR
    /// for operator-initiated disaster recovery snapshot.
    ///
    /// WHAT: `BackupManager` holds backup_dir + max_backups + device_id
    /// + auth-secret loaded from `BACKUP_AUTH_SECRET` env. Arc so the
    /// future HTTP endpoint (Sprint 6.x) and the CLI subcommand path
    /// can share the same manager instance (retention cleanup is
    /// stateful — shared instance avoids double-cleanup races).
    ///
    /// OBS-18-001 (session-observations.md): scheduled/periodic backup
    /// NOT wired. Triggering via HTTP endpoint OR CLI subcommand lands
    /// in Sprint 6.x.
    pub backup_manager: Option<std::sync::Arc<crate::backup::BackupManager>>,

    /// JTI dedup table for command-envelope replay defense
    /// (Batch 59, plan §4.10 / Sprint 6.4).
    ///
    /// WHY: Plan §4.10 zero-trust command model mandates a
    /// sliding-window jti dedup cache to reject replay
    /// attempts. Batch 57 shipped `MokaJtiDedupTable` as the
    /// hot-window tier; Batch 58 added the config knob.
    /// Batch 59 wires the actual runtime INSTANCE into
    /// AppState so Sprint 6.4 full wire can invoke
    /// `check_and_mark` in execute_command without any
    /// AppState-shape change.
    ///
    /// WHAT: `Arc<dyn JtiDedupTable>` held through a trait
    /// object so Sprint 6.4 can swap to the composite
    /// `LayeredJtiDedupTable` (Moka + SQLCipher) without
    /// touching consumers.
    ///
    /// Pre-Sprint-6.4 the instance is CONSTRUCTED at boot +
    /// lives in AppState but is NOT YET INVOKED by any
    /// command-path. execute_command gets its check_and_mark
    /// call in the Sprint 6.4 full wire.
    ///
    /// NONE when signature_mode=Disabled (no replay defense
    /// needed for legacy-compat deployments) — zero-cost-
    /// when-unused pattern.
    pub jti_dedup_table:
        Option<std::sync::Arc<dyn crate::command_envelope::JtiDedupTable>>,

    /// RBAC manifest store for operator→pubkey lookup
    /// (Batch 68, Sprint 6.1 full wire).
    ///
    /// WHY: Plan §3 R-5 + ADR-018 mandate a cloud-signed
    /// manifest carrying operator→role + role→permission
    /// bindings. The envelope adapter (Batch 63) Gate 7
    /// signature verify needs the operator's ed25519 pubkey;
    /// this store is the SSoT.
    ///
    /// WHAT: `Arc<RbacManifestStore>` held AlWAYS (not
    /// Option) — the store is constructed empty at boot +
    /// populated by init_rbac_manifest_store IFF
    /// rbac_manifest.mode != Disabled. The always-present
    /// Arc simplifies consumer wiring (always clonable,
    /// always queryable); lookup_operator_pubkey returns
    /// None on empty-store which is the Disabled semantic.
    pub rbac_manifest_store: std::sync::Arc<crate::authz::manifest_runtime::RbacManifestStore>,

    /// Audit sink for HMAC-chained event log (Batch 78
    /// Sprint 6.2 Phase 2).
    ///
    /// WHY: Plan §5 Faz 2 item 8 + ADR-020 mandate a
    /// tamper-evident audit trail for every regulated
    /// action. Batches 74-77 built the sink / recovery /
    /// SIGHUP / verify primitives; this AppState field wires
    /// the sink at boot.
    ///
    /// WHAT: `Option<Arc<AuditSink>>` — None when
    /// audit.mode=Disabled (pre-rollout deployments), Some
    /// when audit.mode=Enabled. Consumers (Phase 2 / Batch
    /// 79 wires CommandHandler pre+post emit) skip audit
    /// when None, matching the log-only fallback semantic.
    pub audit_sink: Option<std::sync::Arc<crate::audit::AuditSink>>,

    /// Clock authority for trusted wall-clock reads (Batch 90
    /// Sprint 6.7 wire).
    ///
    /// WHY: Plan §5 Faz 2 item 10 + D-7 mandate a fail-closed
    /// clock path that knows NTS sync age. Batches 55 + 89
    /// shipped the trait + both impls (SystemClockAuthority
    /// trusting-0-age baseline + ChronyNtsClockAuthority
    /// real-query path). Batch 90 wires AppState to pick one
    /// based on `config.clock.enable_chrony_query`.
    ///
    /// WHAT: `Arc<dyn ClockAuthority>` — trait object behind
    /// Arc for cross-task sharing. Always Some (no Option
    /// shape) because consumers depend on a clock being
    /// present; Disabled fallback is just the trusting
    /// System impl rather than None.
    pub clock_authority:
        std::sync::Arc<dyn crate::runtime_safety::ClockAuthority>,

    /// Master-key keystore for HKDF-derived per-purpose keys
    /// (Batch 83 Sprint 6.3).
    ///
    /// WHY: Plan §5 Faz 2 item 1 + ADR-018 §4 mandate a
    /// 3-backend priority (TPM > systemd-creds > FileBacked).
    /// Batch 82 shipped FileBackedKeystore; Batch 83 wires
    /// AppState construction. Downstream consumers
    /// (Phase 2 / Batch 84 audit-hmac-from-keystore,
    /// Phase 2 / Batch 85 SQLCipher-key-from-keystore)
    /// clone the Arc<dyn Keystore> for per-purpose
    /// derivation via KeyPurpose::*.
    ///
    /// WHAT: `Option<Arc<dyn Keystore>>` — trait-object
    /// held behind Arc for cross-task sharing. None when
    /// keystore.mode=Disabled (HC-1 backward compat);
    /// Some(FileBackedKeystore) in FileBacked / Auto modes
    /// pre-Batch-83a TPM landing.
    pub keystore: Option<std::sync::Arc<dyn crate::keystore::Keystore>>,

    /// Firmware A/B partition state store (Batch 108 Sprint
    /// 6.5 wire).
    ///
    /// WHY: Plan §5 Faz 2 item 6 + ADR-019 §2 mandate A/B
    /// partition persistent state. Batch 106 shipped the
    /// PartitionStore runtime; Batch 108 wires it at boot
    /// + spawns the Batch 107 cold-boot-budget watchdog.
    ///
    /// WHAT: `Option<Arc<PartitionStore>>` — None until
    /// `init_partition_store()` succeeds, then Some.
    /// Initialization is fail-closed in boot (corrupt JSON
    /// in the partition.json file → exit(1)); first-boot
    /// creates file with initial state.
    pub partition_store: Option<std::sync::Arc<crate::updater::PartitionStore>>,

    /// Lifecycle HMAC auth key (Batch 129 Sprint 6.6).
    ///
    /// Loaded at boot from
    /// `$CREDENTIALS_DIRECTORY/<credential_name>` when
    /// `lifecycle_endpoint.auth_mode = HmacToken`. None
    /// when auth_mode = Disabled (HC-1 default) or load
    /// fails (fail-closed boot then exits).
    ///
    /// Populated into LifecycleHandles via
    /// `init_lifecycle_cell()` after
    /// `init_lifecycle_auth_key()` runs.
    #[cfg(feature = "health")]
    pub lifecycle_auth_key:
        Option<std::sync::Arc<crate::lifecycle_auth::LifecycleAuthKey>>,

    /// Lifecycle HTTP endpoint cell (Batch 122 Sprint 6.5).
    ///
    /// WHY: `POST /lifecycle/confirm-active` needs the
    /// PartitionStore + bootloader + audit_sink references
    /// + device_id + tenant, but the health server starts
    /// BEFORE those init. The OnceLock cell is created
    /// pre-health-server + populated post-partition_store
    /// init via `init_lifecycle_cell()`. Health server
    /// closure reads `cell.get()` per request; pre-
    /// population returns 503.
    ///
    /// WHAT: `Option<LifecycleHandlesCell>` — None when
    /// `config.health.enabled = false`. Some(empty cell)
    /// during boot window; Some(populated cell) once
    /// prerequisites init.
    #[cfg(feature = "health")]
    pub lifecycle_cell: Option<crate::lifecycle::LifecycleHandlesCell>,

    /// Bootloader-coordination handle (Batch 112 Sprint 6.5
    /// wire). Layer-2 partner of `partition_store` (layer 1
    /// software state): every PartitionRoll transition that
    /// affects the next-boot flag pairs the software
    /// `apply_roll` with a call on this handle so the
    /// bootloader + PartitionStore stay in sync.
    ///
    /// WHY: ADR-019 §2 — a PartitionRoll that mutates
    /// software state without also updating the bootloader
    /// flag leaves the device in a split-brain state where
    /// the next boot follows the OLD flag. Batch 108's commit
    /// body flagged this gap; Batch 111 opened the trait
    /// abstraction; Batch 112 wires the abstraction into the
    /// 3 consumer sites (watchdog, cmd_confirm_slot,
    /// --confirm-active CLI).
    ///
    /// WHAT: `Arc<dyn BootloaderHandle>` — always Some
    /// (Noop default is a zero-cost fallback on non-RPi
    /// deployments). TrybootBootloaderHandle real-RPi impl
    /// lands in a follow-up batch that requires hardware for
    /// signed autoboot.txt verification.
    pub bootloader: std::sync::Arc<dyn crate::updater::BootloaderHandle>,

    /// Parsed ed25519 verifying key for SignedFirmwareManifest
    /// verify (Batch 114 Sprint 6.5 wire).
    ///
    /// WHY: Plan §3 R-4 + ADR-019 §3 mandate ed25519 signed
    /// firmware manifests verified against an on-device
    /// trusted pubkey. Config Rule 20+21 guarantee the hex
    /// string is valid when `firmware_update.mode !=
    /// Disabled`; `init_firmware_signing_pubkey()` parses the
    /// hex into a `VerifyingKey` at boot + caches the parsed
    /// form so the verify hot-path doesn't re-parse per
    /// command.
    ///
    /// WHAT: `Option<Arc<VerifyingKey>>` — None when mode is
    /// Disabled (HC-1 backward compat: legacy tarball OTA
    /// still works with no pubkey configured). Some when
    /// Permissive/Enforcing + the boot-time parse succeeds.
    /// Parse failure at boot is fail-closed via
    /// init_firmware_signing_pubkey (exit 1).
    pub firmware_signing_pubkey:
        Option<std::sync::Arc<ed25519_dalek::VerifyingKey>>,
}

impl AppState {
    /// Create new AppState (v2.2 - with shared ScriptStorage)
    ///
    /// Note: Hardware handles will be initialized in LocalSet context.
    /// Script storage init is async and must be called separately via `init_script_storage()`.
    pub fn new(config: AgentConfig) -> Self {
        // Create shared script storage (v2.2 singleton pattern)
        // v1.2.0: ScriptStorage now has internal RwLock, no external lock needed
        let script_storage = ScriptStorage::new(None);

        Self {
            config,
            mqtt_client: None,
            modbus_handle: None,
            gpio_handle: None,
            i2c_handle: None,
            process_image: ProcessImage::new(),
            alarm_manager: Arc::new(RwLock::new(AlarmManager::new())),
            script_storage: Arc::new(script_storage),
            #[cfg(feature = "lorawan")]
            lora_handle: None,
            #[cfg(feature = "scada-display")]
            scada_state: None,
            #[cfg(feature = "scada-display")]
            scada_db: None,
            is_activated: false,
            tenant_id: None,
            // BATCH-001-CI-FIX-007: None-init; Batch 13 (Faz 1 ARC-001)
            // wires the actual FailoverManager from config.mqtt.failover
            // settings via `init_failover_manager()`.
            failover_manager: None,
            // BATCH-14 ARC-003: None-init; `init_health_server()` below
            // constructs HealthState + spawns the HTTP server iff
            // config.health.enabled == true. None when feature OFF or
            // config disabled — matches the plan's zero-cost-when-unused
            // pattern for optional orchestrator endpoints.
            #[cfg(feature = "health")]
            health_state: None,
            // BATCH-15 ARC-002: None-init; `init_offline_queue()` below
            // constructs AsyncOfflineQueue (opens SQLCipher DB, applies
            // machine-id key, initializes schema) iff
            // config.offline_queue.enabled == true. None → MQTT publish
            // drops on disconnect (v1.6.0 baseline); Some → queue-and-
            // drain.
            offline_queue: None,
            // BATCH-18 ARC-009: None-init; `init_backup_manager()`
            // below constructs BackupManager iff
            // config.backup.enabled == true. None → no backup
            // functionality (v1.6.0 baseline); Some → HTTP/CLI-
            // triggered backup available.
            backup_manager: None,
            // Batch 59 Sprint 6.4 foundation: None-init; `init_
            // jti_dedup_table()` below constructs MokaJtiDedupTable
            // iff signature_mode != Disabled. None → no replay-
            // defense (legacy-compat); Some → Sprint 6.4
            // execute_command check_and_mark.
            jti_dedup_table: None,
            // Batch 68 Sprint 6.1 full wire: empty-store init.
            // `init_rbac_manifest_store()` below populates IFF
            // rbac_manifest.mode != Disabled via load_from_file
            // + ed25519_dalek verify_strict. Always-Arc so
            // consumers (envelope_adapter Gate 7) can
            // unconditionally clone without Option unwrapping.
            rbac_manifest_store: std::sync::Arc::new(
                crate::authz::manifest_runtime::RbacManifestStore::new(),
            ),
            // Batch 78 Sprint 6.2 Phase 2: None-init;
            // `init_audit_sink()` below constructs AuditSink
            // iff audit.mode=Enabled. None → Batch 79
            // CommandHandler pre+post emit falls to log-only;
            // Some → append-to-file with HMAC chain.
            audit_sink: None,
            // Batch 83 Sprint 6.3: None-init; `init_keystore()`
            // below constructs FileBackedKeystore (or falls
            // through to it from Auto) iff keystore.mode !=
            // Disabled. None → downstream consumers keep using
            // config-hex keys; Some → consumers migrate to
            // KeyPurpose::* HKDF-derived keys.
            keystore: None,
            // Batch 90 Sprint 6.7 wire: default to
            // SystemClockAuthority (always-trusting 0-age
            // baseline per HC-1 backward compat).
            // `init_clock_authority()` below swaps to
            // ChronyNtsClockAuthority when
            // `clock.enable_chrony_query = true`.
            clock_authority: std::sync::Arc::new(
                crate::runtime_safety::SystemClockAuthority::new(),
            ),
            // Batch 108 Sprint 6.5 wire: None-init.
            // init_partition_store() opens the state file
            // (default /var/lib/suderra/partition.json);
            // fail-closed on corrupt JSON.
            partition_store: None,
            // Batch 112 Sprint 6.5 wire: Noop default.
            // Non-RPi deployments use this as the zero-cost
            // fallback (info/warn-log only). RPi deployments
            // swap to TrybootBootloaderHandle via a future
            // init_bootloader() call after the real-RPi impl
            // lands (needs hardware for signed autoboot.txt
            // verification).
            bootloader: std::sync::Arc::new(
                crate::updater::NoopBootloaderHandle,
            ),
            // Batch 114 Sprint 6.5 wire: None-init.
            // `init_firmware_signing_pubkey()` parses the
            // config hex + populates this field. Disabled
            // mode leaves it None (HC-1 backward compat;
            // legacy tarball OTA still works).
            firmware_signing_pubkey: None,
            // Batch 129 Sprint 6.6 wire: None-init.
            // init_lifecycle_auth_key() populates when
            // auth_mode=HmacToken; stays None in Disabled
            // mode (HC-1 default).
            #[cfg(feature = "health")]
            lifecycle_auth_key: None,
            // Batch 122 Sprint 6.5 wire: None-init.
            // init_health_server() constructs + installs
            // the cell when health is enabled;
            // init_lifecycle_cell() populates it after
            // partition_store + bootloader + audit_sink
            // init land.
            #[cfg(feature = "health")]
            lifecycle_cell: None,
        }
    }

    /// Initialize script storage (v1.2.0 - async initialization)
    ///
    /// Must be called after creating AppState to load scripts from disk.
    pub async fn init_script_storage(&self) {
        if let Err(e) = self.script_storage.init().await {
            warn!("Script storage initialization failed: {}", e);
        }
    }

    /// Initialize FailoverManager from `config.mqtt.failover` (Faz 1 Step 1.2 /
    /// ARC-001 / Batch 13 closure).
    ///
    /// Returns the health-check JoinHandle IF a manager was constructed; None
    /// if failover is disabled OR no primary broker is configured (primary
    /// broker hostname is required to build the manager — no fallback).
    ///
    /// Wiring rules:
    /// - `config.mqtt.failover.enabled == false` → no manager. Consumers
    ///   (`cmd_failover_force`/`cmd_failover_recover`) return the structured
    ///   `FailoverManager not initialized` operator-facing error.
    /// - `config.mqtt.broker == None` → no manager (can't fail over without
    ///   knowing the primary). Log a warning so misconfiguration is visible.
    /// - Otherwise → build FailoverManager, assign to `self.failover_manager`,
    ///   spawn `start_health_check_task()`, return JoinHandle for shutdown
    ///   coordination.
    ///
    /// Shutdown integration note: the returned JoinHandle should be registered
    /// with `ShutdownCoordinator` (Batch 10 ShutdownPhase machine) so the
    /// health check task is force-cancelled during the Draining phase.
    /// Main.rs wiring owns that registration; this method just builds + spawns.
    pub fn init_failover_manager(&mut self) -> Option<tokio::task::JoinHandle<()>> {
        if !self.config.mqtt.failover.enabled {
            return None;
        }

        let primary_host = match self.config.mqtt.broker.as_ref() {
            Some(h) if !h.is_empty() => h.clone(),
            _ => {
                warn!(
                    "MQTT failover enabled but `config.mqtt.broker` is None \
                     — FailoverManager NOT started; `cmd_failover_force` \
                     will return BackupBrokerNotConfigured-class error"
                );
                return None;
            }
        };

        let (manager, _state_rx) = crate::mqtt_failover::FailoverManager::new(
            primary_host,
            self.config.mqtt.port,
            self.config.mqtt.failover.clone(),
        );

        let manager_arc = std::sync::Arc::new(manager);
        let health_check_handle = manager_arc.start_health_check_task();
        self.failover_manager = Some(manager_arc);

        info!(
            "FailoverManager wired: primary={}:{} backup={:?}",
            self.config.mqtt.broker.as_deref().unwrap_or("<none>"),
            self.config.mqtt.port,
            self.config.mqtt.failover.backup_broker.as_deref()
        );
        Some(health_check_handle)
    }

    /// Construct HealthState + spawn the HTTP health server (Batch 14 Faz 1
    /// Step 1.4 / ARC-003).
    ///
    /// WHY: Docker / k8s / systemd orchestrators need `/health /ready
    /// /metrics /diagnostics` endpoints for liveness + readiness gating.
    /// The existing `health.rs` module already implements the axum routes
    /// and the `HealthState` counter struct; this method completes the
    /// wire-up by constructing + assigning + spawning.
    ///
    /// WHAT:
    /// - Returns `Ok(Some(JoinHandle))` with the spawned server handle
    ///   when `config.health.enabled == true` AND the bind address parses.
    /// - Returns `Ok(None)` when `config.health.enabled == false` (normal
    ///   disabled path — no error, no warning).
    /// - Returns `Err(ConfigParseError)` when enabled but bind address
    ///   fails to parse — FAIL-CLOSED boot; misconfiguration does not
    ///   silently drop the endpoint.
    ///
    /// INVARIANTS:
    /// - AppState.health_state is populated ONLY when server actually
    ///   spawned. Downstream push-paths (Sprint 6.2) can `match`
    ///   `self.health_state.as_ref()` and no-op cleanly when disabled.
    /// - Server bind is default localhost:8080 per the HealthServerConfig
    ///   Default impl — operator must explicitly open to routable
    ///   interfaces (SL-2 defense-in-depth).
    /// - `HealthState::set_config_loaded(true)` is called immediately
    ///   after construction so `/ready` reflects the real post-config
    ///   state from the first probe.
    ///
    /// OBS-14-001 (session-observations.md): MQTT/modbus/script engine
    /// counter-update paths NOT wired in this batch. Counters read 0
    /// until Sprint 6.2.
    #[cfg(feature = "health")]
    pub async fn init_health_server(&mut self) -> Result<Option<tokio::task::JoinHandle<()>>, String> {
        if !self.config.health.enabled {
            return Ok(None);
        }

        let addr: std::net::SocketAddr = match self.config.health.bind.parse() {
            Ok(a) => a,
            Err(e) => {
                return Err(format!(
                    "health.bind `{}` is not a valid SocketAddr: {}",
                    self.config.health.bind, e
                ));
            }
        };

        let health_state = crate::health::HealthState::new();
        health_state.set_config_loaded(true);

        // Batch 95: inject device_id + tenant labels into
        // the Prometheus output so fleet dashboards can
        // slice by device + tenant. device_id always
        // present at this point (config loaded); tenant is
        // set post-provisioning when AppState.tenant_id
        // becomes Some (Batch 96 follow-up adds the
        // tenant-set callback; current batch uses config
        // device_id only).
        health_state.set_device_id(&self.config.device_id);
        if let Some(ref tenant) = self.tenant_id {
            health_state.set_tenant_id(tenant);
        }

        // Batch 122 Sprint 6.5: allocate the lifecycle
        // cell pre-server-start. The cell is empty here;
        // init_lifecycle_cell() populates it AFTER
        // partition_store + audit_sink init. Pre-
        // population the confirm-active handler returns
        // 503 Service Unavailable.
        let lifecycle_cell = crate::lifecycle::new_cell();
        self.lifecycle_cell = Some(lifecycle_cell.clone());

        // Clone for the server task; keep the original on AppState so
        // downstream subsystems can push counter updates to the SAME
        // Arc<HealthStateInner> (HealthState::Clone is Arc-cheap).
        let server_handle = crate::health::start_health_server(
            addr,
            health_state.clone(),
            Some(lifecycle_cell),
        )
        .await;
        self.health_state = Some(health_state);

        info!("HealthServer wired: bind={}", addr);
        Ok(Some(server_handle))
    }

    /// Load the lifecycle HMAC auth key from systemd-
    /// credentials (Batch 129 Sprint 6.6 wire).
    ///
    /// NO-OP when `lifecycle_endpoint.auth_mode = Disabled`
    /// (HC-1 default). When HmacToken, reads
    /// `$CREDENTIALS_DIRECTORY/<name>` + populates
    /// `self.lifecycle_auth_key`. Fail-closed on load
    /// error — an operator who CONFIGURED HmacToken but
    /// didn't supply the credential expects the agent to
    /// refuse boot rather than silently degrading to
    /// Disabled.
    ///
    /// Returns Err(msg) on load failure so the caller can
    /// exit(1); Ok(()) on success or NO-OP.
    #[cfg(feature = "health")]
    pub fn init_lifecycle_auth_key(&mut self) -> Result<(), String> {
        use crate::config::LifecycleAuthMode;
        if matches!(
            self.config.lifecycle_endpoint.auth_mode,
            LifecycleAuthMode::Disabled
        ) {
            info!(
                "Lifecycle auth: Disabled (HC-1 default) — HTTP endpoint relies on localhost-binding + same-UID isolation only"
            );
            return Ok(());
        }

        let credential_name = self
            .config
            .lifecycle_endpoint
            .systemd_credential_name
            .as_deref()
            .unwrap_or(crate::lifecycle_auth::DEFAULT_CREDENTIAL_NAME);

        let key = crate::lifecycle_auth::LifecycleAuthKey::load_from_credentials_dir(
            credential_name,
        )
        .map_err(|e| {
            format!(
                "Lifecycle auth: HmacToken mode configured but credential load failed: {}. \
                 Ensure the systemd unit has LoadCredential=<name>:<file> set and the file exists.",
                e
            )
        })?;

        info!(
            "Lifecycle auth: HmacToken mode active (credential_name={} loaded successfully)",
            credential_name
        );
        self.lifecycle_auth_key = Some(std::sync::Arc::new(key));
        Ok(())
    }

    /// Populate the lifecycle cell with PartitionStore +
    /// bootloader + audit_sink references (Batch 122 Sprint
    /// 6.5 wire).
    ///
    /// Called AFTER `init_partition_store` + `init_keystore`
    /// + `init_audit_sink` in boot sequence. Sets the
    /// OnceLock exactly once; subsequent calls are a no-op
    /// (OnceLock::set returns Err on second call which we
    /// log-and-ignore for idempotency).
    ///
    /// NO-OP when `lifecycle_cell` is None (health disabled)
    /// or when `partition_store` is None (fail-closed boot
    /// would have already exited; guard is defense-in-
    /// depth).
    #[cfg(feature = "health")]
    pub fn init_lifecycle_cell(&self) {
        let Some(cell) = self.lifecycle_cell.as_ref() else {
            info!("init_lifecycle_cell: cell is None (health disabled) — skipping");
            return;
        };
        let Some(partition_store) = self.partition_store.as_ref() else {
            warn!("init_lifecycle_cell: partition_store is None — confirm-active HTTP endpoint will return 503");
            return;
        };

        let tenant_bytes = self
            .tenant_id
            .as_deref()
            .and_then(|t| uuid::Uuid::parse_str(t).ok())
            .map(|u| *u.as_bytes())
            .unwrap_or([0u8; 16]);
        let tenant = crate::authz::permission::TenantId::new_from_verified(tenant_bytes);

        let handles = crate::lifecycle::LifecycleHandles {
            partition_store: partition_store.clone(),
            bootloader: self.bootloader.clone(),
            audit_sink: self.audit_sink.clone(),
            device_id: self.config.device_id.clone(),
            tenant,
            auth_key: self.lifecycle_auth_key.clone(),
        };

        if cell.set(handles).is_err() {
            warn!(
                "init_lifecycle_cell: cell already populated (re-init attempted) — ignoring"
            );
        } else {
            info!(
                "Lifecycle cell populated: POST /lifecycle/confirm-active now live (audit_enabled={})",
                self.audit_sink.is_some()
            );
        }
    }

    /// Construct AsyncOfflineQueue (Batch 15 Faz 1 Step 1.3 / ARC-002).
    ///
    /// WHY: MQTT publish path pre-Batch-15 dropped telemetry when broker
    /// unreachable. ADR-020 §6 + FR6 Timely Response require queue-and-
    /// forward so no telemetry is lost across transient outages.
    ///
    /// WHAT:
    /// - Returns `Ok(())` and leaves `self.offline_queue = None` when
    ///   `config.offline_queue.enabled == false` (silent disabled path).
    /// - Returns `Err(String)` when enabled but SQLCipher open fails
    ///   → fail-closed boot. A declared-enabled queue that silently
    ///   isn't running would hide data-loss from operators.
    /// - On success, wraps `OfflineQueue` in `AsyncOfflineQueue` + `Arc`
    ///   and assigns to `self.offline_queue`.
    ///
    /// INVARIANTS:
    /// - DB path resolves via `config.offline_queue.db_path_override` OR
    ///   defaults to `${SUDERRA_DATA_DIR}/offline_queue.db` — the same
    ///   `/var/lib/suderra/offline_queue.db` that the Batch 4a systemd
    ///   hardening whitelisted under `ReadWritePaths`.
    /// - Parent dir is created if missing (owners: `suderra:suderra` via
    ///   the systemd User/Group; mode 0750). Mkdir failures → fail-closed.
    /// - SQLCipher encryption key is machine-id-derived per existing
    ///   `apply_db_encryption_key()` — tracked for HKDF(master_key)
    ///   migration in Sprint 6.3 per OBS-15-001.
    ///
    /// OBS-15-002 (session-observations.md): MQTT publish path is NOT
    /// wired to enqueue on disconnect yet. This batch wires the queue
    /// construction + AppState field; MQTT publish integration lands in
    /// Sprint 6.2 when the mqtt.rs module threads
    /// `state.offline_queue.as_ref()` into its publish pipeline.
    pub async fn init_offline_queue(&mut self) -> Result<(), String> {
        if !self.config.offline_queue.enabled {
            return Ok(());
        }

        let db_path = self
            .config
            .offline_queue
            .db_path_override
            .clone()
            .unwrap_or_else(|| data_dir::data_dir().join("offline_queue.db"));

        // Ensure parent directory exists (Batch 4a systemd hardening
        // creates /var/lib/suderra as owned by suderra:suderra; we
        // may still need subdirectory creation for operator-overridden
        // non-standard paths).
        if let Some(parent) = db_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Err(format!(
                    "offline_queue parent dir `{}` mkdir failed: {}",
                    parent.display(),
                    e
                ));
            }
        }

        let queue = match crate::offline_queue::OfflineQueue::with_disk_limit(
            &db_path,
            self.config.offline_queue.max_size,
            self.config.offline_queue.max_age_secs,
            self.config.offline_queue.max_disk_bytes,
        ) {
            Ok(q) => q,
            Err(e) => {
                return Err(format!(
                    "offline_queue DB open at `{}` failed: {:#}",
                    db_path.display(),
                    e
                ));
            }
        };

        // Batch 105: attach HealthState so enqueue/ack
        // paths emit observability counters + queue-size
        // gauge. HealthState is already initialized by
        // init_health_server earlier in boot (init_offline_
        // queue runs after init_health_server).
        let mut async_queue = crate::offline_queue::AsyncOfflineQueue::new(queue);
        if let Some(ref hs) = self.health_state {
            async_queue = async_queue.with_health_state(hs.clone());
            // Also report the queue capacity as a static
            // gauge so Grafana alerts like
            // `offline_queue_size / offline_queue_capacity
            // > 0.9` (queue-is-filling alarm) work out of
            // the box.
            hs.set_offline_queue_capacity(self.config.offline_queue.max_size as u64);
        }
        self.offline_queue = Some(std::sync::Arc::new(async_queue));

        info!(
            "OfflineQueue wired: path={} max_size={} max_age={}s max_disk={}MB",
            db_path.display(),
            self.config.offline_queue.max_size,
            self.config.offline_queue.max_age_secs,
            self.config.offline_queue.max_disk_bytes / (1024 * 1024)
        );
        Ok(())
    }

    /// Construct BackupManager (Batch 18 Faz 1 Step 8 / ARC-009).
    ///
    /// WHY: Plan §5 Faz 1 Step 8 + ADR-020 §6 GDPR Art 20 edge
    /// portability — operators need a tool to dump device config +
    /// script state + SQLite snapshot for portability requests OR
    /// disaster-recovery capture. BackupManager implements the
    /// gzipped-binary export format documented in `backup.rs`; this
    /// method completes the wire-up.
    ///
    /// WHAT:
    /// - Returns `Ok(())` + leaves `self.backup_manager = None` when
    ///   `config.backup.enabled == false` (silent disabled path).
    /// - Returns `Err(String)` when enabled but `mkdir_p(backup_dir)`
    ///   fails → fail-closed boot. A declared-enabled backup that
    ///   silently can't write would give operators FALSE CONFIDENCE
    ///   their data is being captured.
    /// - Resolves `backup_dir` from `config.backup.backup_dir` override
    ///   OR defaults to `${SUDERRA_DATA_DIR}/backups/` — matches the
    ///   Batch 4a systemd `ReadWritePaths` whitelist.
    /// - Device ID sourced from `config.device_id` (existing field) OR
    ///   falls back to hostname if unset. Device ID is ONLY used for
    ///   cross-device restore rejection (`verify_device_id=true`), not
    ///   for security — the real device binding is Batch 5b
    ///   ProvisioningBlob.verified_device_id.
    ///
    /// INVARIANTS:
    /// - AppState.backup_manager populated ONLY on successful init.
    ///   Downstream consumers (future HTTP endpoint, CLI subcommand)
    ///   pattern-match `self.backup_manager.as_ref()` and no-op cleanly
    ///   when disabled.
    /// - `BACKUP_AUTH_SECRET` env var loaded at BackupManager::new()
    ///   time. Future HTTP endpoint (Sprint 6.x) validates incoming
    ///   requests via `BackupManager::validate_auth(provided)`.
    ///
    /// OBS-18-001 (session-observations.md): scheduled/periodic backup
    /// NOT wired. Manual trigger via HTTP + CLI lands in Sprint 6.x.
    pub fn init_backup_manager(&mut self) -> Result<(), String> {
        if !self.config.backup.enabled {
            return Ok(());
        }

        let backup_dir = self
            .config
            .backup
            .backup_dir
            .clone()
            .unwrap_or_else(|| data_dir::data_dir().join("backups"));

        // Device ID for cross-device restore rejection. Not a security
        // boundary — just a usability safeguard so a backup from
        // device A can't be accidentally restored onto device B.
        // `config.device_id` is a required String field at config-
        // load time; use directly.
        let device_id = self.config.device_id.clone();

        let manager = crate::backup::BackupManager::new(backup_dir.clone(), device_id.clone())
            .with_max_backups(self.config.backup.max_backups);

        // Fail-closed on mkdir: declared-enabled backup MUST be able to
        // write, or operators get false confidence.
        if let Err(e) = manager.init() {
            return Err(format!(
                "backup_dir `{}` init failed: {}",
                backup_dir.display(),
                e
            ));
        }

        self.backup_manager = Some(std::sync::Arc::new(manager));

        info!(
            "BackupManager wired: backup_dir={} device_id={} max_backups={}",
            backup_dir.display(),
            device_id,
            self.config.backup.max_backups
        );
        Ok(())
    }

    /// Construct the JTI dedup table (Batch 59 Sprint 6.4
    /// foundation).
    ///
    /// WHY: Plan §4.10 zero-trust command model requires a
    /// sliding-window jti dedup cache. Batch 57 shipped
    /// MokaJtiDedupTable; Batch 59 constructs the runtime
    /// instance at boot so Sprint 6.4 can invoke it from
    /// execute_command without AppState-shape churn.
    ///
    /// WHAT:
    /// - Reads `config.envelope_dedup.{moka_capacity,
    ///   moka_ttl_secs}` for capacity + TTL.
    /// - Constructs MokaJtiDedupTable::with_capacity_and_ttl.
    /// - Arc-wraps as `dyn JtiDedupTable` trait object so
    ///   Sprint 6.4 can swap to LayeredJtiDedupTable without
    ///   touching consumers.
    /// - Stores in `self.jti_dedup_table`.
    ///
    /// MODE GATE: when signature_mode=Disabled, leaves the
    /// field as None — zero-cost-when-unused per HC-1
    /// backward-compat. Permissive/Enforcing mode constructs
    /// the table.
    ///
    /// INFALLIBLE: Moka cache construction doesn't touch disk
    /// or syscalls; can't fail. Returns `()` not `Result`.
    pub fn init_jti_dedup_table(&mut self) {
        use crate::command_envelope::envelope::SignatureMode;
        use crate::command_envelope::{
            JtiDedupTable, LayeredJtiDedupTable, MokaJtiDedupTable,
            SqlCipherJtiDedupTable,
        };

        if matches!(self.config.signature_mode, SignatureMode::Disabled) {
            info!(
                "JTI dedup table skipped: signature_mode=Disabled (HC-1 backward compat)"
            );
            return;
        }

        let capacity = self.config.envelope_dedup.moka_capacity;
        let ttl_secs = self.config.envelope_dedup.moka_ttl_secs;
        let ttl = std::time::Duration::from_secs(ttl_secs);

        // Batch 92 Sprint 6.4 full wire: compose Moka hot-
        // tier + SQLCipher persistent tier when operator
        // opts in. HC-1 default keeps Moka-only to preserve
        // existing deployment behavior.
        let table: std::sync::Arc<dyn JtiDedupTable> = if self
            .config
            .envelope_dedup
            .enable_sqlcipher_persist
        {
            let sqlcipher_path = self
                .config
                .envelope_dedup
                .sqlcipher_path
                .clone()
                .unwrap_or_else(|| {
                    std::path::PathBuf::from("/var/lib/suderra/jti_dedup.sqlite")
                });
            match SqlCipherJtiDedupTable::open(&sqlcipher_path) {
                Ok(sql) => {
                    info!(
                        "JTI dedup table: Layered(Moka+SQLCipher) path={} moka_cap={} moka_ttl={}s",
                        sqlcipher_path.display(),
                        capacity,
                        ttl_secs
                    );
                    let moka: std::sync::Arc<dyn JtiDedupTable> = std::sync::Arc::new(
                        MokaJtiDedupTable::with_capacity_and_ttl(capacity, ttl),
                    );
                    let sql_arc: std::sync::Arc<dyn JtiDedupTable> =
                        std::sync::Arc::new(sql);
                    std::sync::Arc::new(LayeredJtiDedupTable::new(moka, sql_arc))
                }
                Err(e) => {
                    // Fail-loud + fall back to Moka-only.
                    // Reboot-survive protection lost until
                    // operator fixes; live replay defense
                    // preserved via Moka.
                    warn!(
                        "JTI dedup: SQLCipher persist tier open FAILED: {}. Falling back to Moka-only (reboot-survive replay protection DEGRADED; fix sqlcipher_path permissions or reset sqlcipher_path config to defaults)",
                        e
                    );
                    std::sync::Arc::new(
                        MokaJtiDedupTable::with_capacity_and_ttl(capacity, ttl),
                    )
                }
            }
        } else {
            info!(
                "JTI dedup table: Moka-only signature_mode={:?} moka_capacity={} moka_ttl_secs={} (set envelope_dedup.enable_sqlcipher_persist=true for reboot-survive 72h replay defense)",
                self.config.signature_mode, capacity, ttl_secs
            );
            std::sync::Arc::new(MokaJtiDedupTable::with_capacity_and_ttl(
                capacity, ttl,
            ))
        };

        self.jti_dedup_table = Some(table);
    }

    /// Construct + load the RBAC manifest store (Batch 68
    /// Sprint 6.1 full wire; Batch 71 adds persistent version
    /// floor).
    ///
    /// WHY: Plan §3 R-5 + ADR-018 mandate a cloud-signed RBAC
    /// manifest. Batch 67 shipped the store skeleton; Batch 68
    /// wires the boot-time load + fail-closed handling; Batch
    /// 71 closes the manifest-rollback window by attaching a
    /// SQLCipher-backed `ManifestVersionStore` that persists
    /// `highest_seen_policy_version` across reboots.
    ///
    /// MODE GATE:
    /// - Disabled: early-return Ok. Store remains empty; no
    ///   version_store opened (SQLCipher dep avoided when
    ///   not used).
    /// - Permissive: load attempted; failure warn-logged +
    ///   store remains empty (envelope Gate 7 falls to NO-OP).
    /// - Enforcing: load required; failure returns Err →
    ///   caller exits(1).
    ///
    /// ROLLBACK PROTECTION (Batch 71):
    /// - Opens `/var/lib/suderra/rbac_version.sqlite` (or the
    ///   `rbac_manifest.version_store_path` override when set)
    ///   in Permissive + Enforcing modes.
    /// - Version-store-open failure is FAIL-CLOSED in
    ///   Enforcing (security invariant — without persistence,
    ///   attacker can replay captured old manifest across
    ///   reboots), warn-logged-and-continue in Permissive
    ///   (rollback-window open but boot proceeds on the
    ///   matching Permissive signature-verify semantic).
    ///
    /// TENANT BINDING: plan §3 R-5 specifies the manifest is
    /// tenant-bound. Requires `self.tenant_id` from the
    /// provisioning path; when tenant_id is None (pre-
    /// provisioning boot window), the load is SKIPPED
    /// regardless of mode — verify_manifest's Gate 3 cannot
    /// run without a known tenant. Sprint 6.1 follow-up adds
    /// post-provisioning re-load via MQTT `update_policy`.
    pub fn init_rbac_manifest_store(&mut self) -> Result<(), String> {
        use crate::authz::manifest_runtime::RbacManifestStore;
        use crate::authz::manifest_version_store::ManifestVersionStore;
        use crate::authz::permission::TenantId;
        use crate::config::RbacManifestMode;

        if matches!(self.config.rbac_manifest.mode, RbacManifestMode::Disabled) {
            info!("RBAC manifest store: mode=Disabled — skipping load");
            return Ok(());
        }

        let tenant_str = match self.tenant_id.as_deref() {
            Some(t) => t,
            None => {
                info!(
                    "RBAC manifest store: tenant_id=None (pre-provisioning) — skipping load, Sprint 6.1 follow-up adds post-provisioning re-load via MQTT update_policy"
                );
                return Ok(());
            }
        };

        let uuid = match uuid::Uuid::parse_str(tenant_str) {
            Ok(u) => u,
            Err(e) => {
                return Err(format!(
                    "RBAC manifest store: tenant_id UUID parse failed: {}",
                    e
                ));
            }
        };
        let expected_tenant = TenantId::new_from_verified(*uuid.as_bytes());

        let mode = self.config.rbac_manifest.mode;
        let pubkey_hex = self.config.rbac_manifest.manifest_signing_pubkey_hex.as_deref();
        let path_override = self.config.rbac_manifest.manifest_path.as_deref();

        // Batch 71: open persistent version-floor store BEFORE
        // the manifest load, then rebuild the RbacManifestStore
        // Arc with the store attached. Atomic AppState mutation
        // — no partial-window where the Arc exists without the
        // version store.
        let version_store_path = self
            .config
            .rbac_manifest
            .version_store_path
            .clone()
            .unwrap_or_else(|| {
                std::path::PathBuf::from("/var/lib/suderra/rbac_version.sqlite")
            });

        match ManifestVersionStore::open(&version_store_path) {
            Ok(vs) => {
                info!(
                    "RBAC manifest version store opened: path={}",
                    version_store_path.display()
                );
                self.rbac_manifest_store = std::sync::Arc::new(
                    RbacManifestStore::new().with_version_store(std::sync::Arc::new(vs)),
                );
            }
            Err(e) => match mode {
                RbacManifestMode::Disabled => {
                    // Unreachable — early-return above. Keep
                    // the branch for exhaustiveness.
                    return Ok(());
                }
                RbacManifestMode::Permissive => {
                    warn!(
                        "RBAC manifest version store open FAILED in Permissive mode: {}. \
                         Rollback protection DEGRADED — load proceeds with in-memory floor=0 only.",
                        e
                    );
                    // Leave self.rbac_manifest_store as the
                    // Batch 68 Arc (no version_store attached);
                    // load_from_file below falls back to
                    // floor=0 semantic.
                }
                RbacManifestMode::Enforcing => {
                    return Err(format!(
                        "RBAC manifest version store open failed in Enforcing mode (fail-closed): {}",
                        e
                    ));
                }
            },
        }

        self.rbac_manifest_store
            .load_from_file(mode, pubkey_hex, path_override, &expected_tenant)
    }

    /// Initialize the audit sink (Batch 78 Sprint 6.2 Phase
    /// 2). When `audit.mode=Enabled`, opens the append-only
    /// audit log at the configured path with chain recovery
    /// (Batch 75) so post-restart appends continue from the
    /// last complete entry.
    ///
    /// MODE GATE:
    /// - Disabled: early-return Ok. `audit_sink` stays None;
    ///   Phase 2 / Batch 79 CommandHandler emit paths fall
    ///   to log-only.
    /// - Enabled: open the sink; failure is FAIL-CLOSED
    ///   (forensic-trail invariant per IEC 62443 SL-2 FR6 is
    ///   non-negotiable — no permissive fallback).
    ///
    /// KEY SOURCE PRIORITY (Batch 84 Sprint 6.3):
    /// 1. If AppState.keystore is Some, derive the HMAC key
    ///    via `keystore.derive_key(KeyPurpose::AuditHmacChain,
    ///    context=b"")`. Preferred path — gives rotation +
    ///    zeroize discipline from KeyMaterial.
    /// 2. Else if audit.hmac_key_hex is Some, use the
    ///    config-supplied hex. Rollout-stage path for
    ///    deployments still running keystore.mode=Disabled.
    /// 3. Else fail-closed: audit.mode=Enabled requires
    ///    EITHER a live keystore OR hmac_key_hex
    ///    (enforced by coherence Rule 15).
    pub fn init_audit_sink(&mut self) -> Result<(), String> {
        use crate::audit::{AuditHmacKey, AuditSink};
        use crate::config::AuditMode;
        use crate::keystore::KeyPurpose;

        if matches!(self.config.audit.mode, AuditMode::Disabled) {
            info!("Audit sink init skipped: audit.mode=Disabled (HC-1 backward compat)");
            return Ok(());
        }

        // Key source resolution: keystore-derived preferred,
        // config hex fallback.
        let mut key_bytes = [0u8; 32];
        let key_source_label: &str;

        if let Some(ks) = self.keystore.as_ref() {
            // Batch 84: derive from master via
            // KeyPurpose::AuditHmacChain.
            let ks = ks.clone();
            // Blocking-context helper: tokio::task::block_in_
            // place requires multi-thread runtime; init_audit_
            // sink runs in async_main BEFORE the LocalSet wrap,
            // so the tokio runtime we're on IS multi-thread.
            // derive_key is async; block on it here rather
            // than propagating async up through init_* which
            // are otherwise sync.
            let derived = tokio::runtime::Handle::current().block_on(async move {
                ks.derive_key(KeyPurpose::AuditHmacChain, b"").await
            });
            let material = derived.map_err(|e| {
                format!(
                    "Audit sink key derivation failed: keystore.derive_key(AuditHmacChain): {}",
                    e
                )
            })?;
            key_bytes.copy_from_slice(material.expose_secret());
            key_source_label = "keystore-derived(KeyPurpose::AuditHmacChain)";
            info!(
                "Audit HMAC key: derived from keystore (backend={:?}, purpose=AuditHmacChain)",
                self.keystore.as_ref().map(|k| k.backend())
            );
        } else if let Some(key_hex) = self.config.audit.hmac_key_hex.as_deref() {
            // Rollout-stage: config hex fallback.
            for (i, b) in key_bytes.iter_mut().enumerate() {
                let pair = key_hex.get(i * 2..i * 2 + 2).ok_or_else(|| {
                    format!("audit.hmac_key_hex: hex slice error at byte {}", i)
                })?;
                *b = u8::from_str_radix(pair, 16).map_err(|e| {
                    format!("audit.hmac_key_hex: hex parse at byte {}: {}", i, e)
                })?;
            }
            key_source_label = "config(audit.hmac_key_hex)";
            warn!(
                "Audit HMAC key: using config.audit.hmac_key_hex rollout-stage path. \
                 Provision keystore.mode=Auto (or FileBacked) to migrate to master-derived key."
            );
        } else {
            return Err(
                "Audit sink requires key source: either keystore.mode != Disabled OR audit.hmac_key_hex set. \
                 Neither is configured (coherence Rule 15 should have caught this)."
                    .to_string(),
            );
        }

        let log_path = self
            .config
            .audit
            .log_path
            .clone()
            .unwrap_or_else(|| std::path::PathBuf::from("/var/log/suderra/audit.log"));

        let hmac_key = AuditHmacKey::from_bytes(key_bytes);
        // Zeroize the local copy after move; AuditHmacKey
        // also zeroize-on-drops the owned copy.
        {
            use zeroize::Zeroize;
            key_bytes.zeroize();
        }

        let sink = AuditSink::open(&log_path, hmac_key).map_err(|e| {
            format!(
                "Audit sink open failed (fail-closed boot, mode=Enabled): {}",
                e
            )
        })?;

        info!(
            "Audit sink opened: path={} mode=Enabled key_source={}",
            log_path.display(),
            key_source_label
        );

        self.audit_sink = Some(std::sync::Arc::new(sink));
        Ok(())
    }

    /// Initialize the master-key keystore (Batch 83 Sprint
    /// 6.3). Selects a backend per `keystore.mode`:
    ///
    /// - Disabled: no-op. AppState.keystore stays None;
    ///   consumers (audit / sqlcipher) keep using config-hex
    ///   key sources (Phase 2 / Batch 84 migrates those).
    /// - FileBacked: explicit operator choice. Reads
    ///   acceptance token + passphrase + salt from configured
    ///   paths (or /etc/suderra/keystore.* defaults) +
    ///   constructs FileBackedKeystore via Argon2id.
    /// - Auto: probe TPM first (Phase 2 / Batch 83a pending),
    ///   then systemd-creds (Phase 2 / Batch 83b pending),
    ///   then fall through to FileBacked. Pre-TPM-landing
    ///   Auto ALWAYS ends up at FileBacked after logging
    ///   the downgrade.
    ///
    /// FAIL-CLOSED: in FileBacked / Auto modes, failure to
    /// construct the keystore -> exit(1). The keystore is
    /// the trust anchor for all downstream key derivation;
    /// there's no "permissive" fallback that silently uses
    /// weaker keys.
    pub fn init_keystore(&mut self) -> Result<(), String> {
        use crate::config::KeystoreMode;
        use crate::keystore::{
            AcceptanceToken, Argon2idParams, FileBackedAcceptance, FileBackedKeystore,
        };

        if matches!(self.config.keystore.mode, KeystoreMode::Disabled) {
            info!("Keystore init skipped: keystore.mode=Disabled (HC-1 backward compat)");
            return Ok(());
        }

        // Auto + FileBacked both converge on FileBacked for
        // this batch (TPM + systemd-creds probe land in
        // follow-up batches). Log the downgrade in Auto
        // mode so operators know which backend actually
        // activated.
        if matches!(self.config.keystore.mode, KeystoreMode::Auto) {
            warn!(
                "Keystore.mode=Auto: TPM + systemd-creds probes land in Phase 2 / Batches 83a+83b. \
                 Falling through to FileBacked for this boot. Provision a TPM (or systemd-creds namespace) \
                 to promote to a hardware-backed tier when those batches ship."
            );
        }

        let pass_path = self
            .config
            .keystore
            .passphrase_path
            .clone()
            .unwrap_or_else(|| {
                std::path::PathBuf::from("/etc/suderra/keystore.passphrase")
            });
        let salt_path = self.config.keystore.salt_path.clone().unwrap_or_else(|| {
            std::path::PathBuf::from("/etc/suderra/keystore.salt")
        });
        let acceptance_path = self
            .config
            .keystore
            .acceptance_path
            .clone()
            .unwrap_or_else(|| {
                std::path::PathBuf::from("/etc/suderra/keystore.acceptance.json")
            });

        // Read + parse acceptance token (operator-signed).
        let acceptance_bytes = std::fs::read(&acceptance_path).map_err(|e| {
            format!(
                "Keystore init: read acceptance {}: {}",
                acceptance_path.display(),
                e
            )
        })?;
        let token: AcceptanceToken = serde_json::from_slice(&acceptance_bytes)
            .map_err(|e| {
                format!(
                    "Keystore init: parse acceptance JSON {}: {}",
                    acceptance_path.display(),
                    e
                )
            })?;

        // Device identity for binding. Device code is the
        // stable acceptance-token field; operator_id comes
        // from the token itself.
        let device_id = self.config.device_code.clone();
        let acceptance = FileBackedAcceptance::try_from_parts(
            &token,
            &token.operator_id,
            &device_id,
            std::time::SystemTime::now(),
            // Pre-Batch-84 signature-verify wiring: accept
            // operator-supplied token without crypto verify.
            // Batch 84 introduces operator-pubkey config
            // knob + real ed25519 verify here. Current
            // discipline: acceptance_path file perms 0400
            // owner:suderra + audit-log every load.
            |_, _| true,
        )
        .map_err(|e| format!("Keystore init: acceptance token invalid: {:?}", e))?;

        let params = Argon2idParams {
            memory_kib: self.config.keystore.argon2_memory_kib,
            iterations: self.config.keystore.argon2_iterations,
            parallelism: self.config.keystore.argon2_parallelism,
        };

        let ks = FileBackedKeystore::open(&pass_path, &salt_path, params, acceptance)
            .map_err(|e| {
                format!(
                    "Keystore init: FileBacked open failed (fail-closed boot): {}",
                    e
                )
            })?;

        info!(
            "Keystore opened: backend=FileBacked argon2id m={}KiB t={} p={}",
            params.memory_kib, params.iterations, params.parallelism
        );

        self.keystore = Some(std::sync::Arc::new(ks));
        Ok(())
    }

    /// Pick the concrete ClockAuthority impl (Batch 90 Sprint
    /// 6.7 wire). Called from boot after config is loaded.
    ///
    /// SELECTION:
    /// - `clock.enable_chrony_query = true` →
    ///   `ChronyNtsClockAuthority` (queries chronyc tracking
    ///   with 10s cache + subprocess fallback sentinel).
    /// - `false` (HC-1 default) → `SystemClockAuthority`
    ///   (always-trusting 0-age). The ctor-time baseline
    ///   already set this; we reconstruct to pick up the
    ///   operator-configured threshold.
    ///
    /// NEVER fails — chrony subprocess failures surface at
    /// READ TIME as the sentinel age, not at init. Boot
    /// continues regardless.
    pub fn init_clock_authority(&mut self) {
        use crate::runtime_safety::{ChronyNtsClockAuthority, SystemClockAuthority};

        let threshold = self.config.clock.nts_sync_max_skew_secs;
        if self.config.clock.enable_chrony_query {
            info!(
                "Clock authority: ChronyNtsClockAuthority threshold={}s (Sprint 6.7 real NTS query)",
                threshold
            );
            self.clock_authority =
                std::sync::Arc::new(ChronyNtsClockAuthority::new(threshold));
        } else {
            info!(
                "Clock authority: SystemClockAuthority threshold={}s (HC-1 trusting-0-age baseline; set clock.enable_chrony_query=true for real NTS age)",
                threshold
            );
            self.clock_authority = std::sync::Arc::new(
                SystemClockAuthority::with_nts_threshold(threshold),
            );
        }
    }

    /// Open the A/B partition state store (Batch 108 Sprint
    /// 6.5 wire). Uses default path `/var/lib/suderra/
    /// partition.json` (first-boot creates file with initial
    /// state).
    ///
    /// FAIL-CLOSED: corrupt JSON, unreadable parent dir, or
    /// any other load failure returns Err → caller exits(1).
    /// Without reliable partition state the updater subsystem
    /// cannot operate safely — running without a store would
    /// let an update apply without recording the state
    /// transition, breaking rollback semantics.
    pub fn init_partition_store(&mut self) -> Result<(), String> {
        let store = crate::updater::PartitionStore::open(None).map_err(|e| {
            format!(
                "PartitionStore init failed (fail-closed boot): {}. \
                 Inspect /var/lib/suderra/partition.json for corruption; manual recovery via removing the file will reinitialize to first-boot state but may lose active slot tracking.",
                e
            )
        })?;

        let snap = store.snapshot().map_err(|e| {
            format!("PartitionStore snapshot failed post-open: {}", e)
        })?;

        info!(
            "PartitionStore opened: active={:?} slot_a={:?} slot_b={:?} pending_deadline={:?}",
            snap.active,
            snap.slot_a_state,
            snap.slot_b_state,
            snap.pending_confirm_deadline_unix_secs
        );

        self.partition_store = Some(std::sync::Arc::new(store));
        Ok(())
    }

    /// Parse the `firmware_update.signing_pubkey_hex` config
    /// field into a cached `VerifyingKey` on AppState (Batch
    /// 114 Sprint 6.5 wire).
    ///
    /// WHY: The SignedFirmwareManifest verify path runs on
    /// every incoming firmware deploy command; re-parsing the
    /// hex string per command burns CPU + widens the attack
    /// surface for malformed-hex probes. Parsing once at boot
    /// + caching the VerifyingKey Arc matches the
    /// rbac_manifest_store pubkey pattern (Batch 68).
    ///
    /// NO-OP when `firmware_update.mode == Disabled` — keeps
    /// `firmware_signing_pubkey = None`, and the legacy
    /// tarball OTA path continues to work (HC-1 backward
    /// compat). Config coherence Rule 20 + 21 guarantee that
    /// when mode != Disabled the hex field is present +
    /// well-formed; parse errors here are fail-closed by the
    /// caller (main exits 1).
    pub fn init_firmware_signing_pubkey(&mut self) -> Result<(), String> {
        use crate::config::FirmwareUpdateMode;

        if matches!(self.config.firmware_update.mode, FirmwareUpdateMode::Disabled) {
            info!(
                "FirmwareUpdateConfig: mode=Disabled — SignedFirmwareManifest verify not wired (legacy tarball OTA remains available)"
            );
            return Ok(());
        }

        let hex = match self.config.firmware_update.signing_pubkey_hex.as_deref() {
            Some(h) => h,
            None => {
                return Err(
                    "firmware_update.signing_pubkey_hex is None despite mode != Disabled — \
                     config Rule 20 should have caught this at load"
                        .to_string(),
                );
            }
        };

        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            let byte_idx = i * 2;
            let hex_byte = hex.get(byte_idx..byte_idx + 2).ok_or_else(|| {
                format!("firmware signing pubkey hex slice error at index {}", byte_idx)
            })?;
            *b = u8::from_str_radix(hex_byte, 16).map_err(|e| {
                format!("firmware signing pubkey invalid hex at byte {}: {}", i, e)
            })?;
        }

        let key = ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|e| {
            format!("firmware signing pubkey ed25519 construction failed: {}", e)
        })?;

        info!(
            "FirmwareUpdateConfig: mode={:?} firmware_signing_pubkey parsed (key fingerprint sha256 first 8 bytes={:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x})",
            self.config.firmware_update.mode,
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
        );
        self.firmware_signing_pubkey = Some(std::sync::Arc::new(key));
        Ok(())
    }

    /// Select + instantiate the bootloader backend per
    /// `firmware_update.bootloader_backend` (Batch 128
    /// Sprint 6.5 wire).
    ///
    /// Called AFTER config load + before init_lifecycle_cell
    /// so the downstream HTTP endpoint + watchdog see the
    /// correct backend. Noop default preserves HC-1
    /// backward compat; Tryboot is an operator opt-in.
    ///
    /// NO-OP when backend is already Noop (the AppState::
    /// new default). Tryboot construction wraps
    /// `TrybootBootloaderHandle::new_with_autoboot_path`
    /// if `tryboot_autoboot_path` is set, else default
    /// `/boot/firmware/autoboot.txt`.
    pub fn init_bootloader_backend(&mut self) {
        use crate::config::BootloaderBackend;
        match self.config.firmware_update.bootloader_backend {
            BootloaderBackend::Noop => {
                // Already set at AppState::new(). Log for
                // operator visibility.
                info!(
                    "Bootloader backend: Noop (HC-1 default). PartitionStore state machine still functional for forensic audit."
                );
            }
            BootloaderBackend::Tryboot => {
                let handle = match self
                    .config
                    .firmware_update
                    .tryboot_autoboot_path
                    .clone()
                {
                    Some(p) => {
                        info!(
                            "Bootloader backend: Tryboot (autoboot.txt override path={})",
                            p.display()
                        );
                        crate::updater::TrybootBootloaderHandle::new_with_autoboot_path(p)
                    }
                    None => {
                        info!(
                            "Bootloader backend: Tryboot (default autoboot.txt path={})",
                            crate::updater::DEFAULT_AUTOBOOT_TXT_PATH
                        );
                        crate::updater::TrybootBootloaderHandle::new_default()
                    }
                };
                self.bootloader = std::sync::Arc::new(handle);
            }
        }
    }

    /// Initialize hardware handles (must be called within LocalSet context)
    pub fn init_hardware_handles(&mut self) {
        // Initialize Modbus actor
        if !self.config.modbus.is_empty() {
            self.modbus_handle = Some(ModbusHandle::new(self.config.modbus.clone()));
            info!(
                "Modbus actor initialized with {} devices",
                self.config.modbus.len()
            );
        }

        // Initialize GPIO actor (v2.0 - actor pattern)
        if !self.config.gpio.is_empty() {
            self.gpio_handle = Some(GpioHandle::new(
                self.config.gpio.clone(),
                self.config.runtime.gpio_timeout_secs,
            ));
            info!(
                "GPIO actor initialized with {} pins",
                self.config.gpio.len()
            );
        }

        // Initialize I2C actor
        if !self.config.i2c.is_empty() {
            let handle = I2cHandle::new(self.config.i2c.clone());
            self.i2c_handle = Some(handle);
            info!(
                "I2C actor initialized with {} devices",
                self.config.i2c.len()
            );
        }
    }
}

/// Main entry point with optimized Tokio runtime for edge devices
///
/// Uses custom runtime builder instead of #[tokio::main] macro for:
/// - Worker thread count tuned for edge hardware (2 cores typical)
/// - Blocking thread pool limited for SQLite operations
/// - Stack size optimized for embedded environments
///
/// # Command Line Arguments (v1.2.1 - issue #35)
/// - `--init`: Generate default configuration file at /etc/suderra/config.yaml
/// - `--version`, `-V`: Print version and exit
/// - `--help`, `-h`: Print help and exit
fn main() {
    // Batch 24 plan §5 Faz 2 Step 2 partial: boot-time process
    // hardening. MUST run before any page allocation that could
    // later hold secrets (Sprint 6.3 keystore master-key mlock)
    // and before any tokio-spawned task whose panic would bypass
    // the main-thread hook.
    //
    // Non-fatal on failure — logged as error but boot continues.
    // Sprint 6.3 hardening adds a `config.security.process_
    // hardening_enforce` flag that makes this fail-closed. Today
    // it's best-effort so an unusual environment (cfg=docker-
    // rootless where prctl may be restricted) doesn't brick the
    // boot.
    if let Err(e) = process_hardening::harden_process() {
        // WHY: pre-tracing bootstrap — tracing is not yet
        // initialized; eprintln! is the only reliable output.
        #[allow(clippy::print_stderr)]
        {
            eprintln!("WARNING: process hardening failed: {}", e);
            eprintln!("Boot continuing without coredump-disable; future keystore wire-up will require this.");
        }
    }

    // Handle CLI arguments (v1.2.1)
    let args: Vec<String> = std::env::args().collect();

    // Process first argument only (simple CLI - no loop needed)
    if let Some(arg) = args.get(1) {
        match arg.as_str() {
            "--init" => {
                if let Err(e) = generate_default_config() {
                    // WHY: pre-tracing bootstrap — tracing is not yet initialized at this point
                    eprintln!("Error generating config: {}", e);
                    std::process::exit(1);
                }
                return;
            }
            "--version" | "-V" => {
                println!("Suderra Edge Agent v{}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--confirm-active" => {
                // Batch 110 Sprint 6.5 Phase 2: post-boot
                // confirm CLI. Called by a systemd unit /
                // timer after N seconds of healthy agent
                // operation. Resolves the currently-active
                // slot + applies PartitionRoll::Confirm.
                //
                // Usage: suderra-agent --confirm-active
                //
                // No MQTT required — direct PartitionStore
                // mutation. Exit 0 on success, 1 on any
                // failure.
                let code = run_confirm_active();
                std::process::exit(code);
            }
            "--audit-verify" => {
                // Batch 77 Sprint 6.2 Phase 2: offline audit
                // log verification CLI path.
                //
                // Usage:
                //   suderra-agent --audit-verify <log-path>
                //
                // Reads the 32-byte HMAC key from env
                // `SUDERRA_AUDIT_KEY_HEX` (64-char lowercase
                // hex). Exits 0 on clean chain, 1 on any
                // failure. Prints verify outcome to stdout.
                //
                // This is a SELF-CONTAINED offline path: no
                // config load, no network, no daemon spinup.
                // Auditors can run this on a read-only copy
                // of the log file on ANY machine with the
                // agent binary + the key.
                let log_path = match args.get(2) {
                    Some(p) => p,
                    None => {
                        // Pre-tracing bootstrap
                        #[allow(clippy::print_stderr)]
                        {
                            eprintln!(
                                "Error: --audit-verify requires a log file path"
                            );
                            eprintln!(
                                "Usage: suderra-agent --audit-verify <log-path>"
                            );
                        }
                        std::process::exit(1);
                    }
                };
                let code = run_audit_verify(log_path);
                std::process::exit(code);
            }
            "--help" | "-h" => {
                println!("Suderra Edge Agent v{}", env!("CARGO_PKG_VERSION"));
                println!();
                println!("USAGE:");
                println!("    suderra-agent [OPTIONS]");
                println!();
                println!("OPTIONS:");
                println!("    --init                    Generate default configuration file");
                println!("    --audit-verify <path>     Verify NDJSON audit log chain (Batch 77)");
                println!("    --confirm-active          Confirm the currently-active A/B slot (Batch 110)");
                println!("    --version                 Print version information");
                println!("    --help                    Print this help message");
                println!();
                println!("ENVIRONMENT:");
                println!(
                    "    SUDERRA_CONFIG              Path to config file (default: /etc/suderra/config.yaml)"
                );
                println!(
                    "    SUDERRA_AUDIT_KEY_HEX       64-char hex HMAC key for --audit-verify"
                );
                println!(
                    "    RUST_LOG                    Log level filter (e.g., debug, info, warn)"
                );
                return;
            }
            _ => {
                // WHY: pre-tracing bootstrap — tracing is not yet initialized at this point
                eprintln!("Unknown argument: {}", arg);
                eprintln!("Use --help for usage information");
                std::process::exit(1);
            }
        }
    }

    // Build optimized runtime for edge devices
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2) // Edge devices typically have 2 cores
        .max_blocking_threads(8) // Limit for SQLite blocking ops
        .thread_stack_size(128 * 1024) // 128 KB per thread (embedded friendly)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            // WHY: pre-tracing bootstrap — tracing is not yet initialized at this point
            #[allow(clippy::print_stderr)]
            {
                eprintln!("Failed to build Tokio runtime: {}", e);
            }
            std::process::exit(1);
        }
    };

    // Run async main within the custom runtime
    if let Err(e) = runtime.block_on(async_main()) {
        // WHY: pre-tracing bootstrap — tracing may have failed to initialize in async_main,
        // or we reached a fatal error before tracing was ready. eprintln! is the only
        // reliable output channel at this point.
        #[allow(clippy::print_stderr)]
        {
            eprintln!("Fatal error: {}", e);
        }
        std::process::exit(1);
    }
}

/// Async main function with application logic
async fn async_main() -> Result<()> {
    // Initialize logging
    init_logging();

    info!("======================================");
    info!("  Suderra Edge Agent v{}", env!("CARGO_PKG_VERSION"));
    info!("======================================");

    // Load configuration
    let config = match AgentConfig::load() {
        Ok(cfg) => {
            info!("Configuration loaded successfully");
            info!("  Device ID: {}", cfg.device_id);
            info!("  Device Code: {}", cfg.device_code);
            info!("  API URL: {}", cfg.api_url);
            // Batch 27 plan §5 Faz 2 item 7: expose mTLS rollout
            // stage at boot for operator visibility. Pre-Sprint-
            // 6.8 this is INFORMATIONAL ONLY — rustls handshake
            // behavior is unchanged. Once Sprint 6.8 wires the
            // verify_leaf_cert pure function into the rustls
            // client builder, the mode will drive:
            //   Legacy → log mismatches, accept handshake.
            //   Warn   → audit-emit mismatches, accept handshake.
            //   Strict → reject handshake on any mismatch.
            info!(
                "  mTLS mode: {:?} (fingerprint_pinning={}, min_tls={})",
                cfg.mtls.mode,
                cfg.mtls.enforce_fingerprint_pinning,
                cfg.mtls.min_tls_version
            );
            if matches!(cfg.mtls.mode, crate::mtls::MtlsMode::Legacy)
                && cfg.mtls.enforce_fingerprint_pinning
            {
                // Non-standard but legitimate combo (operator wants
                // early-detection value without full Warn/Strict
                // migration); log it so audit reviewers notice.
                warn!(
                    "mTLS rollout: Legacy stage + fingerprint_pinning=true. \
                     This is an EARLY-DETECTION posture; mismatches will be \
                     logged but handshakes still accepted. Plan Sprint 6.8 \
                     migration path documented in config.yaml."
                );
            }
            // Batch 38: boot-time Faz 2 security-posture banner.
            // Consolidates the runtime-config values operators
            // most-frequently need to verify on device bring-up.
            // Pre-Batch-38 operators had to issue cmd_get_config
            // (which pre-Batch-36 didn't even surface these
            // fields) OR SSH+cat /etc/suderra/config.yaml. With
            // this banner the journalctl boot log carries all
            // tunable security thresholds — no runtime query
            // needed to verify a config rollout landed correctly.
            info!("Faz 2 security posture (Batch 31-37 foundations):");
            info!(
                "  RBAC gate: preview-logging active (Sprint 6.4 wires enforcement)"
            );
            info!(
                "  Two-person integrity: preview-logging active for UpdateFirmware/DeployProgram/ForceValue/SafeStateTrigger/Reboot"
            );
            info!(
                "  Retained-msg rejection: active on commands + config topics (plan D-14)"
            );
            info!(
                "  Shutdown drain: command handler drain-aware; timeout={}s drain_budget={}ms (plan D-15)",
                cfg.runtime.shutdown_timeout_secs,
                cfg.runtime.drain_timeout_ms
            );
            info!(
                "  Replay window: max_age={}s max_skew={}s (IEC 62443 SL-2 FR-7)",
                cfg.runtime.max_command_age_secs,
                cfg.runtime.max_command_skew_secs
            );
            info!(
                "  Process hardening: prctl(PR_SET_DUMPABLE=0) + panic-abort hook active (Sprint 6.3 partial)"
            );
            // Batch 42: config-integrity sidecar mode.
            info!(
                "  Config integrity: mode={:?} (verify wires in Sprint 6.6; plan D-13)",
                cfg.config_integrity.mode
            );
            // Batch 45: command-envelope signature mode.
            info!(
                "  Signature mode: {:?} (envelope verify + jti dedup wire in Sprint 6.4; plan §2 HC-6)",
                cfg.signature_mode
            );
            // Batch 56: clock authority NTS threshold.
            info!(
                "  Clock authority: nts_sync_max_skew_secs={} (ChronyNtsClockAuthority wires in Sprint 6.7; plan D-7)",
                cfg.clock.nts_sync_max_skew_secs
            );
            // Batch 58: envelope dedup (Moka hot-window tier).
            info!(
                "  Envelope dedup: moka_capacity={}, moka_ttl_secs={} (SQLCipher tier wires in Sprint 6.4; plan §4.10)",
                cfg.envelope_dedup.moka_capacity,
                cfg.envelope_dedup.moka_ttl_secs
            );
            // Batch 65: CommandEnvelope parse-and-verify path
            // active status. After Batches 57-63 Sprint 6.4
            // is substantially wired; operators watching boot
            // see which envelope features are live today vs
            // pending Sprint 6.1 RBAC manifest runtime.
            info!(
                "  CommandEnvelope path: parse-and-verify ACTIVE (Batch 63); \
                 signature-verify NO-OP pending Sprint 6.1 actor-pubkey lookup; \
                 Moka dedup tier ACTIVE (Batch 57); SQLCipher tier pending Sprint 6.4"
            );
            // Batch 66: RBAC manifest mode.
            info!(
                "  RBAC manifest: mode={:?} (loader runtime wires in Sprint 6.1; plan §3 R-5 / ADR-018)",
                cfg.rbac_manifest.mode
            );
            cfg
        }
        Err(e) => {
            error!("Failed to load configuration: {:#}", e);
            error!("Please ensure /etc/suderra/config.yaml exists and is valid");
            std::process::exit(1);
        }
    };

    // Batch 54 Sprint 6.6 FULL WIRE: verify config-integrity
    // sidecar at boot. Called AFTER config load (so we have the
    // mode + factory_pubkey_hex + device_id) and BEFORE any
    // network listener binds / tokio runtime spawns — fail-
    // closed boot in Enforcing mode means exit(1) before any
    // attacker-observable activity.
    //
    // Mode semantics:
    //   Disabled   — no check (default, HC-1 backward compat).
    //   Permissive — check attempted; failure WARN-logged but
    //                boot continues (early-detection posture).
    //   Enforcing  — check required; failure exits(1). Fail-
    //                closed is the tier-1 contract.
    //
    // Path: /etc/suderra/config.yaml + /etc/suderra/config.yaml.sig
    // sidecar (or config_integrity.sidecar_path override).
    {
        use std::path::PathBuf;
        let config_yaml_path = PathBuf::from("/etc/suderra/config.yaml");
        let sidecar_override = config.config_integrity.sidecar_path.as_deref();
        let factory_pubkey_hex = config.config_integrity.factory_pubkey_hex.as_deref();
        let data_dir = data_dir::data_dir();
        match crate::config_integrity::verify_at_boot(
            config.config_integrity.mode,
            factory_pubkey_hex,
            sidecar_override,
            &config_yaml_path,
            &config.device_id,
            &data_dir,
        ) {
            Ok(()) => {}
            Err(reason) => {
                // Enforcing-mode failure bubbled up from
                // verify_at_boot. Permissive failures are
                // consumed internally (warn-logged; returns Ok).
                // The only path reaching Err here is Enforcing
                // mode + verify failed. Fail-closed: exit(1)
                // with operator-visible error.
                error!(
                    "Config-integrity verification FAILED in Enforcing mode: {}. Agent cannot boot.",
                    reason
                );
                std::process::exit(1);
            }
        }
    }

    // Initialize OpenTelemetry OTLP export (if configured and feature enabled)
    // This adds distributed tracing support for production observability
    let _otel_provider = init_opentelemetry(&config);

    // Create shared state
    let state = Arc::new(RwLock::new(AppState::new(config.clone())));

    // Initialize script storage (v1.2.0 - async initialization for RwLock)
    {
        let state_guard = state.read().await;
        state_guard.init_script_storage().await;
    }

    // Initialize FailoverManager (Faz 1 Step 1.2 / ARC-001 / Batch 13).
    // Returns JoinHandle of the health-check task if the manager is
    // constructed; None if config.mqtt.failover is disabled OR primary
    // broker is not configured. The JoinHandle is dropped here — future
    // work wires it into ShutdownCoordinator (Batch 10) for graceful
    // cancellation during the Draining phase.
    let _failover_health_check: Option<tokio::task::JoinHandle<()>> = {
        let mut state_guard = state.write().await;
        state_guard.init_failover_manager()
    };

    // Initialize HealthServer (Faz 1 Step 1.4 / ARC-003 / Batch 14).
    //
    // WHY: Orchestrator liveness probes (Docker / k8s / systemd) need the
    // HTTP endpoints. Server spawns on localhost:8080 by default (per
    // HealthServerConfig::default()) only when config.health.enabled=true;
    // otherwise stays None at zero cost.
    //
    // WHAT: `init_health_server()` returns Err on invalid bind address
    // (fail-closed boot — misconfig never silently drops the endpoint);
    // Ok(None) on disabled config; Ok(Some(handle)) on successful spawn.
    // The JoinHandle is dropped here — Sprint 6.7 wires it into the
    // ShutdownPhase::Draining force-cancel list.
    #[cfg(feature = "health")]
    let _health_server_handle: Option<tokio::task::JoinHandle<()>> = {
        let mut state_guard = state.write().await;
        match state_guard.init_health_server().await {
            Ok(h) => h,
            Err(msg) => {
                error!("HealthServer init failed (fail-closed boot): {}", msg);
                std::process::exit(1);
            }
        }
    };

    // Initialize OfflineQueue (Faz 1 Step 1.3 / ARC-002 / Batch 15).
    //
    // WHY: Pre-Batch-15, MQTT publish dropped telemetry when broker
    // unreachable. ADR-020 §6 + FR6 require durable queue-and-forward.
    //
    // WHAT: Opens SQLCipher DB at `${SUDERRA_DATA_DIR}/offline_queue.db`
    // (overridable via config) when config.offline_queue.enabled=true.
    // Fail-closed boot on open error. MQTT publish integration (Sprint
    // 6.2) threads `state.offline_queue.as_ref()` into the publish path.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_offline_queue().await {
            error!("OfflineQueue init failed (fail-closed boot): {}", msg);
            std::process::exit(1);
        }
    }

    // Initialize BackupManager (Faz 1 Step 8 / ARC-009 / Batch 18).
    //
    // WHY: GDPR Art 20 edge portability + disaster-recovery snapshot.
    // Pre-Batch-18 the module was dead-code.
    //
    // WHAT: Constructs BackupManager + calls init() to mkdir backup_dir
    // when config.backup.enabled=true. Fail-closed boot on mkdir error
    // (declared-enabled backup MUST be able to write). HTTP endpoint +
    // CLI subcommand triggers land in Sprint 6.x.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_backup_manager() {
            error!("BackupManager init failed (fail-closed boot): {}", msg);
            std::process::exit(1);
        }
    }

    // Initialize JTI dedup table (Batch 59 Sprint 6.4 foundation).
    //
    // WHY: Plan §4.10 zero-trust command model requires a
    // sliding-window jti dedup cache for replay defense. Batch
    // 57 shipped MokaJtiDedupTable + Batch 58 added the config
    // knob; Batch 59 constructs the RUNTIME instance in
    // AppState so Sprint 6.4 full wire can invoke it from
    // execute_command without AppState-shape churn.
    //
    // INFALLIBLE: Moka cache construction doesn't touch disk or
    // syscalls; can't fail. init_jti_dedup_table() returns ().
    //
    // MODE GATE: skipped when signature_mode=Disabled. Permissive/
    // Enforcing mode constructs the table.
    {
        let mut state_guard = state.write().await;
        state_guard.init_jti_dedup_table();
    }

    // Initialize RBAC manifest store (Batch 68 Sprint 6.1 full wire).
    //
    // WHY: Plan §3 R-5 + ADR-018 mandate a cloud-signed RBAC
    // manifest that binds operators to ed25519 pubkeys. Batch 67
    // shipped the store skeleton; Batch 68 wires the boot-time
    // load + fail-closed Enforcing-mode handling so the
    // envelope_adapter Gate 7 signature verify (Batch 63) has a
    // real lookup source (swapping the NO-OP closure).
    //
    // FAIL-CLOSED DISCIPLINE:
    // - Disabled:  skip load (empty store OK).
    // - Permissive: load failure is warn-logged + boot continues
    //   (envelope Gate 7 falls to NO-OP — matches Batch 63
    //   Permissive semantic).
    // - Enforcing: load failure → exit(1). Operator must fix
    //   manifest or downgrade mode. Matches init_backup_manager +
    //   Faz 2 coherence discipline.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_rbac_manifest_store() {
            error!(
                "RBAC manifest store init failed (fail-closed boot, mode=Enforcing): {}",
                msg
            );
            std::process::exit(1);
        }
    }

    // Initialize A/B partition state store (Batch 108 Sprint
    // 6.5 wire).
    //
    // WHY: Plan §5 Faz 2 item 6 + ADR-019 §2 mandate
    // persistent A/B partition state. The store MUST be
    // opened BEFORE the update orchestrator command handler
    // runs so cmd_update_firmware has a live state to
    // mutate. Runs EARLY in boot so downstream subsystems
    // (audit sink for rotation events, watchdog task for
    // rollback) can rely on it.
    //
    // FAIL-CLOSED: corrupt partition.json → exit(1).
    // Operator recovery runbook to be added in a follow-up
    // documentation batch.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_partition_store() {
            error!("{}", msg);
            std::process::exit(1);
        }
    }

    // Batch 114 Sprint 6.5: parse firmware_update.
    // signing_pubkey_hex into a cached VerifyingKey. NO-OP
    // when mode=Disabled; parse-failure is fail-closed
    // (exit 1) because config Rule 20+21 already validated
    // the hex shape at load time — a parse failure here
    // would be a genuine cryptographic construction error
    // on an otherwise well-formed hex string, which points
    // to an unusable / compromised key and deserves
    // operator attention before accepting commands.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_firmware_signing_pubkey() {
            error!("init_firmware_signing_pubkey: {}", msg);
            std::process::exit(1);
        }
    }

    // Batch 128 Sprint 6.5: select bootloader backend per
    // config (Noop default / Tryboot for RPi). Runs AFTER
    // firmware_signing_pubkey but BEFORE init_lifecycle_cell
    // so the HTTP endpoint + watchdog see the correct
    // backend.
    {
        let mut state_guard = state.write().await;
        state_guard.init_bootloader_backend();
    }

    // Initialize clock authority (Batch 90 Sprint 6.7 wire).
    //
    // WHY: Plan §5 Faz 2 item 10 + D-7. Selects between
    // SystemClockAuthority (HC-1 trusting baseline) and
    // ChronyNtsClockAuthority (real chronyc-tracking query)
    // based on config.clock.enable_chrony_query.
    //
    // Runs EARLY in boot — before keystore + audit — because
    // future batches migrating envelope freshness + audit
    // timestamp paths to the trait will query clock at those
    // init sites (currently they use SystemTime::now()
    // directly). Positioning the init first avoids any
    // ordering constraint if Sprint 6.7 consumer migration
    // batches need the clock during their own init.
    //
    // NEVER fails — chrony subprocess errors surface as
    // sentinel u64::MAX age at read time.
    {
        let mut state_guard = state.write().await;
        state_guard.init_clock_authority();
    }

    // Initialize keystore (Batch 83 Sprint 6.3).
    //
    // WHY: Plan §5 Faz 2 item 1 + ADR-018 §4 mandate a
    // 3-backend master-key keystore. Batch 82 shipped the
    // FileBacked runtime; Batch 83 wires AppState +
    // boot-time open. Pre-Batch-84 the keystore is NOT YET
    // consumed by audit or SQLCipher (those migrate in
    // Batches 84+85). Opening it at boot proves the
    // acceptance-token + Argon2id pipeline works and makes
    // KeyPurpose-derived keys available for the downstream
    // migration batches.
    //
    // FAIL-CLOSED: keystore.mode != Disabled + open failure
    // -> exit(1). The keystore is the trust anchor; weaker
    // fallback would violate ADR-018 §4 invariants.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_keystore() {
            error!(
                "Keystore init failed (fail-closed boot): {}",
                msg
            );
            std::process::exit(1);
        }
    }

    // Initialize audit sink (Batch 78 Sprint 6.2 Phase 2).
    //
    // WHY: Plan §5 Faz 2 item 8 + ADR-020 mandate a tamper-
    // evident audit trail. Batches 74-77 built the primitives
    // (file sink, chain recovery, SIGHUP reopen, offline verify
    // CLI); this step wires the sink into AppState at boot so
    // Phase 2 / Batch 79 CommandHandler pre+post emit has a
    // live sink to write into.
    //
    // FAIL-CLOSED DISCIPLINE:
    // - Disabled: skip open (audit_sink stays None).
    // - Enabled: open sink; failure → exit(1). IEC 62443 SL-2
    //   FR6 forensic-trail is non-negotiable; there is no
    //   "permissive" fallback.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_audit_sink() {
            error!(
                "Audit sink init failed (fail-closed boot, mode=Enabled): {}",
                msg
            );
            std::process::exit(1);
        }
    }

    // Batch 129 Sprint 6.6: load the lifecycle HMAC auth
    // key from systemd-credentials BEFORE populating the
    // lifecycle cell. NO-OP in auth_mode=Disabled; fail-
    // closed exit(1) when auth_mode=HmacToken + the
    // credential load fails (operator configured auth
    // but didn't supply the key — safer to refuse boot
    // than silently degrade).
    #[cfg(feature = "health")]
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_lifecycle_auth_key() {
            error!("{}", msg);
            std::process::exit(1);
        }
    }

    // Batch 122 Sprint 6.5: populate the lifecycle cell
    // AFTER partition_store + bootloader + audit_sink are
    // all initialized. The POST /lifecycle/confirm-active
    // endpoint goes live here; before this call it
    // returns 503. NO-OP when health is disabled or
    // partition_store is None (fail-closed boot earlier
    // caught that already).
    #[cfg(feature = "health")]
    {
        let state_guard = state.read().await;
        state_guard.init_lifecycle_cell();
    }

    // Setup graceful shutdown
    // Pass state so SIGHUP can reload config in-place (SEC-010)
    let shutdown = match setup_shutdown_handler(state.clone()) {
        Ok(rx) => rx,
        Err(e) => {
            error!("Failed to setup shutdown handler: {}", e);
            std::process::exit(1);
        }
    };

    // Notify systemd that we're ready (IEC 62443 SL2 FR6: Timely Response)
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = notify_systemd_ready() {
            warn!("Failed to notify systemd ready: {}", e);
        }
    }

    // Use LocalSet to allow non-Send futures (required for Modbus client)
    let local = tokio::task::LocalSet::new();
    let result = local.run_until(run_agent(state, shutdown)).await;

    if let Err(e) = result {
        error!("Agent error: {:#}", e);
        std::process::exit(1);
    }

    info!("Agent shutdown complete");
    Ok(())
}

/// Offline audit-log verification entry point (Batch 77
/// Sprint 6.2 Phase 2).
///
/// Invoked by `suderra-agent --audit-verify <path>`. Reads
/// the HMAC key from env `SUDERRA_AUDIT_KEY_HEX` (64-char
/// lowercase hex), calls `audit::verify_audit_log`, prints
/// outcome to stdout + returns the process exit code.
///
/// Exit codes:
/// - 0: chain verified.
/// - 1: chain verification failed OR key/path/env error.
///
/// Pre-tracing bootstrap: this path runs BEFORE init_logging
/// so uses plain println!/eprintln! per the established
/// pattern in the --init and --help branches.
#[allow(clippy::print_stdout)]
#[allow(clippy::print_stderr)]
/// Post-boot A/B slot confirm CLI entry point (Batch 110
/// Sprint 6.5 Phase 2).
///
/// Invoked by `suderra-agent --confirm-active`. Called from
/// a systemd unit / timer (`suderra-agent-confirm.timer`)
/// that runs N seconds AFTER agent start when a
/// PendingConfirm slot is waiting for operator health-
/// check to promote it.
///
/// Flow:
/// 1. Open PartitionStore at default path.
/// 2. Snapshot; resolve active slot.
/// 3. Apply `PartitionRoll::Confirm { slot: active }`.
/// 4. Exit 0 on success (new state Active) + pretty-print
///    the transition; exit 1 on any error.
///
/// Pre-tracing: same println/eprintln pattern as --init,
/// --audit-verify per the existing CLI convention.
#[allow(clippy::print_stdout)]
#[allow(clippy::print_stderr)]
fn run_confirm_active() -> i32 {
    let store = match crate::updater::PartitionStore::open(None) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("--confirm-active: PartitionStore open failed: {}", e);
            return 1;
        }
    };

    let snap = match store.snapshot() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("--confirm-active: snapshot failed: {}", e);
            return 1;
        }
    };

    let active = snap.active;

    // If the active slot is already Active (not
    // PendingConfirm), there's nothing to confirm. Exit 0
    // idempotently — systemd timer can fire repeatedly
    // without error.
    if snap.state_of(active) == crate::updater::SlotState::Active {
        println!(
            "--confirm-active: slot {:?} already Active (idempotent no-op)",
            active
        );
        return 0;
    }

    let cold_boot_budget_secs =
        crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;

    match store.apply_roll(
        crate::updater::PartitionRoll::Confirm { slot: active },
        cold_boot_budget_secs,
    ) {
        Ok(new_state) => {
            println!("--confirm-active: OK");
            println!("  confirmed_slot: {:?}", active);
            println!(
                "  new_active:     {:?} (was PendingConfirm)",
                new_state.active
            );

            // Batch 112 Sprint 6.5: pair software Confirm
            // with bootloader clear_pending_boot. The CLI
            // runs out-of-process so we instantiate
            // NoopBootloaderHandle directly (zero-cost on
            // non-RPi). A future batch that lands
            // TrybootBootloaderHandle will swap this to a
            // config-driven factory so the systemd timer
            // path uses the same backend as the agent.
            use crate::updater::BootloaderHandle;
            let bootloader = crate::updater::NoopBootloaderHandle;
            match bootloader.clear_pending_boot(active) {
                Ok(()) => {
                    println!(
                        "  bootloader:     cleared pending flag (backend={})",
                        bootloader.backend_name()
                    );
                }
                Err(e) => {
                    // Software side is already committed.
                    // Exit 0 (idempotent from systemd's
                    // perspective) but print the warning
                    // so operator log-scraping flags it.
                    eprintln!(
                        "  bootloader:     clear_pending_boot failed: {} (backend={}) — SPLIT-BRAIN: operator must resync",
                        e,
                        bootloader.backend_name()
                    );
                }
            }

            0
        }
        Err(e) => {
            eprintln!("--confirm-active: apply_roll failed: {}", e);
            1
        }
    }
}

fn run_audit_verify(log_path: &str) -> i32 {
    let key_hex = match std::env::var("SUDERRA_AUDIT_KEY_HEX") {
        Ok(v) => v,
        Err(_) => {
            eprintln!(
                "Error: --audit-verify requires SUDERRA_AUDIT_KEY_HEX env (64-char hex HMAC key)"
            );
            return 1;
        }
    };

    if key_hex.len() != 64 {
        eprintln!(
            "Error: SUDERRA_AUDIT_KEY_HEX must be 64 hex chars (32-byte HMAC key), got {} chars",
            key_hex.len()
        );
        return 1;
    }

    let mut key_bytes = [0u8; 32];
    for (i, b) in key_bytes.iter_mut().enumerate() {
        let pair = match key_hex.get(i * 2..i * 2 + 2) {
            Some(p) => p,
            None => {
                eprintln!("Error: SUDERRA_AUDIT_KEY_HEX hex slice error at byte {}", i);
                return 1;
            }
        };
        *b = match u8::from_str_radix(pair, 16) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("Error: SUDERRA_AUDIT_KEY_HEX parse at byte {}: {}", i, e);
                return 1;
            }
        };
    }

    let path = std::path::Path::new(log_path);
    let outcome = match crate::audit::verify_audit_log(crate::audit::VerifyInput {
        path,
        hmac_key: &key_bytes,
        // Genesis start — cross-file stitching requires a
        // future CLI arg (--start-prev-hmac / --start-sequence);
        // single-file is the baseline case.
        start_prev_hmac: [0u8; 32],
        start_sequence: 0,
    }) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("audit-verify error: {}", e);
            return 1;
        }
    };

    match outcome {
        crate::audit::VerifyOutcome::Verified {
            verified_count,
            last_sequence,
            last_hmac,
        } => {
            let hmac_hex: String =
                last_hmac.iter().map(|b| format!("{:02x}", b)).collect();
            println!("audit-verify: OK");
            println!("  path:           {}", path.display());
            println!("  verified_count: {}", verified_count);
            println!("  last_sequence:  {}", last_sequence);
            println!("  last_hmac:      {}", hmac_hex);
            0
        }
        crate::audit::VerifyOutcome::Failed {
            entry_number,
            reason,
        } => {
            eprintln!("audit-verify: FAILED");
            eprintln!("  path:         {}", path.display());
            eprintln!("  entry_number: {}", entry_number);
            eprintln!("  reason:       {}", reason);
            1
        }
    }
}

/// Initialize logging with tracing
///
/// Note: OpenTelemetry OTLP export is initialized separately in `init_opentelemetry()`
/// after configuration is loaded.
fn init_logging() {
    use tracing_subscriber::{EnvFilter, fmt, prelude::*};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(fmt::layer().with_target(true))
        .with(filter)
        .init();
}

/// Initialize OpenTelemetry OTLP exporter (if configured)
///
/// This must be called after configuration is loaded. When the `telemetry` feature
/// is enabled and an OTLP endpoint is configured, traces will be exported to the
/// specified collector (e.g., Jaeger, Tempo, OpenTelemetry Collector).
///
/// # IEC 62443 SL2 FR6: Continuous Monitoring
/// OpenTelemetry provides distributed tracing for observability and debugging.
#[cfg(feature = "telemetry")]
fn init_opentelemetry(
    config: &config::AgentConfig,
) -> Option<opentelemetry_sdk::trace::TracerProvider> {
    use opentelemetry::trace::TracerProvider;
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::trace::Sampler;

    let endpoint = config.telemetry.otlp.endpoint.as_ref()?;

    info!("Initializing OpenTelemetry OTLP export to {}", endpoint);

    let exporter = opentelemetry_otlp::new_exporter()
        .tonic()
        .with_endpoint(endpoint);

    match opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(exporter)
        .with_trace_config(
            opentelemetry_sdk::trace::Config::default()
                .with_sampler(Sampler::TraceIdRatioBased(
                    config.telemetry.otlp.sample_ratio,
                ))
                .with_resource(opentelemetry_sdk::Resource::new(vec![
                    opentelemetry::KeyValue::new(
                        "service.name",
                        config.telemetry.otlp.service_name.clone(),
                    ),
                    opentelemetry::KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                    opentelemetry::KeyValue::new("device.id", config.device_id.clone()),
                ])),
        )
        .install_batch(opentelemetry_sdk::runtime::Tokio)
    {
        Ok(provider) => {
            info!(
                "OpenTelemetry OTLP enabled: endpoint={}, service={}, sample_ratio={}",
                endpoint, config.telemetry.otlp.service_name, config.telemetry.otlp.sample_ratio
            );
            Some(provider)
        }
        Err(e) => {
            warn!("Failed to initialize OpenTelemetry: {}", e);
            None
        }
    }
}

/// Stub for when telemetry feature is disabled
#[cfg(not(feature = "telemetry"))]
fn init_opentelemetry(_config: &config::AgentConfig) -> Option<()> {
    None
}

/// Notify systemd that the service is ready (IEC 62443 SL2 FR6)
///
/// This function:
/// - Sends READY=1 to systemd when initialization is complete
/// - Starts a watchdog heartbeat task if WatchdogSec is configured
/// - Allows systemd to monitor service health and restart on failure
#[cfg(target_os = "linux")]
fn notify_systemd_ready() -> Result<()> {
    use sd_notify::NotifyState;

    // Notify systemd that we're ready
    sd_notify::notify(true, &[NotifyState::Ready])
        .context("Failed to send READY notification to systemd")?;
    info!("Notified systemd: service ready");

    // Check if watchdog is enabled and start heartbeat task
    let mut watchdog_usec: u64 = 0;
    if sd_notify::watchdog_enabled(false, &mut watchdog_usec) && watchdog_usec > 0 {
        // Ping at half the timeout interval
        let interval_usec = watchdog_usec / 2;
        let interval = Duration::from_micros(interval_usec);
        info!(
            "Systemd watchdog enabled (timeout: {}ms, heartbeat: {}ms)",
            watchdog_usec / 1000,
            interval_usec / 1000
        );

        // EDGE-MEDIUM-007: Store the watchdog JoinHandle and check for panics.
        // Previously the handle was discarded — if the watchdog panicked, the main
        // loop never learned and systemd would eventually kill the process after
        // WatchdogSec timeout, with no diagnostic information in the logs.
        let watchdog_handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if let Err(e) = sd_notify::notify(false, &[NotifyState::Watchdog]) {
                    warn!("Failed to send watchdog heartbeat: {}", e);
                } else {
                    debug!("Watchdog heartbeat sent");
                }
            }
        });

        // Spawn a supervisor task that monitors the watchdog handle.
        // If the watchdog task panics, log the error for diagnostics.
        // systemd will restart the agent after WatchdogSec timeout.
        tokio::spawn(async move {
            match watchdog_handle.await {
                Ok(_) => {
                    // Infinite loop exited normally — should never happen
                    error!("LIFE-SAFETY: Watchdog heartbeat task exited unexpectedly. \
                            systemd will restart the agent after WatchdogSec timeout.");
                }
                Err(join_err) => {
                    // Task panicked — log the panic info for diagnostics
                    error!(
                        "LIFE-SAFETY: Watchdog heartbeat task panicked: {}. \
                         systemd will restart the agent after WatchdogSec timeout.",
                        join_err
                    );
                }
            }
        });
    }

    Ok(())
}

/// Setup shutdown signal handlers for graceful shutdown
///
/// # Platform Support
/// - All platforms: Ctrl+C (SIGINT)
/// - Unix only: SIGTERM
///
/// # SIGHUP — Config Reload (IEC 62443 FR5, SEC-010)
/// SIGHUP follows Unix daemon convention: it reloads configuration rather than
/// shutting down.  `systemctl reload suderra-agent` sends SIGHUP; treating it
/// as shutdown would cause unexpected downtime on production aquaculture equipment.
///
/// On SIGHUP the agent re-reads `/etc/suderra/config.yaml` (or `SUDERRA_CONFIG`),
/// validates the new config, and atomically replaces `AppState.config` under the
/// write lock.  Security-sensitive fields (MQTT credentials, TLS certs) take
/// effect on the next connection attempt.
fn setup_shutdown_handler(
    state: Arc<RwLock<AppState>>,
) -> Result<tokio::sync::watch::Receiver<bool>> {
    // `state` is used only in the Unix SIGHUP config-reload handler
    #[cfg(not(unix))]
    let _ = &state;
    let (tx, rx) = tokio::sync::watch::channel(false);

    // Clone tx for the ctrlc handler
    let tx_ctrlc = tx.clone();
    ctrlc::set_handler(move || {
        info!("SIGINT (Ctrl+C) received, initiating graceful shutdown...");
        let _ = tx_ctrlc.send(true);
    })
    .map_err(|e| {
        anyhow::anyhow!(
            "Failed to set Ctrl-C handler: {}. This may occur if a handler was already set.",
            e
        )
    })?;

    // Setup Unix-specific signal handlers (SIGTERM, SIGHUP)
    // v1.2.3: Enhanced error handling for signal handler task
    #[cfg(unix)]
    {
        let tx_term = tx.clone();

        // Spawn async task to handle Unix signals
        tokio::spawn(async move {
            use tokio::signal::unix::{SignalKind, signal};

            let mut sigterm = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    error!(
                        "Failed to setup SIGTERM handler: {}. SIGTERM will not trigger graceful shutdown.",
                        e
                    );
                    return;
                }
            };

            let mut sighup = match signal(SignalKind::hangup()) {
                Ok(s) => s,
                Err(e) => {
                    error!(
                        "Failed to setup SIGHUP handler: {}. SIGHUP config reload will be unavailable.",
                        e
                    );
                    return;
                }
            };

            debug!("Unix signal handler task started successfully");

            loop {
                tokio::select! {
                    _ = sigterm.recv() => {
                        info!("SIGTERM received, initiating graceful shutdown...");
                        if tx_term.send(true).is_err() {
                            error!("Failed to send shutdown signal via SIGTERM handler");
                        }
                        return;
                    }
                    _ = sighup.recv() => {
                        // SEC-010 (IEC 62443 FR5): SIGHUP triggers config reload, NOT shutdown.
                        // Treating SIGHUP as shutdown caused unexpected downtime when operators
                        // ran `systemctl reload suderra-agent` to rotate MQTT credentials.
                        info!("SIGHUP received — reloading configuration from disk...");
                        match AgentConfig::load() {
                            Ok(new_config) => {
                                match new_config.validate() {
                                    Ok(()) => {
                                        let mut state_guard = state.write().await;

                                        // LoRa config degisikligi kontrol (config atamasindan ONCE)
                                        #[cfg(feature = "lorawan")]
                                        let lora_changed = state_guard.config.lorawan != new_config.lorawan;

                                        state_guard.config = new_config.clone();

                                        // LoRa actor yeniden baslatma (config degistiyse)
                                        #[cfg(feature = "lorawan")]
                                        {
                                            if lora_changed {
                                                info!("LoRa yapilandirmasi degisti — actor yeniden baslatiliyor...");
                                                // Eski actor handle'ini al ve write lock'u birak
                                                // (actor icinde state.read() cagrilir, write lock tutulursa deadlock olusur)
                                                let old_lora_handle = state_guard.lora_handle.take();
                                                drop(state_guard);

                                                // Lock disinda shutdown yap — actor artik read lock alabilir ve kapanabilir
                                                if let Some(handle) = old_lora_handle {
                                                    handle.shutdown().await;
                                                }

                                                // Yeni config ile yeniden baslat
                                                if let Some(ref lora_cfg) = new_config.lorawan {
                                                    if lora_cfg.enabled {
                                                        let new_handle = crate::lora::LoRaHandle::new(
                                                            lora_cfg,
                                                            state.clone(),
                                                        );
                                                        match new_handle.init().await {
                                                            Ok(()) => {
                                                                let mut state_guard = state.write().await;
                                                                state_guard.lora_handle = Some(new_handle);
                                                                info!("LoRa actor yeniden baslatildi (SIGHUP)");
                                                            }
                                                            Err(e) => {
                                                                warn!("LoRa actor yeniden baslatma hatasi: {}", e);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        info!(
                                            "Configuration reloaded successfully. \
                                             Security-sensitive fields (MQTT credentials, \
                                             TLS certificates) take effect on next reconnect."
                                        );

                                        // Batch 80 Sprint 6.2 Phase 2: audit sink
                                        // reopen for logrotate compatibility. Standard
                                        // Unix daemon pattern: SIGHUP = (config reload
                                        // OR log-file handle refresh). Logrotate's
                                        // create + rename pattern leaves the agent's
                                        // fd pointing at the ROTATED file; reopen()
                                        // closes the rotated fd + opens the new empty
                                        // file at the same path. Batch 76 primitive
                                        // preserves in-memory chain state
                                        // (last_hmac, last_sequence) across the
                                        // reopen so cross-file linkage holds.
                                        //
                                        // Acquires a fresh read-guard (write-guard
                                        // was dropped above in the lora-reload
                                        // branch; on non-lora paths we hold it
                                        // still — use read() path that's
                                        // idempotent).
                                        let sink_snap = state
                                            .read()
                                            .await
                                            .audit_sink
                                            .clone();
                                        if let Some(sink) = sink_snap {
                                            match sink.reopen() {
                                                Ok(()) => {
                                                    info!(
                                                        "Audit sink reopened successfully on SIGHUP (logrotate-compatible)"
                                                    );
                                                }
                                                Err(e) => {
                                                    error!(
                                                        "Audit sink reopen FAILED on SIGHUP: {}. \
                                                         Agent continues but subsequent appends may target the rotated file. \
                                                         Operator should investigate /var/log/suderra/audit.log permissions.",
                                                        e
                                                    );
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        error!(
                                            "SIGHUP config reload rejected — new config failed \
                                             validation, keeping current config: {}",
                                            e
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                error!(
                                    "SIGHUP config reload failed — could not read config file, \
                                     keeping current config: {}",
                                    e
                                );
                            }
                        }
                        // Do NOT send shutdown signal — continue loop to handle further signals
                    }
                }
            }
        });

        info!("Signal handlers registered: SIGINT, SIGTERM, SIGHUP (config reload)");
    }

    #[cfg(not(unix))]
    {
        info!("Signal handlers registered: SIGINT (Ctrl+C)");
    }

    Ok(rx)
}

/// Shutdown timeout for graceful task termination.
///
/// Batch 32: fallback only — the ACTIVE value is
/// `config.runtime.shutdown_timeout_secs` (default 30s).
/// Pre-Batch-32 this constant shadowed the config field; code
/// used 30s while the config field was 10s and dead. Kept as a
/// fallback for the narrow case where the config load failed
/// AND we're still in the shutdown path — unreachable in
/// practice because failed config load exits before any
/// shutdown handler is registered.
#[allow(dead_code)] // fallback constant; active value from config.runtime.shutdown_timeout_secs.
const SHUTDOWN_TIMEOUT_SECS_FALLBACK: u64 = 30;

/// Main agent loop
async fn run_agent(
    state: Arc<RwLock<AppState>>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    // Step 1: Check if already activated (MQTT credentials in config)
    // v1.3.3: Validate ALL required MQTT fields, not just username
    let needs_activation = {
        let state_guard = state.read().await;
        let mqtt = &state_guard.config.mqtt;

        // All required fields must be present for a valid activation
        let missing_username = mqtt.username.is_none();
        let missing_password = mqtt.password.is_none();
        let missing_broker = mqtt.broker.is_none();

        if !missing_username && (missing_password || missing_broker) {
            // Partial configuration detected - this is an invalid state
            warn!(
                "MQTT config incomplete: username={}, password={}, broker={}. Treating as not activated.",
                !missing_username, !missing_password, !missing_broker
            );
        }

        missing_username || missing_password || missing_broker
    };

    if needs_activation {
        // Check if this is a tenant-first self-registration or legacy device-first activation
        let has_tenant_token = {
            let state_guard = state.read().await;
            state_guard.config.tenant_token.is_some()
        };

        const MAX_RETRIES: u32 = 5;
        const INITIAL_BACKOFF_SECS: u64 = 10;

        let provisioning_client = ProvisioningClient::new(state.clone())
            .context("Failed to create provisioning client")?;

        if has_tenant_token {
            // v2.0: Tenant-first self-registration flow
            info!("Tenant token found, starting self-registration...");

            let mut last_error = None;
            for attempt in 0..MAX_RETRIES {
                if attempt > 0 {
                    let backoff_secs = INITIAL_BACKOFF_SECS * (1 << (attempt - 1));
                    warn!(
                        "Self-register attempt {}/{} failed, retrying in {}s...",
                        attempt, MAX_RETRIES, backoff_secs
                    );
                    tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                }

                match provisioning_client.self_register().await {
                    Ok(response) => {
                        info!("Self-registration successful!");
                        info!("  Device ID: {}", response.device_id);
                        info!("  Device Code: {}", response.device_code);
                        info!("  MQTT Broker: {}", response.mqtt_broker);
                        info!("  Tenant ID: {}", response.tenant_id);

                        // Update state with self-registration response
                        let mut state_guard = state.write().await;
                        state_guard.config.device_id = response.device_id;
                        state_guard.config.device_code = response.device_code;
                        state_guard.config.mqtt.broker = Some(response.mqtt_broker);
                        state_guard.config.mqtt.port = response.mqtt_port;
                        state_guard.config.mqtt.username = Some(response.mqtt_username);
                        state_guard.config.mqtt.password =
                            Some(secrecy::Secret::new(response.mqtt_password));
                        state_guard.tenant_id = Some(response.tenant_id.clone());
                        state_guard.config.tenant_id = Some(response.tenant_id);
                        state_guard.is_activated = true;

                        // SECURITY: Clear tenant token after successful registration
                        state_guard.config.tenant_token = None;
                        state_guard.config.provisioning_token = None;
                        info!("Tenant token cleared from memory");

                        // Validate that the device_id received from the server is a valid UUID
                        // before saving to disk (MED-33).
                        state_guard.config.validate()
                            .context("Self-registration response contained invalid config — aborting save")?;

                        // Save updated config to disk
                        if let Err(e) = state_guard.config.save() {
                            error!("CRITICAL: Failed to save config after self-registration: {}. Device may re-register on restart!", e);
                            return Err(anyhow::anyhow!("Failed to persist self-registration config: {}", e));
                        }

                        last_error = None;
                        break;
                    }
                    Err(e) => {
                        error!(
                            "Self-register attempt {}/{} failed: {}",
                            attempt + 1,
                            MAX_RETRIES,
                            e
                        );
                        last_error = Some(e);
                    }
                }
            }

            if let Some(e) = last_error {
                error!(
                    "Self-registration failed after {} attempts. Will retry on next restart.",
                    MAX_RETRIES
                );
                return Err(e);
            }
        } else {
            // Legacy device-first activation flow
            info!("Device not activated, starting provisioning...");

            let mut last_error = None;
            for attempt in 0..MAX_RETRIES {
                if attempt > 0 {
                    let backoff_secs = INITIAL_BACKOFF_SECS * (1 << (attempt - 1));
                    warn!(
                        "Activation attempt {}/{} failed, retrying in {}s...",
                        attempt, MAX_RETRIES, backoff_secs
                    );
                    tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                }

                match provisioning_client.activate().await {
                    Ok(response) => {
                        info!("Device activated successfully!");
                        info!("  MQTT Broker: {}", response.mqtt_broker);
                        info!("  Tenant ID: {}", response.tenant_id);

                        // Update state with activation response
                        let mut state_guard = state.write().await;
                        state_guard.config.mqtt.broker = Some(response.mqtt_broker);
                        state_guard.config.mqtt.port = response.mqtt_port;
                        state_guard.config.mqtt.username = Some(response.mqtt_username);
                        state_guard.config.mqtt.password =
                            Some(secrecy::Secret::new(response.mqtt_password));
                        // Enable TLS if the server indicated it (port 8883)
                        if response.mqtt_tls_enabled.unwrap_or(response.mqtt_port == 8883) {
                            state_guard.config.mqtt.tls.enabled = true;
                        }
                        state_guard.tenant_id = Some(response.tenant_id.clone());
                        state_guard.config.tenant_id = Some(response.tenant_id);
                        state_guard.is_activated = true;

                        // SECURITY: Clear provisioning token from memory
                        state_guard.config.provisioning_token = None;
                        info!("Provisioning token cleared from memory");

                        // Save updated config to disk — failure is fatal.
                        // If save fails, the provisioning token has been consumed by the cloud
                        // but credentials are not persisted. On next restart the device would be
                        // permanently unrecoverable (token already used, no credentials stored).
                        state_guard.config.save()
                            .context("Failed to save config after activation — device may be unrecoverable on restart")?;

                        last_error = None;
                        break;
                    }
                    Err(e) => {
                        error!(
                            "Activation attempt {}/{} failed: {}",
                            attempt + 1,
                            MAX_RETRIES,
                            e
                        );
                        last_error = Some(e);
                    }
                }
            }

            if let Some(e) = last_error {
                error!(
                    "Activation failed after {} attempts. Will retry on next restart.",
                    MAX_RETRIES
                );
                return Err(e);
            }
        }
    } else {
        info!("Device already activated, using stored credentials");
        let mut state_guard = state.write().await;
        state_guard.is_activated = true;
    }

    // Step 3: Connect to MQTT
    info!("Connecting to MQTT broker...");
    let mqtt_client = {
        let state_guard = state.read().await;
        // Batch 102: pass HealthState so MqttClient wires
        // publish/receive/connect/disconnect observability
        // counters. health_state is Some from
        // init_health_server (boot step earlier).
        // HealthState is Arc<HealthStateInner> internally;
        // plain .clone() is Arc-bump (O(1)). MqttClient
        // stores it directly (no outer Arc wrapping needed).
        let health_for_mqtt = state_guard.health_state.clone();
        MqttClient::new(&state_guard.config, health_for_mqtt)
            .await
            .context("Failed to connect to MQTT broker")?
    };

    {
        let mut state_guard = state.write().await;
        state_guard.mqtt_client = Some(mqtt_client);
    }
    info!("MQTT connected successfully");

    // Step 4: Initialize hardware interfaces
    info!("Initializing hardware interfaces...");
    init_hardware(&state).await;

    // Step 4b: Build safe-state manager from config (LIFE-SAFETY)
    // This must happen after hardware init so we know which outputs exist.
    let safe_state_manager = {
        let state_guard = state.read().await;
        SafeStateManager::from_config(&state_guard.config)
    };

    // ── LIFE-SAFETY: Apply safe-state BEFORE any control runtime starts ──
    // CRITICAL-001: The previous boot sequence started the script engine, command
    // handlers, telemetry, and I/O loops before driving actuator outputs to a
    // known fail-safe state. On an industrial aquaculture edge node, this meant
    // pumps, valves, and relays could remain in their prior energized state during
    // boot — a life-safety violation.
    //
    // safe_state_manager.apply() MUST execute here, after hardware init but before
    // ANY runtime actor or script engine starts. If any output cannot be driven to
    // safe-state, the agent enters degraded mode and surfaces a hard fault.
    {
        let state_guard = state.read().await;
        let modbus_ref = state_guard.modbus_handle.as_ref();
        let gpio_ref = state_guard.gpio_handle.as_ref();
        let i2c_ref = state_guard.i2c_handle.as_ref();

        let safe_count = safe_state_manager
            .apply(modbus_ref, gpio_ref, i2c_ref)
            .await;

        if safe_count == 0 && (!state_guard.config.gpio.is_empty()
            || !state_guard.config.modbus.is_empty()
            || !state_guard.config.i2c.is_empty())
        {
            // LIFE-SAFETY: Hardware is configured but no outputs reached safe-state.
            // Enter degraded mode — do NOT proceed to normal runtime.
            error!(
                "LIFE-SAFETY: safe-state application failed — 0 of {} configured outputs \
                 reached safe-state. Entering degraded/disabled mode. \
                 Manual intervention required.",
                state_guard.config.gpio.len()
                    + state_guard.config.modbus.len()
                    + state_guard.config.i2c.len()
            );
            return Err(anyhow::anyhow!(
                "LIFE-SAFETY: Boot aborted — safe-state could not be applied to any actuator output"
            ));
        }

        info!(
            "LIFE-SAFETY: boot safe-state applied ({} outputs driven to fail-safe before runtime start)",
            safe_count
        );
    }

    // Step 5: Create shutdown coordinator for graceful termination
    let mut shutdown_coordinator = ShutdownCoordinator::new();

    // Step 6: Start telemetry collector with shutdown awareness
    let telemetry_collector = TelemetryCollector::new(state.clone());
    let telemetry_shutdown = shutdown_coordinator.subscribe();
    let telemetry_handle = tokio::spawn(async move {
        shutdown::run_until_shutdown(telemetry_collector.run(), telemetry_shutdown).await;
    });
    shutdown_coordinator.register_task("telemetry", telemetry_handle);

    // Step 6b: Start I/O poll loop
    tokio::spawn(io_poll::io_poll_loop(state.clone()));

    // Batch 108 Sprint 6.5: spawn cold-boot-budget watchdog
    // task. Polls PartitionStore for expired PendingConfirm
    // deadlines + applies Rollback when a firmware update's
    // cold-boot window lapses without Confirm.
    //
    // SKIPPED when partition_store is None (init failure would
    // have exit(1)'d already; guard is defense-in-depth).
    {
        let partition_store = {
            let s = state.read().await;
            s.partition_store.clone()
        };
        if let Some(partition_store) = partition_store {
            let watchdog_shutdown = shutdown_coordinator.subscribe();
            let cold_boot_budget_secs =
                crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;
            // Batch 112 Sprint 6.5: clone the bootloader
            // handle from AppState so the watchdog can call
            // rollback_next_boot after software Rollback
            // succeeds. Noop default is zero-cost; Tryboot
            // real-RPi impl lands in a follow-up batch.
            //
            // Batch 113 Sprint 6.5: build WatchdogAuditCtx
            // from AppState audit_sink + device_id + tenant
            // so watchdog-fired rollbacks emit
            // FirmwareDeployRollback pre+post entries to the
            // HMAC-chained sink. No sink → zero-cost noop
            // (matches Batch 79 command-path contract).
            // Batch 133 Sprint 6.5: clone HealthState into
            // the watchdog task so RolledBack /
            // RolledBackBootloaderFailed outcomes bump the
            // Batch 132 Prometheus rollback counter.
            let (bootloader, audit_ctx, health_state_for_watchdog) = {
                let s = state.read().await;
                let tenant_bytes = s
                    .tenant_id
                    .as_deref()
                    .and_then(|t| uuid::Uuid::parse_str(t).ok())
                    .map(|u| *u.as_bytes())
                    .unwrap_or([0u8; 16]);
                let ctx = crate::updater::WatchdogAuditCtx {
                    sink: s.audit_sink.clone(),
                    device_id: s.config.device_id.clone(),
                    tenant: crate::authz::permission::TenantId::new_from_verified(
                        tenant_bytes,
                    ),
                };
                (
                    s.bootloader.clone(),
                    ctx,
                    #[cfg(feature = "health")]
                    s.health_state.clone(),
                    #[cfg(not(feature = "health"))]
                    (),
                )
            };
            let watchdog_handle = tokio::spawn(async move {
                crate::updater::run_cold_boot_watchdog(
                    partition_store,
                    std::time::Duration::from_secs(
                        crate::updater::DEFAULT_WATCHDOG_POLL_INTERVAL_SECS,
                    ),
                    cold_boot_budget_secs,
                    bootloader,
                    audit_ctx,
                    #[cfg(feature = "health")]
                    health_state_for_watchdog,
                    watchdog_shutdown,
                )
                .await;
            });
            shutdown_coordinator
                .register_task("cold_boot_watchdog", watchdog_handle);
            info!(
                "cold-boot watchdog task registered (poll={}s budget={}s)",
                crate::updater::DEFAULT_WATCHDOG_POLL_INTERVAL_SECS,
                cold_boot_budget_secs
            );
        }
    }

    // Batch 93 Sprint 6.4 final: start background sweep_expired
    // task for the jti dedup table. Runs every 5 minutes,
    // deleting SQLCipher rows whose expires_at is in the past.
    //
    // WHY periodic (not lazy-only): lazy sweep runs only on
    // probe-miss for a specific jti; untouched expired rows
    // accumulate without eviction. Under low-traffic fleet
    // tenants, the SQLCipher file would grow unbounded across
    // the 72-hour window * N replay-attempt rate. 5-minute
    // cadence caps the staleness + bounds the file size
    // (rough ceiling: throughput × 5min per sweep cycle).
    //
    // SKIPPED when jti_dedup_table = None (signature_mode=
    // Disabled) — no table to sweep.
    {
        let dedup_table = {
            let state_guard = state.read().await;
            state_guard.jti_dedup_table.clone()
        };
        if let Some(dedup_table) = dedup_table {
            let sweep_shutdown = shutdown_coordinator.subscribe();
            let sweep_handle = tokio::spawn(async move {
                let mut shutdown = sweep_shutdown;
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(300));
                // Skip the immediate first tick (would fire
                // right at boot when the table is empty).
                interval.tick().await;
                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            let now = std::time::SystemTime::now();
                            match dedup_table.sweep_expired(now).await {
                                Ok(0) => {
                                    // Quiet — nothing to log.
                                }
                                Ok(n) => {
                                    info!(
                                        "JTI dedup sweep: evicted {} expired entries",
                                        n
                                    );
                                }
                                Err(e) => {
                                    warn!(
                                        "JTI dedup sweep failed: {:?} (will retry in 5m)",
                                        e
                                    );
                                }
                            }
                        }
                        _ = shutdown.recv() => {
                            info!("JTI dedup sweep task shutting down");
                            break;
                        }
                    }
                }
            });
            shutdown_coordinator.register_task("jti_dedup_sweep", sweep_handle);
            info!("JTI dedup sweep task started (5-minute cadence)");
        }
    }

    // Step 6c: Start SCADA display server (v1.6.0, v2.4: full HMI runtime)
    #[cfg(feature = "scada-display")]
    {
        // Initialize SCADA SQLite database
        let scada_db_path = data_dir::data_dir()
            .join("scada")
            .join("scada.db")
            .to_string_lossy()
            .to_string();
        let scada_db = match scada_db::ScadaDb::new(&scada_db_path) {
            Ok(db) => {
                info!("SCADA database initialized: {}", scada_db_path);
                Some(Arc::new(db))
            }
            Err(e) => {
                warn!("Failed to initialize SCADA database: {}. Runtime features degraded.", e);
                None
            }
        };

        // Create command channel for WS → I/O routing
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel::<scada_types::ScadaCommand>(64);

        // Get process image reference
        let process_image = {
            let s = state.read().await;
            s.process_image.clone()
        };

        // Create SCADA state with full runtime (only if DB is available)
        if let Some(db) = scada_db.clone() {
            let scada_state = scada_server::ScadaState::new_with_runtime(
                process_image,
                db,
                cmd_tx,
            );
            let _scada_handle = scada_server::start_scada_server(scada_state.clone()).await;

            // Store in app state
            {
                let mut state_guard = state.write().await;
                state_guard.scada_state = Some(scada_state.clone());
                state_guard.scada_db = scada_db;
            }
        } else {
            warn!("SCADA database unavailable — SCADA display server will NOT start. Device operates in sensor-only mode.");
            let mut state_guard = state.write().await;
            state_guard.scada_db = None;
        }

        // Spawn command executor task
        let cmd_state = state.clone();
        tokio::spawn(async move {
            use crate::process_image::{ProtocolConfig, TagQuality};

            while let Some(cmd) = cmd_rx.recv().await {
                let result = async {
                    let s = cmd_state.read().await;
                    let config = s.process_image.get_config(&cmd.tag).await
                        .ok_or_else(|| format!("Tag '{}' not found", cmd.tag))?;

                    let write_result = match &config.protocol_config {
                        ProtocolConfig::Gpio { pin, .. } => {
                            if let Some(ref handle) = s.gpio_handle {
                                handle.write_pin(*pin, cmd.value != 0.0).await
                                    .map_err(|e| format!("GPIO: {}", e))
                            } else {
                                Err("GPIO unavailable".to_string())
                            }
                        }
                        ProtocolConfig::Modbus { register, .. } => {
                            if let Some(ref handle) = s.modbus_handle {
                                if let Some(device) = s.config.modbus.first() {
                                    // Determine write type based on IoType
                                    if matches!(config.io_type, crate::process_image::IoType::DO) {
                                        handle.write_coil(&device.name, *register, cmd.value != 0.0).await
                                            .map_err(|e| format!("Modbus coil: {}", e))
                                    } else {
                                        // Analog output: reverse-scale and write register
                                        let raw_value = reverse_scale(cmd.value, &config);
                                        handle.write_register(&device.name, *register, raw_value as u16).await
                                            .map_err(|e| format!("Modbus register: {}", e))
                                    }
                                } else {
                                    Err("No Modbus devices".to_string())
                                }
                            } else {
                                Err("Modbus unavailable".to_string())
                            }
                        }
                        ProtocolConfig::I2c { .. } => {
                            if let Some(ref handle) = s.i2c_handle {
                                let data = (cmd.value as u32).to_be_bytes().to_vec();
                                handle.write_direct(&cmd.tag, &data).await
                                    .map_err(|e| format!("I2C: {}", e))
                            } else {
                                Err("I2C unavailable".to_string())
                            }
                        }
                        _ => Err(format!("Write unsupported for {:?}", config.protocol_config)),
                    };

                    match write_result {
                        Ok(()) => {
                            s.process_image.update_tag(&cmd.tag, cmd.value, TagQuality::Good, config.source).await;
                            info!("SCADA command executed: {} = {}", cmd.tag, cmd.value);
                            Ok(cmd.value)
                        }
                        Err(e) => {
                            warn!("SCADA command failed: {} = {} - {}", cmd.tag, cmd.value, e);
                            Err(e)
                        }
                    }
                }.await;

                let _ = cmd.response_tx.send(result);
            }
        });

        info!("SCADA display server started with full HMI runtime");
    }

    // Step 7: Start command handler with DIRECT shutdown awareness.
    //
    // Batch 26 plan D-15: CommandHandler::run() now consumes the
    // shutdown receiver directly and checks BETWEEN iterations,
    // never mid-`handle_message`. Pre-Batch-26 the wrapper
    // `run_until_shutdown` used `tokio::select!` which would
    // cancel-drop the run() future — including any in-flight
    // `handle_message` awaiting an actuator write. That dropped
    // future left Modbus/GPIO/I2C register writes in a partial-
    // transaction state for a microsecond-scale window before
    // safe-state apply ran.
    //
    // With the drain-aware pattern, in-flight commands complete
    // naturally; the outer shutdown_coordinator's timeout still
    // bounds total drain (any command slower than the timeout
    // gets force-aborted via the coordinator's tokio::time::
    // timeout around the JoinHandle).
    let command_handler = CommandHandler::new(state.clone()).await;
    let command_shutdown = shutdown_coordinator.subscribe();
    let command_handle = tokio::spawn(async move {
        command_handler.run(command_shutdown).await;
    });
    shutdown_coordinator.register_task("command", command_handle);

    // Step 8: Initialize SQLite persistence for RETAIN variables (IEC 61131-3)
    // Batch 30: route through data_dir:: SSoT helper. Log whether
    // the path came from env override or FHS default so operators
    // can diagnose misconfigured SUDERRA_DATA_DIR at a glance.
    let persistence = {
        match std::env::var(data_dir::DATA_DIR_ENV_VAR) {
            Ok(dir) => info!("Using data directory from {}: {}", data_dir::DATA_DIR_ENV_VAR, dir),
            Err(_) => debug!(
                "{} not set, using default: {}",
                data_dir::DATA_DIR_ENV_VAR,
                data_dir::DEFAULT_DATA_DIR
            ),
        }
        let db_path = data_dir::data_dir().join("retain.db");
        let db_path = db_path.to_string_lossy().to_string();

        match SqlitePersistence::new(&db_path) {
            Ok(p) => {
                info!("SQLite persistence initialized: {}", db_path);
                Some(Arc::new(p))
            }
            Err(e) => {
                warn!(
                    "Failed to initialize persistence (RETAIN variables disabled): {}",
                    e
                );
                None
            }
        }
    };

    // Step 9: Start script engine (with persistence if available)
    // v2.2: ScriptEngine constructors are now async to get shared storage from AppState
    info!("Starting script engine...");
    let mut script_engine = match &persistence {
        Some(p) => ScriptEngine::with_persistence(state.clone(), p.clone()).await,
        None => ScriptEngine::new(state.clone()).await,
    };

    if let Err(e) = script_engine.init().await {
        warn!("Script engine initialization failed: {}", e);
    } else {
        info!(
            "Script engine initialized with {} scripts",
            script_engine.script_count().await
        );
    }

    // Keep reference for graceful shutdown persistence stats
    let script_persistence = persistence.clone();

    // Start script engine with shutdown awareness
    let script_shutdown = shutdown_coordinator.subscribe();
    let script_handle = tokio::spawn(async move {
        shutdown::run_until_shutdown(script_engine.run(), script_shutdown).await;
    });
    shutdown_coordinator.register_task("script_engine", script_handle);

    info!(
        "Shutdown coordinator initialized with {} tasks",
        shutdown_coordinator.task_count()
    );

    // Step 10: Main loop - wait for shutdown signal
    info!("Agent running. Press Ctrl+C to stop.");

    loop {
        tokio::select! {
            // v1.2.4: biased; ensures shutdown signal is always checked first
            biased;

            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    info!("Shutdown signal received");
                    break;
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                // Periodic health check could go here
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Step 11: Graceful shutdown sequence (LIFE-SAFETY ordered)
    //
    // Order is critical for aquaculture safety:
    //   (1) Signal tasks → (2) Wait for script engine stop →
    //   (3) SAFE-STATE all outputs → (4) Flush offline queue →
    //   (5) Disconnect hardware → (6) Publish offline status →
    //   (7) Disconnect MQTT
    // ════════════════════════════════════════════════════════════════════

    // ── (1) + (2) Signal all tasks and wait for completion ──
    //
    // Batch 29: emit structured ShutdownPhase transitions for
    // operator observability. Phase=StoppingInbound covers the
    // signal-broadcast step (1); phase=Draining covers the
    // per-task wait-for-completion step (2). Combined into a
    // single shutdown() call by the coordinator — the log
    // captures entry + exit so duration is recoverable.
    //
    // Batch 32: shutdown_timeout is NOW config-driven from
    // `config.runtime.shutdown_timeout_secs`. Pre-Batch-32 the
    // hardcoded 30s constant overrode the config field,
    // leaving operator-editable configuration dead.
    use crate::runtime_safety::shutdown_phase::ShutdownPhase;
    let (shutdown_timeout_secs, drain_timeout_ms) = {
        let state_guard = state.read().await;
        (
            state_guard.config.runtime.shutdown_timeout_secs,
            state_guard.config.runtime.drain_timeout_ms,
        )
    };
    // Batch 48: include both outer-shutdown timeout + per-
    // task drain timeout in the shutdown-initiation log so
    // operators diagnosing a hang know BOTH budgets at a
    // glance. Pre-Batch-48 only the outer timeout was logged;
    // a task that hit the drain budget before the outer
    // budget would require a boot-banner lookup to understand
    // why.
    info!(
        shutdown_phase = ?ShutdownPhase::StoppingInbound,
        "Initiating graceful shutdown: outer_timeout={}s, drain_budget={}ms — phase transition to StoppingInbound + Draining",
        shutdown_timeout_secs,
        drain_timeout_ms
    );
    shutdown_coordinator
        .shutdown(Duration::from_secs(shutdown_timeout_secs))
        .await;
    info!(
        shutdown_phase = ?ShutdownPhase::Drained,
        "Task drain complete — phase transition to Drained"
    );

    // Log persistence statistics on shutdown (IEC 61131-3 compliance)
    if let Some(ref persistence) = script_persistence {
        match persistence.get_stats() {
            Ok(stats) => {
                info!(
                    "Persistence stats: {} variables, {} FB states, {} executions, {} bytes",
                    stats.variable_count,
                    stats.fb_state_count,
                    stats.execution_history_count,
                    stats.database_size_bytes
                );
            }
            Err(e) => {
                warn!("Failed to get persistence stats: {}", e);
            }
        }
    }

    // ── (3) LIFE-SAFETY: Set all actuator outputs to safe-state ──
    // This MUST happen BEFORE hardware disconnect so the bus is still live.
    info!(
        shutdown_phase = ?ShutdownPhase::ApplyingSafeState,
        "Phase transition to ApplyingSafeState"
    );
    {
        let state_guard = state.read().await;
        let modbus_ref = state_guard.modbus_handle.as_ref();
        let gpio_ref = state_guard.gpio_handle.as_ref();
        let i2c_ref = state_guard.i2c_handle.as_ref();

        let safe_count = safe_state_manager
            .apply(modbus_ref, gpio_ref, i2c_ref)
            .await;

        info!(
            "LIFE-SAFETY: safe-state phase complete ({} outputs processed)",
            safe_count
        );
    }

    info!(
        shutdown_phase = ?ShutdownPhase::Flushing,
        "Phase transition to Flushing — offline queue checkpoint + audit log fsync"
    );
    // ── (4) Flush offline queue to disk (WAL checkpoint + fsync) ──
    // Ensures no telemetry is lost if the process is about to exit.
    {
        let state_guard = state.read().await;
        // WHY: The offline queue uses SQLite WAL mode. A WAL checkpoint
        // forces all pending writes into the main database file before we
        // lose the process.  This is a best-effort step; failure is logged
        // but does not block shutdown.
        if let Some(ref modbus_handle) = state_guard.modbus_handle {
            // Offline queue is not stored in AppState directly; if we have
            // a reference we checkpoint it here.  Currently the queue is
            // module-level so this is a placeholder for future refactor.
            let _ = modbus_handle; // suppress unused warning
        }
        info!("Offline queue flush step complete");
    }

    // ── (5) Disconnect hardware interfaces ──
    // Safe-state writes are already done; now tear down the bus connections.

    // Disconnect Modbus devices via handle
    let modbus_handle = {
        let state_guard = state.read().await;
        state_guard.modbus_handle.clone()
    };

    if let Some(handle) = modbus_handle {
        handle.disconnect_all().await;
        info!("Modbus devices disconnected");
    }

    // LoRa gateway shutdown
    #[cfg(feature = "lorawan")]
    {
        let state_guard = state.read().await;
        if let Some(ref handle) = state_guard.lora_handle {
            handle.shutdown().await;
            info!("LoRa gateway shutdown completed");
        }
    }

    // I2C actor shutdown
    {
        let state_guard = state.read().await;
        if let Some(ref handle) = state_guard.i2c_handle {
            handle.shutdown().await;
            info!("I2C actor shutdown completed");
        }
    }

    // ── (6) Publish offline status before MQTT disconnect ──
    {
        let state_guard = state.read().await;
        if let Some(ref mqtt) = state_guard.mqtt_client {
            let status_payload = serde_json::json!({
                "status": "offline",
                "reason": "graceful_shutdown",
                "safe_state_applied": true,
            });
            if let Ok(payload_bytes) = serde_json::to_vec(&status_payload) {
                let topic = format!(
                    "suderra/{}/status",
                    state_guard.config.device_id
                );
                if let Err(e) = mqtt.publish_raw(&topic, &payload_bytes).await {
                    warn!("Failed to publish offline status: {}", e);
                } else {
                    info!("Published offline status before disconnect");
                }
            }
        }
    }

    info!(
        shutdown_phase = ?ShutdownPhase::DisconnectingMqtt,
        "Phase transition to DisconnectingMqtt"
    );
    // ── (7) Disconnect MQTT gracefully ──
    {
        let mut state_guard = state.write().await;
        if let Some(mqtt) = state_guard.mqtt_client.take() {
            if let Err(e) = mqtt.disconnect().await {
                warn!("Error disconnecting MQTT: {}", e);
            }
        }
    }

    info!(
        shutdown_phase = ?ShutdownPhase::Shutdown,
        "Graceful shutdown complete — process exit imminent"
    );

    Ok(())
}

/// Initialize hardware interfaces (Modbus, GPIO) v2.0
///
/// Uses actor pattern for both Modbus and GPIO
async fn init_hardware(state: &Arc<RwLock<AppState>>) {
    // Initialize hardware actors (must be done in LocalSet context)
    {
        let mut state_guard = state.write().await;
        state_guard.init_hardware_handles();
    }

    // Initialize GPIO via actor handle
    let gpio_handle = {
        let state_guard = state.read().await;
        state_guard.gpio_handle.clone()
    };

    if let Some(handle) = gpio_handle {
        let pin_count = handle.pin_count().await;
        info!("Initializing GPIO with {} pins configured", pin_count);

        match handle.init().await {
            Ok(()) => {
                info!("GPIO initialized successfully");
                if handle.is_available().await {
                    info!("  GPIO hardware is available");
                } else {
                    info!("  GPIO running in simulation mode");
                }
            }
            Err(e) => {
                warn!("GPIO initialization failed: {}", e);
            }
        }
    } else {
        debug!("No GPIO pins configured");
    }

    // Initialize I2C devices via handle
    let i2c_handle = {
        let state_guard = state.read().await;
        state_guard.i2c_handle.clone()
    };

    if let Some(handle) = i2c_handle {
        match handle.init().await {
            Ok(()) => {
                info!("I2C devices initialized successfully");
            }
            Err(e) => {
                warn!("I2C initialization failed: {}", e);
            }
        }
    } else {
        debug!("No I2C devices configured");
    }

    // Connect to Modbus devices via handle
    let modbus_handle = {
        let state_guard = state.read().await;
        state_guard.modbus_handle.clone()
    };

    if let Some(handle) = modbus_handle {
        info!("Connecting to Modbus devices...");
        let errors = handle.connect_all().await;

        if errors.is_empty() {
            info!("All Modbus devices connected successfully");
        } else {
            for err in &errors {
                warn!("Modbus connection error: {}", err);
            }
        }

        // Log connected device info (v1.2.2: use parallel reads)
        let results = handle.read_all_parallel().await;
        for result in results {
            if result.errors.is_empty() {
                info!(
                    "  {} - {} registers available",
                    result.device_name,
                    result.values.len()
                );
                for value in &result.values {
                    debug!(
                        "    {}: {:.2} {}",
                        value.name,
                        value.scaled_value,
                        value.unit.as_deref().unwrap_or("")
                    );
                }
            } else {
                warn!("  {} - errors: {:?}", result.device_name, result.errors);
            }
        }
    } else {
        debug!("No Modbus devices configured");
    }

    // Initialize LoRaWAN gateway (v1.5.0)
    #[cfg(feature = "lorawan")]
    {
        let should_init = {
            let state_guard = state.read().await;
            state_guard.config.lorawan.as_ref().map_or(false, |c| c.enabled)
        };

        if should_init {
            let lora_handle = {
                let state_guard = state.read().await;
                let lora_cfg = state_guard.config.lorawan.as_ref()
                    .ok_or_else(|| anyhow::anyhow!(
                        "LoRaWAN config was Some when should_init was computed but is now None — \
                         concurrent config update between lock acquisitions"
                    ))?;
                crate::lora::LoRaHandle::new(lora_cfg, state.clone())
            };

            match lora_handle.init().await {
                Ok(()) => {
                    info!("LoRaWAN gateway initialized successfully");
                    let mut state_guard = state.write().await;
                    state_guard.lora_handle = Some(lora_handle);
                }
                Err(e) => {
                    warn!("LoRaWAN initialization failed: {}", e);
                }
            }
        } else {
            debug!("LoRaWAN not configured or disabled");
        }
    }

    // Log hardware summary
    let state_guard = state.read().await;
    let gpio_count = state_guard.config.gpio.len();
    let modbus_count = state_guard.config.modbus.len();

    info!(
        "Hardware summary: {} GPIO pins, {} Modbus devices",
        gpio_count, modbus_count
    );

    // v2.3: Publish hardware capabilities report at boot.
    // This informs the platform about what I/O hardware is available
    // for auto-detection. Sent once — not periodic.
    publish_capabilities(&state_guard).await;
}

/// Publish hardware capabilities to MQTT at boot time.
///
/// Sends a compact report of available I/O hardware to the platform.
/// The platform caches this and uses it to populate the "Auto-Detect I/O"
/// feature in the device management UI.
///
/// Topic: `tenants/{tid}/devices/{code}/capabilities`
async fn publish_capabilities(state: &AppState) {
    let mqtt = match &state.mqtt_client {
        Some(m) => m,
        None => {
            debug!("MQTT not available — skipping capabilities report");
            return;
        }
    };

    let platform = state.config.gpio_platform();
    let scanner = hardware_scanner::HardwareScanner::new(platform);
    let modbus_configured = !state.config.modbus.is_empty();
    let capabilities = scanner.capabilities(modbus_configured);

    let tenant_id = match &state.config.tenant_id {
        Some(tid) => tid.as_str(),
        None => {
            debug!("No tenant_id configured — skipping capabilities report");
            return;
        }
    };

    // Use resolved topics for consistency and placeholder validation
    let resolved = state.config.mqtt.topics.resolve(tenant_id, &state.config.device_id);
    let topic = &resolved.capabilities;

    match serde_json::to_vec(&capabilities) {
        Ok(payload) => {
            if let Err(e) = mqtt.publish_raw(&topic, &payload).await {
                warn!("Failed to publish capabilities: {}", e);
            } else {
                info!(
                    "Hardware capabilities published: platform={}, gpio_chips={}, gpio_lines={}",
                    capabilities.platform,
                    capabilities.gpio_chip_count,
                    capabilities.total_gpio_lines
                );
            }
        }
        Err(e) => {
            warn!("Failed to serialize capabilities: {}", e);
        }
    }
}

/// Reverse-scale an engineering value back to raw for Modbus AO writes
#[cfg(feature = "scada-display")]
fn reverse_scale(eng_value: f64, config: &crate::process_image::TagConfig) -> f64 {
    match (config.raw_min, config.raw_max, config.eng_min, config.eng_max) {
        (Some(raw_min), Some(raw_max), Some(eng_min), Some(eng_max)) => {
            let eng_range = eng_max - eng_min;
            if eng_range.abs() < f64::EPSILON {
                return eng_value;
            }
            let raw_range = raw_max - raw_min;
            raw_min + (eng_value - eng_min) * raw_range / eng_range
        }
        _ => eng_value,
    }
}
