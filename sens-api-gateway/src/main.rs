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
#![cfg_attr(
    test,
    allow(
        clippy::approx_constant,
        clippy::duplicated_attributes,
        clippy::empty_line_after_doc_comments,
        clippy::empty_line_after_outer_attr,
        clippy::expect_used,
        clippy::indexing_slicing,
        clippy::large_stack_arrays,
        clippy::print_stderr,
        clippy::print_stdout,
        clippy::unwrap_used,
        clippy::useless_vec
    )
)]

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
mod atlas_ezo;
#[allow(dead_code)] // Faz 2 wires consumers; enum + newtypes pre-staged for reference stability.
mod authz;
mod backup; // v1.2.4: Backup and restore functionality
mod bounded;
mod commands;
mod config;
// Faz 4 cloud↔edge contract-parity gate: deserializes the shared
// fixtures in libs/sensor-contracts/fixtures/ into the agent's serde
// structs. Unit-test module (not tests/) because the crate is
// [[bin]]-only — external tests can't import internal types.
#[cfg(test)]
mod contract_fixtures_tests;
mod deploy_orchestrator; // v2.2: Unified deploy orchestrator (Rust/Codesys/Setpoint)
mod error;
mod gpio;
mod hardware_scanner; // v2.3: Platform-aware I/O auto-detection (RevPi/RPi/Generic)
mod health;
mod i2c; // v1.2.4: I2C support for sensor communication
mod interning;
mod io_poll;
mod license; // Batch 140 Faz 7: edge license tier enforcement (plan R-10)
mod license_cache; // Batch 144 Faz 7: SQLCipher persistence + monotonic floor
#[cfg(feature = "health")]
mod lifecycle; // Batch 122 Sprint 6.5: HTTP lifecycle endpoint (confirm-active)
#[cfg(feature = "health")]
mod lifecycle_auth; // Batch 129 Sprint 6.6: HMAC auth for lifecycle endpoint
mod modbus;
mod mqtt;
mod mqtt_failover; // v1.3.4: MQTT broker failover for high availability
mod offline_queue;
mod plc_programming; // v1.3.0: PLC programming protocols (ST upload)
mod process_image;
mod provisioning;
mod pwm; // v1.2.4: PWM support for motor/servo control
mod resilience;
mod safe_state;
mod scripting;
mod security; // v1.2.2: Security hardening utilities
mod st_validator; // v2.2: IEC 61131-3 Structured Text parser and validator // LIFE-SAFETY: actuator safe-state on shutdown (v1 schema)
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
// Batch #329 — plan §5 Faz 2 D-3 SQLCipher v1->v2 migration arc primitive
// split. `DbKeySchemaVersion` enum + `DbKeySourceManifest` sidecar JSON +
// atomic write/read + `DbMigrationError` taxonomy. Boot-time detector +
// db-migrate-cli + per-consumer migration follow in subsequent D-3 batches.
#[allow(dead_code)] // D-3 boot-detector + migration binary wire consumers; primitives pre-staged.
mod db_migration;
// EDGE-HIGH-026: canonical SQLCipher connection factory (steady-state open
// ceremony SSoT). Stores route their open + PRAGMA key through db::sqlcipher_factory.
mod db;
// Batch #338 — cross-cutting IO primitives shared by sidecar-persisting
// modules (closes audit MEDIUM-004 finding). The first primitive is
// `atomic_json_sidecar::write_atomic_json` which does the full 6-step
// crash-safe write (temp + fsync + rename + PARENT-DIR fsync — the 6th
// step both rotation_marker_store + db_migration::manifest were missing
// before this batch).
mod shared_io;
// Batch #344 — machine-id read with env-override sandboxing (closes
// ORPHAN-MEDIUM-033). Mirrors the SUDERRA_DB_KEY_PATH pattern; tests +
// CI sandboxes can now inject machine-id alongside the secret-key path.
// offline_queue's derive_db_encryption_key delegates to this wrapper.
mod machine_id;
// PR-195 Batch #14 — v1 SQLCipher secret-key SSoT extraction. Pre-extraction
// the read-or-create logic lived inside offline_queue.rs; license_cache +
// retain_persistence + bytecode_retain consumers now share this single read
// path without duplicating env-override + permissions-mode discipline.
mod db_secret;
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
#[allow(dead_code)]
// Faz 2 Sprint 6.7 wires remaining consumers; ShutdownPhase used by main.rs log.
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
#[cfg(feature = "scada-display")]
mod alarm_engine;
#[cfg(feature = "scada-display")]
mod calibration_engine;
#[cfg(feature = "lorawan")]
mod lora; // v1.5.0: LoRaWAN SX1302 gateway support
#[allow(dead_code)] // mode.rs consumed; verify/pinning/cipher/error pending Sprint 6.8.
mod mtls;
#[cfg(feature = "opc-ua-server")]
mod opc_ua_sens_auth_manager; // Batch #266 A-2b part 4: AuthManager binding UserTokenValidator to session-establish
#[cfg(feature = "opc-ua-server")]
mod opc_ua_sens_node_manager; // Batch #263 A-2b part 1: custom NodeManager skeleton (ORPHAN-CRITICAL-021 fix path)
mod opc_ua_server; // Batch 208 Faz 5: OPC UA address-space registry primitive
#[cfg(feature = "opc-ua-server")]
mod opc_ua_server_runtime;
mod opc_ua_server_session; // Batch #239 Faz 5 A-2a: typed session principal (sealed newtype)
mod opc_ua_server_typed_authz; // Batch #241 Faz 5: typed authz port composing resolver + PolicyEngine
mod opc_ua_server_user_token_validator; // Batch #245 Faz 5 A-3b: hot-reload validator composing store + enrollment
mod opc_ua_server_user_tokens; // Batch #242 Faz 5 A-3a: UserTokenEnrollment primitive (UserName/Password + X.509)
mod outbound_publisher; // Batch #251 ARC-002: broker-aware MQTT publish dispatcher (direct + queue-on-disk)
mod publish_helpers; // Batch #255 ARC-002: centralized publish-routing helpers (Outbound vs. legacy direct)
#[cfg(feature = "scada-display")]
mod scada_db;
#[cfg(feature = "scada-display")]
mod scada_server; // v1.6.0: SCADA display server for local HMI
#[cfg(feature = "scada-display")]
mod scada_types;
mod shutdown;
mod spi;
mod telemetry; // v1.2.4: SPI support for high-speed peripherals
#[cfg(feature = "scada-display")]
mod trend_engine;

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
use crate::scripting::{ScriptEngine, ScriptStorage};
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

    /// Graceful-shutdown signal flag (Batch #258 C-7 fix).
    ///
    /// Atomically set to `true` by the shutdown initiator BEFORE
    /// safe-state apply + MQTT disconnect. Every command-dispatch
    /// path checks this flag at the top of `execute_command`; when
    /// true, the dispatcher rejects with `ServiceShuttingDown`
    /// response without invoking the handler. This prevents the
    /// race where a command arrives between
    /// `notify.send(shutdown)` and the actual MQTT disconnect:
    /// pre-Batch-258 the command would race the safe-state
    /// transition + potentially leave actuators in a half-modified
    /// state.
    ///
    /// Held as `Arc<AtomicBool>` so the shutdown initiator (which
    /// owns AppState write-guard at most once during shutdown) can
    /// share the flag with the MQTT command-loop reader without
    /// holding the AppState read-guard across each
    /// `execute_command` call.
    pub is_shutting_down: std::sync::Arc<std::sync::atomic::AtomicBool>,

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

    /// OPC UA server runtime handle (Batch 218 Faz 5 wire
    /// point; Batch 219 boot-path wire populates this).
    ///
    /// `None` = server not running. Present only when:
    /// - binary built with the `opc-ua-server` Cargo feature
    /// - `config.opc_ua_server.enabled == true`
    /// - license tier permits OPC UA (Faz 7 enforcement #5)
    ///
    /// Arc-wrapped because Batch 219 spawns a shutdown-
    /// bridge task that holds a clone to call `.cancel()`
    /// on the shutdown broadcast signal.
    #[cfg(feature = "opc-ua-server")]
    pub opc_ua_server: Option<std::sync::Arc<opc_ua_server_runtime::SuderraOpcUaHandle>>,

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
    pub jti_dedup_table: Option<std::sync::Arc<dyn crate::command_envelope::JtiDedupTable>>,

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

    /// User-token manifest store (Batch #245 hot-reload atom +
    /// Batch #247 ingest_signed wire + Batch #249 MQTT handler).
    ///
    /// WHY: Parallel to `rbac_manifest_store` but gates the OPC UA
    /// UserName/Password + X.509 credential side. Distinct HSM
    /// signing key (ADR-021 slot 4) + distinct monotonic version
    /// stream (ManifestVersionStore::STREAM_ID_USER_TOKEN per
    /// Batch #246) so credential rotation is independent of RBAC
    /// role rotation.
    ///
    /// WHAT: `Arc<UserTokenManifestStore>` held ALWAYS (not Option)
    /// for the same ergonomic reason as `rbac_manifest_store` —
    /// consumers unconditionally clone and call `with_enrollment`
    /// which returns None when no manifest has been ingested yet.
    /// Boot-time `init_user_token_manifest_store` attaches the
    /// version store IFF the config opts into persistence; until
    /// then the validator fails closed with NoManifestLoaded.
    pub user_token_manifest_store:
        std::sync::Arc<crate::authz::user_token_manifest_runtime::UserTokenManifestStore>,

    /// Broker-aware MQTT publish dispatcher (Batch #253 ARC-002
    /// production wire). When `Some`, all MQTT publishes route
    /// through `OutboundPublisher` which queues to disk on broker
    /// outage + replays via `DrainTask` on reconnect. When `None`
    /// (test paths, pre-init boot stage), publish call sites fall
    /// back to the direct `MqttClient` path.
    ///
    /// Held as `Option<Arc<...>>` because:
    /// - Pre-init boot stage (before `OfflineQueue` is opened)
    ///   has no publisher yet.
    /// - Some test harnesses skip the offline queue entirely.
    /// - Future feature-flag (`offline_queue.enabled = false`)
    ///   would deselect the publisher path.
    ///
    /// Generic params bound to `MqttClient` (sink) +
    /// `HealthState` (connectivity) — the production wire pair.
    pub outbound_publisher: Option<
        std::sync::Arc<
            crate::outbound_publisher::OutboundPublisher<
                crate::mqtt::MqttPublishAdapter,
                crate::health::HealthState,
            >,
        >,
    >,

    /// Drain-task shutdown signal (Batch #253 ARC-002 wire).
    /// `init_outbound_publisher` spawns the drain task with an
    /// oneshot receiver; the sender lives here so a future
    /// graceful-shutdown hook can `take()` + send to stop the
    /// task at the next tick boundary. Held as Option so the
    /// shutdown handler can `take()` (oneshot Senders are not
    /// reusable).
    pub outbound_publisher_drain_shutdown: Option<tokio::sync::oneshot::Sender<()>>,

    /// Drain-task join handle paired with
    /// `outbound_publisher_drain_shutdown`.
    ///
    /// Graceful shutdown takes this handle, signals the oneshot, and awaits the
    /// task before checkpointing the SQLCipher queue. Without the handle the
    /// flush phase could race an active drain loop that still owns the queue.
    pub outbound_publisher_drain_handle: Option<tokio::task::JoinHandle<()>>,

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
    pub clock_authority: std::sync::Arc<dyn crate::runtime_safety::ClockAuthority>,

    /// Master-key keystore for HKDF-derived per-purpose keys
    /// (Batch 83 Sprint 6.3).
    ///
    /// WHY: Plan §5 Faz 2 item 1 + ADR-018 §4 mandate a
    /// 3-backend priority (TPM > systemd-creds > FileBacked).
    /// Batch 82 shipped FileBackedKeystore; Batch 83 wires
    /// AppState construction. Downstream consumers
    /// (Phase 2 / Batch 84 audit-hmac-from-keystore,
    /// Phase 2 / Batch 85 SQLCipher-key-from-keystore)
    /// clone the `Arc<dyn Keystore>` for per-purpose
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
    pub lifecycle_auth_key: Option<std::sync::Arc<crate::lifecycle_auth::LifecycleAuthKey>>,

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

    /// SQLCipher-backed license cache + monotonic floor
    /// (Batch 145 Faz 7 wire).
    ///
    /// WHY: cross-boot persistence of the signed license
    /// manifest + highest_seen_policy_version rollback
    /// floor. Batch 143 shipped in-memory hot-swap; Batch
    /// 144 shipped the SQLCipher primitive; this field
    /// wires the primitive into boot + refresh path.
    ///
    /// WHAT: `Option<Arc<LicenseCacheStore>>` — None when
    /// boot-time open fails (fail-closed still loads
    /// conservative() into AppState.license so the agent
    /// runs under safe defaults while operators diagnose
    /// the cache). Some when SQLCipher open + schema init
    /// succeeded.
    pub license_cache: Option<std::sync::Arc<crate::license_cache::LicenseCacheStore>>,

    /// Current per-device license limits (Batch 142 Faz 7
    /// wire).
    ///
    /// WHY: Plan R-10 + Faz 7 specify per-tenant tier
    /// enforcement at cmd_deploy_program + io_poll +
    /// task_scheduler + watch_subscribe + force_value +
    /// opc_ua_server + signature_mode. Each enforcement
    /// site reads from this field.
    ///
    /// WHAT: `Arc<EdgeLicenseLimits>` — always Some;
    /// defaults to `conservative()` STARTER fallback at
    /// AppState::new. Batch 143 (future) wires SQLCipher
    /// license_cache + fetch from platform; until then
    /// every boot uses conservative() which matches plan
    /// R-10 "tek kripto primitive fallback" discipline.
    pub license: std::sync::Arc<crate::license::EdgeLicenseLimits>,

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
    pub firmware_signing_pubkey: Option<std::sync::Arc<ed25519_dalek::VerifyingKey>>,

    /// Bytecode program registry — Batch 167 Faz 3 wire.
    /// Populated at AppState::new with an empty registry;
    /// `cmd_deploy_program` (future batch) inserts signed
    /// + verified programs via `bytecode_deploy::
    /// verify_and_deploy`; ScriptEngine Phase 5b scan-
    /// cycle orchestrator (future batch) reads
    /// `list_enabled()` every tick.
    pub bytecode_registry:
        std::sync::Arc<crate::scripting::bytecode_registry::BytecodeProgramRegistry>,

    /// Bytecode registry SQLCipher store — Batch 169 Faz 3
    /// wire. None when `scripting.bytecode_store_path` is
    /// empty (default — in-memory registry only). Some
    /// when `init_bytecode_registry_store` opens the
    /// configured path + rehydrates existing entries.
    /// `cmd_deploy_bytecode_program` persists to this
    /// store AFTER the registry insert succeeds so a
    /// successful deploy survives reboot.
    pub bytecode_registry_store:
        Option<std::sync::Arc<crate::scripting::bytecode_registry_store::BytecodeRegistryStore>>,

    /// RETAIN variable SQLCipher store — Batch 177 Faz 3
    /// wire. Shared between the legacy ScriptEngine
    /// (JSON-script variable RETAIN) + the new bytecode
    /// scan-cycle orchestrator (bytecode RETAIN). None
    /// when `init_retain_persistence` fails (e.g.
    /// SQLCipher permission issue); agent continues
    /// with RETAIN disabled + operator gets a loud
    /// boot warning.
    pub retain_persistence: Option<std::sync::Arc<crate::scripting::SqlitePersistence>>,

    /// Live-debug force registry — Batch 196 Faz 6 wire.
    /// Always present (constructed empty at
    /// AppState::new). Operators populate via MQTT
    /// `force_value` command (Batch 197). The io_poll
    /// bypass (Batch 198) consults this on every poll
    /// tick to skip refreshes for forced tags. The
    /// 1-Hz sweep task (Batch 198) drops expired
    /// entries automatically.
    pub force_registry: std::sync::Arc<crate::scripting::force_registry::ForceRegistry>,

    /// Force registry SQLCipher store — Batch 202 Faz 6
    /// wire. None when `scripting.force_store_path`
    /// is empty (default — in-memory registry only).
    /// Some when `init_force_registry_store` opens
    /// the configured path + rehydrates
    /// persist_across_reboot=true entries.
    ///
    /// cmd_force_value saves to this store after
    /// apply when persist=true. cmd_unforce_value /
    /// cmd_unforce_all delete from it. Sweep task
    /// purges expired rows on shutdown.
    pub force_registry_store:
        Option<std::sync::Arc<crate::scripting::force_registry_store::ForceRegistryStore>>,

    /// Live-watch session registry — Batch 205 Faz 6.
    /// Always present (empty at AppState::new).
    /// Operators populate via `watch_subscribe`
    /// command; publisher task (Batch 206 spawn)
    /// reads due sessions + publishes to MQTT;
    /// sweep task drops expired entries. Never
    /// persisted to disk — watch sessions are live-
    /// only per plan R-9.
    pub watch_sessions: std::sync::Arc<crate::scripting::watch_sessions::WatchSessionRegistry>,
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
            is_shutting_down: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
            // Batch 219 Faz 5: None-init; the boot-path wire
            // below constructs + assigns via
            // `init_opc_ua_server(&config.opc_ua_server,
            // &process_image, &license)` iff both gates open.
            #[cfg(feature = "opc-ua-server")]
            opc_ua_server: None,
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
            // Batch #249 Faz 5 A-3c wire: empty store at boot;
            // Batch #248 MQTT `update_user_token_manifest` command
            // later calls `ingest_signed` to populate. Until then,
            // `UserTokenValidator` fails closed with
            // NoManifestLoaded. Boot-time `init_user_token_manifest
            // _store()` below attaches the version store (per-
            // stream floor) when the SQLCipher path is available.
            user_token_manifest_store: std::sync::Arc::new(
                crate::authz::user_token_manifest_runtime::UserTokenManifestStore::new(),
            ),
            // Batch #253 ARC-002: None at struct-construction;
            // `init_outbound_publisher()` populates AFTER the MQTT
            // client + HealthState + OfflineQueue Arcs are ready.
            // Until populated, publish call sites fall back to the
            // direct MqttClient path (HC-1 backward compat).
            outbound_publisher: None,
            outbound_publisher_drain_shutdown: None,
            outbound_publisher_drain_handle: None,
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
            clock_authority: std::sync::Arc::new(crate::runtime_safety::SystemClockAuthority::new()),
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
            bootloader: std::sync::Arc::new(crate::updater::NoopBootloaderHandle),
            // Batch 145 Faz 7 wire: None until
            // init_license_cache() succeeds. Boot-time
            // open failure leaves this None; the agent
            // continues with conservative() fallback +
            // operator gets a loud boot warning.
            license_cache: None,
            // Batch 142 Faz 7 wire: conservative()
            // STARTER fallback at AppState::new. Batch
            // 145 boot sequence overrides with cache-
            // loaded verified limits on successful
            // verify. Conservative is always-expired so
            // enforcement sites routing through
            // is_expired() treat it as "re-verify
            // required" until real license lands.
            license: std::sync::Arc::new(crate::license::EdgeLicenseLimits::conservative()),
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
            // Batch 167 Faz 3 wire: empty registry at
            // AppState::new. cmd_deploy_program (future
            // batch) inserts verified programs; the
            // scan-cycle orchestrator (future batch)
            // reads via list_enabled() every tick. Arc-
            // shared so ScriptEngine + CommandHandler
            // see the same source of truth.
            bytecode_registry: std::sync::Arc::new(
                crate::scripting::bytecode_registry::BytecodeProgramRegistry::new(),
            ),
            // Batch 169 Faz 3 wire: None-init.
            // init_bytecode_registry_store() opens the
            // SQLCipher file at the configured path +
            // rehydrates entries into bytecode_registry.
            // None when the config field is empty — the
            // registry stays in-memory-only (dev default).
            bytecode_registry_store: None,
            // Batch 177 Faz 3 wire: None-init.
            // init_retain_persistence() opens
            // {data_dir}/retain.db + applies SQLCipher key.
            // Shared between legacy ScriptEngine +
            // bytecode scan-cycle orchestrator so both
            // RETAIN paths use the same key ceremony +
            // write-through to one file.
            retain_persistence: None,
            // Batch 196 Faz 6 wire: always-present
            // empty force registry. Operators populate
            // via MQTT `force_value` (Batch 197);
            // io_poll consults `is_forced` on each
            // poll tick (Batch 198).
            force_registry: std::sync::Arc::new(
                crate::scripting::force_registry::ForceRegistry::new(),
            ),
            // Batch 202 Faz 6 wire: None-init.
            // init_force_registry_store() opens the
            // SQLCipher file + rehydrates persistent
            // forces. None when config path empty.
            force_registry_store: None,
            // Batch 205 Faz 6 wire: always-present
            // empty watch-session registry.
            watch_sessions: std::sync::Arc::new(
                crate::scripting::watch_sessions::WatchSessionRegistry::new(),
            ),
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
    pub async fn init_health_server(
        &mut self,
    ) -> Result<Option<tokio::task::JoinHandle<()>>, String> {
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
        let server_handle =
            crate::health::start_health_server(addr, health_state.clone(), Some(lifecycle_cell))
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

        let key =
            crate::lifecycle_auth::LifecycleAuthKey::load_from_credentials_dir(credential_name)
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
            warn!(
                "init_lifecycle_cell: partition_store is None — confirm-active HTTP endpoint will return 503"
            );
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
            // Batch 134 Sprint 6.5 — closes Batch 132 obs
            // #2: forward HealthState so the HTTP handler
            // can bump firmware_confirm + update slot/
            // version gauges on success.
            health_state: self.health_state.clone(),
            // Batch #324 D-9 migration: forward the clock
            // authority so verify_request's
            // trustworthy_wall_clock gate uses the
            // operator-configured impl
            // (SystemClockAuthority or ChronyNtsClockAuthority)
            // rather than falling back to the SystemTime::now
            // trusting baseline.
            clock_authority: Some(self.clock_authority.clone()),
        };

        if cell.set(handles).is_err() {
            warn!("init_lifecycle_cell: cell already populated (re-init attempted) — ignoring");
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

        // PR-195 Batch #17 — adopt the manifest-aware
        // constructor (Batch #13). Reads the per-DB
        // sidecar manifest, derives the SQLCipher PRAGMA
        // key via consumer_key_resolver — works on BOTH
        // pre-migration hosts (manifest missing → v1
        // fallback per Batch #330) and post-migration
        // hosts (manifest declares v2 → keystore-derived
        // key). Falls back to legacy v1-only constructor
        // when keystore.mode = Disabled (HC-1 backward
        // compat — operator hasn't enabled the keystore
        // subsystem; v2 migration is unavailable; v1
        // path is the only valid derivation).
        let queue = if let Some(ref keystore) = self.keystore {
            let deployment_uuid = self.config.device_id.clone().into_bytes();
            // Task 1.7: caps come from the entitlement-derived formula when
            // provisioned (msgs/s × 3600 rows; × avg bytes × 1.2 disk).
            match crate::offline_queue::OfflineQueue::with_keystore_derivation(
                &db_path,
                self.config.offline_queue.effective_max_size(),
                self.config.offline_queue.max_age_secs,
                self.config.offline_queue.effective_max_disk_bytes(),
                keystore.clone(),
                deployment_uuid,
            )
            .await
            {
                Ok(q) => q,
                Err(e) => {
                    return Err(format!(
                        "offline_queue DB open (manifest-aware) at `{}` failed: {:#}",
                        db_path.display(),
                        e
                    ));
                }
            }
        } else {
            match crate::offline_queue::OfflineQueue::with_disk_limit(
                &db_path,
                self.config.offline_queue.effective_max_size(),
                self.config.offline_queue.max_age_secs,
                self.config.offline_queue.effective_max_disk_bytes(),
            ) {
                Ok(q) => q,
                Err(e) => {
                    return Err(format!(
                        "offline_queue DB open (legacy v1, keystore disabled) at `{}` failed: {:#}",
                        db_path.display(),
                        e
                    ));
                }
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
            hs.set_offline_queue_capacity(self.config.offline_queue.effective_max_size() as u64);
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
            JtiDedupTable, LayeredJtiDedupTable, MokaJtiDedupTable, SqlCipherJtiDedupTable,
        };

        if matches!(self.config.signature_mode, SignatureMode::Disabled) {
            info!("JTI dedup table skipped: signature_mode=Disabled (HC-1 backward compat)");
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
                .unwrap_or_else(|| std::path::PathBuf::from("/var/lib/suderra/jti_dedup.sqlite"));
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
                    let sql_arc: std::sync::Arc<dyn JtiDedupTable> = std::sync::Arc::new(sql);
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
                    std::sync::Arc::new(MokaJtiDedupTable::with_capacity_and_ttl(capacity, ttl))
                }
            }
        } else {
            info!(
                "JTI dedup table: Moka-only signature_mode={:?} moka_capacity={} moka_ttl_secs={} (set envelope_dedup.enable_sqlcipher_persist=true for reboot-survive 72h replay defense)",
                self.config.signature_mode, capacity, ttl_secs
            );
            std::sync::Arc::new(MokaJtiDedupTable::with_capacity_and_ttl(capacity, ttl))
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
        let pubkey_hex = self
            .config
            .rbac_manifest
            .manifest_signing_pubkey_hex
            .as_deref();
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
            .unwrap_or_else(|| std::path::PathBuf::from("/var/lib/suderra/rbac_version.sqlite"));

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

    /// Initialize the broker-aware outbound publisher + spawn
    /// the queue-drain background task (Batch #253 ARC-002 wire).
    ///
    /// MUST be called AFTER:
    /// - `init_mqtt_client` (provides the `MqttPublishAdapter`)
    /// - `init_health_server` (provides the connectivity
    ///   `HealthState`)
    /// - `init_offline_queue` (provides the `Arc<OfflineQueue>`)
    ///
    /// Pre-Batch-253 publish call sites (`publish_alarms`,
    /// `publish_telemetry`, etc.) keep using the direct
    /// `MqttClient::publish_*` path until they're migrated in
    /// Batch #254+. This init function is the foundation that
    /// makes those migrations a one-line swap.
    ///
    /// Spawns the drain task under `tokio::spawn` with an oneshot
    /// shutdown channel. The shutdown sender is stored in
    /// `outbound_publisher_drain_shutdown` so graceful-stop paths
    /// can fire it.
    ///
    /// **Fail-closed:** if any prerequisite is missing, returns
    /// Err and the boot sequence treats it as a fatal init
    /// failure. Operating without a publisher would silently lose
    /// messages on broker outage — no degraded-mode fallback.
    pub fn init_outbound_publisher(&mut self) -> Result<(), String> {
        use crate::outbound_publisher::{DrainTask, OutboundPublisher};

        let mqtt = self.mqtt_client.as_ref().ok_or_else(|| {
            "init_outbound_publisher: mqtt_client must be initialized first".to_string()
        })?;
        let hs = self.health_state.as_ref().ok_or_else(|| {
            "init_outbound_publisher: health_state must be initialized first".to_string()
        })?;
        let queue_async = self.offline_queue.as_ref().ok_or_else(|| {
            "init_outbound_publisher: offline_queue must be initialized first".to_string()
        })?;

        let adapter = std::sync::Arc::new(mqtt.publish_adapter());
        let connectivity = std::sync::Arc::new(hs.clone());
        let queue = queue_async.inner();

        let publisher = std::sync::Arc::new(OutboundPublisher::new(
            adapter.clone(),
            connectivity.clone(),
            queue.clone(),
        ));
        self.outbound_publisher = Some(publisher);

        // Drain task: spawned under tokio::spawn; the shutdown
        // sender is stored so the existing ShutdownCoordinator
        // hook can fire it on graceful agent stop. Until that
        // wire lands (follow-up batch), the task exits when the
        // process exits — same observable behavior, just no
        // mid-drain "stop after current message" semantic.
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let drain = DrainTask::new(adapter, connectivity, queue);
        let drain_handle = tokio::spawn(drain.run(shutdown_rx));
        self.outbound_publisher_drain_shutdown = Some(shutdown_tx);
        self.outbound_publisher_drain_handle = Some(drain_handle);

        info!("Outbound publisher initialized + drain task spawned (Batch #253 ARC-002)");
        Ok(())
    }

    /// Initialize the user-token manifest store + attach the
    /// per-stream persistent floor (Batch #250 Faz 5 A-3c boot
    /// wire).
    ///
    /// Parallel to `init_rbac_manifest_store` but narrower:
    /// - No mode gate. The user-token manifest does not have a
    ///   staged-rollout semantic (Disabled / Permissive /
    ///   Enforcing). Authentication is either enrolled (manifest
    ///   ingested + signing pubkey configured) or NOT enrolled
    ///   (`UserTokenValidator::validate_*` fails closed with
    ///   `NoManifestLoaded`).
    /// - No disk-load. The user-token manifest is MQTT-first;
    ///   the cloud is the authoritative source. Boot opens the
    ///   version store (so the floor survives reboots) but
    ///   leaves the cached enrollment empty until the first
    ///   `update_user_token_manifest` MQTT command lands.
    ///
    /// **Fail-closed:** version-store open failure returns Err.
    /// The boot sequence calls `exit(1)` on Err. Unlike
    /// RbacManifestStore's Permissive mode (which silently runs
    /// with floor=0), no equivalent fallback exists here — a
    /// reachable code path that silently runs without persistent
    /// floor opens the cross-reboot replay window.
    pub fn init_user_token_manifest_store(&mut self) -> Result<(), String> {
        use crate::authz::manifest_version_store::{ManifestVersionStore, STREAM_ID_USER_TOKEN};
        use crate::authz::user_token_manifest_runtime::UserTokenManifestStore;

        let version_store_path = self
            .config
            .user_token_manifest
            .version_store_path
            .clone()
            .unwrap_or_else(|| {
                std::path::PathBuf::from("/var/lib/suderra/user_token_version.sqlite")
            });

        match ManifestVersionStore::open_for_stream(&version_store_path, STREAM_ID_USER_TOKEN) {
            Ok(vs) => {
                info!(
                    "User-token manifest version store opened: path={}",
                    version_store_path.display()
                );
                self.user_token_manifest_store = std::sync::Arc::new(
                    UserTokenManifestStore::new().with_version_store(std::sync::Arc::new(vs)),
                );
                Ok(())
            }
            Err(e) => Err(format!(
                "User-token manifest version store open failed (fail-closed): {}",
                e
            )),
        }
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
            let derived = tokio::runtime::Handle::current()
                .block_on(async move { ks.derive_key(KeyPurpose::AuditHmacChain, b"").await });
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
                let pair = key_hex
                    .get(i * 2..i * 2 + 2)
                    .ok_or_else(|| format!("audit.hmac_key_hex: hex slice error at byte {}", i))?;
                *b = u8::from_str_radix(pair, 16)
                    .map_err(|e| format!("audit.hmac_key_hex: hex parse at byte {}: {}", i, e))?;
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

        let sink_arc = std::sync::Arc::new(sink);

        // Phase 1.1.5 / ORPHAN-MEDIUM-036/037 closure — install the
        // process-global audit sink + agent tenant for cross-cutting
        // forensic emit (mTLS handshake reject, CA bundle parse partial).
        //
        // Command-dispatch handlers reach the sink via
        // `state.audit_sink.as_ref()` (the Arc stored on AppState below);
        // surfaces with no AppState access (rustls verifier callback,
        // pre-MqttClient configure_tls) reach it via
        // `crate::audit::current_audit_sink()`.
        //
        // `install_global_*` returns `Err` if already installed — should
        // never happen because `init_audit_sink` is called exactly once
        // per process. Surface as a `warn!` rather than fail-fast so a
        // re-init in pathological configurations (e.g., test harness
        // re-running boot sequence) does not trip the agent. The Arc on
        // AppState remains the authoritative reference for command paths.
        if let Err(_existing) = crate::audit::install_global_audit_sink(sink_arc.clone()) {
            tracing::warn!(
                "audit::install_global_audit_sink: global already installed — \
                 boot sequence may have run twice (test harness?). The first \
                 install remains authoritative."
            );
        }
        if let Some(tenant_str) = self.config.tenant_id.as_ref() {
            // Tenant id in config is a UUID-like string; convert to the
            // 16-byte TenantId using `uuid::Uuid::from_str` then
            // `as_bytes()`. Failure here means the agent config has an
            // unparseable tenant_id which is a fatal misconfig — surface
            // as warn (audit chain still works with placeholder tenant).
            match uuid::Uuid::parse_str(tenant_str) {
                Ok(parsed) => {
                    let tenant =
                        crate::authz::permission::TenantId::new_from_verified(*parsed.as_bytes());
                    if let Err(_existing) = crate::audit::install_global_agent_tenant(tenant) {
                        tracing::warn!(
                            "audit::install_global_agent_tenant: already installed (re-init?)"
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        tenant_id_raw = %tenant_str,
                        "audit::install_global_agent_tenant: tenant_id is not a valid UUID — \
                         forensic events will use the zero-tenant placeholder. Fix \
                         config.tenant_id to enable per-tenant queries on mTLS forensic events."
                    );
                }
            }
        }

        self.audit_sink = Some(sink_arc);
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
    /// **Batch #320 D-1b CLOSURE — async + rotation-tracking
    /// integration.**
    ///
    /// Converted from sync to async so the FileBackedKeystore
    /// open path can call `open_with_rotation_tracker`
    /// (which awaits `clock.trustworthy_wall_clock()` for
    /// the marker init/read). The single production caller
    /// at the cold-boot block already holds an async context
    /// (`state.write().await`) so the conversion is
    /// non-breaking.
    ///
    /// Wire chain:
    /// 1. Derive `marker_path = data_dir::data_dir().join(ROTATION_MARKER_FILENAME)`
    ///    — same path the alarm runner reads.
    /// 2. Construct `FileBackedKeystore::open_with_rotation_tracker`
    ///    with the marker_path + the AppState's clock_authority.
    /// 3. read_or_init mints the marker on first boot (anchored
    ///    at the current trustworthy wallclock) OR reads
    ///    existing on subsequent boots.
    /// 4. The alarm runner task (spawned later in main()) reads
    ///    the SAME marker on each tick.
    ///
    /// Disabled mode + the empty-config-path check skip the
    /// rotation tracker: TPM-mode (future batch) handles
    /// rotation via NV counter, not this marker.
    pub async fn init_keystore(&mut self) -> Result<(), String> {
        // PR-195 Batch #16: keystore construction
        // extracted to crate::keystore::bootstrap so the
        // same production path is reachable from BOTH
        // this AppState boot path AND the future
        // --migrate-db CLI dispatch (which runs
        // PRE-AppState). The extracted function is
        // byte-for-byte equivalent to the pre-extraction
        // inline body — same Argon2id params, same
        // acceptance-token verification stance, same
        // rotation-marker wire.
        let keystore_opt = crate::keystore::bootstrap::build_production_keystore_from_config(
            &self.config,
            self.clock_authority.clone(),
            data_dir::data_dir(),
        )
        .await?;

        // None = keystore.mode = Disabled (HC-1 backward
        // compat). Caller's downstream consumers handle
        // self.keystore = None as the "no keystore"
        // case.
        self.keystore = keystore_opt;
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
            self.clock_authority = std::sync::Arc::new(ChronyNtsClockAuthority::new(threshold));
        } else {
            info!(
                "Clock authority: SystemClockAuthority threshold={}s (HC-1 trusting-0-age baseline; set clock.enable_chrony_query=true for real NTS age)",
                threshold
            );
            self.clock_authority =
                std::sync::Arc::new(SystemClockAuthority::with_nts_threshold(threshold));
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

        let snap = store
            .snapshot()
            .map_err(|e| format!("PartitionStore snapshot failed post-open: {}", e))?;

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

        if matches!(
            self.config.firmware_update.mode,
            FirmwareUpdateMode::Disabled
        ) {
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
                format!(
                    "firmware signing pubkey hex slice error at index {}",
                    byte_idx
                )
            })?;
            *b = u8::from_str_radix(hex_byte, 16)
                .map_err(|e| format!("firmware signing pubkey invalid hex at byte {}: {}", i, e))?;
        }

        let key = ed25519_dalek::VerifyingKey::from_bytes(&bytes)
            .map_err(|e| format!("firmware signing pubkey ed25519 construction failed: {}", e))?;

        info!(
            "FirmwareUpdateConfig: mode={:?} firmware_signing_pubkey parsed (key fingerprint sha256 first 8 bytes={:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x})",
            self.config.firmware_update.mode,
            bytes[0],
            bytes[1],
            bytes[2],
            bytes[3],
            bytes[4],
            bytes[5],
            bytes[6],
            bytes[7],
        );
        self.firmware_signing_pubkey = Some(std::sync::Arc::new(key));
        Ok(())
    }

    /// Initialize the license cache + load + verify the
    /// persisted signed manifest (Batch 145 Faz 7 wire).
    ///
    /// Boot-time flow:
    /// 1. Open SQLCipher cache at default path.
    /// 2. On open error: log + leave
    ///    `license_cache = None` + `license =
    ///    conservative()`. Agent boots under STARTER
    ///    fallback; operator sees the error in boot
    ///    log.
    /// 3. On open success: load cached manifest; None
    ///    → stay at conservative() (first-boot path).
    /// 4. If cached manifest present: verify via Batch
    ///    141 `verify_license_manifest` using the
    ///    firmware_signing_pubkey + cached highest_seen
    ///    floor + current wall-clock.
    /// 5. On verify success: replace
    ///    `self.license` with the verified limits +
    ///    record_accepted(version).
    /// 6. On verify failure: log + fall through to
    ///    conservative() (tampered cache / expired
    ///    license / attacker downgrade attempt all
    ///    route here).
    ///
    /// Called AFTER `init_firmware_signing_pubkey`
    /// (needs the cached pubkey) + AFTER
    /// `init_partition_store` (tenant_id available via
    /// config).
    pub async fn init_license_cache(&mut self) {
        use std::path::PathBuf;
        let path = PathBuf::from(crate::license_cache::DEFAULT_CACHE_PATH);

        // PR-195 Batch #17 — adopt the manifest-aware
        // constructor (Batch #14). Same shape as
        // init_offline_queue's adoption: prefer the
        // keystore-aware path when keystore is wired;
        // fall back to legacy v1-only when
        // keystore.mode = Disabled (HC-1 backward compat).
        let store = if let Some(ref keystore) = self.keystore {
            let deployment_uuid = self.config.device_id.clone().into_bytes();
            match crate::license_cache::LicenseCacheStore::open_with_keystore_derivation(
                &path,
                keystore.clone(),
                deployment_uuid,
            )
            .await
            {
                Ok(s) => std::sync::Arc::new(s),
                Err(e) => {
                    error!(
                        "License cache (manifest-aware) open failed at {}: {}. Agent boots under conservative() STARTER fallback; operator must investigate SQLCipher permissions + /etc/suderra/db.key + manifest sidecar.",
                        path.display(),
                        e
                    );
                    return;
                }
            }
        } else {
            match crate::license_cache::LicenseCacheStore::open(&path) {
                Ok(s) => std::sync::Arc::new(s),
                Err(e) => {
                    error!(
                        "License cache (legacy v1, keystore disabled) open failed at {}: {}. Agent boots under conservative() STARTER fallback; operator must investigate SQLCipher permissions + /etc/suderra/db.key.",
                        path.display(),
                        e
                    );
                    return;
                }
            }
        };

        self.license_cache = Some(store.clone());

        // Load + verify persisted manifest.
        let signed = match store.load() {
            Ok(Some(s)) => s,
            Ok(None) => {
                info!(
                    "License cache at {} is empty — first boot; staying at conservative() STARTER fallback until cmd_refresh_license lands.",
                    path.display()
                );
                return;
            }
            Err(e) => {
                error!(
                    "License cache load failed: {}. Staying at conservative() fallback.",
                    e
                );
                return;
            }
        };

        // Need the firmware signing pubkey + tenant to
        // verify. If either is missing we can't trust the
        // cached manifest — fall through to conservative.
        let pubkey = match self.firmware_signing_pubkey.as_ref() {
            Some(k) => k.clone(),
            None => {
                warn!(
                    "License cache has cached manifest but firmware_signing_pubkey is None (firmware_update.mode=Disabled). Cannot verify cached license; staying at conservative()."
                );
                return;
            }
        };

        let tenant = match self.tenant_id.as_deref() {
            Some(t) => match uuid::Uuid::parse_str(t) {
                Ok(u) => crate::authz::permission::TenantId::new_from_verified(*u.as_bytes()),
                Err(e) => {
                    warn!(
                        "License cache: tenant_id is not a valid UUID: {}. Staying at conservative().",
                        e
                    );
                    return;
                }
            },
            None => {
                info!(
                    "License cache: device not activated (tenant_id=None); staying at conservative() until provisioning."
                );
                return;
            }
        };

        let highest_seen = match store.get_highest_seen() {
            Ok(v) => v,
            Err(e) => {
                warn!(
                    "License cache: highest_seen read failed: {}. Treating as 0 (permissive verify); load still gated by signature + validity.",
                    e
                );
                0
            }
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        match crate::license::verify_license_manifest(
            &signed,
            &tenant,
            highest_seen,
            now,
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey.verify_strict(canonical, &sig).is_ok()
            },
        ) {
            Ok(verified) => {
                let tier_label = verified.limits.tier.as_str();
                let pv = verified.policy_version;
                info!(
                    "License cache: verified manifest loaded (tier={} policy_version={} highest_seen={})",
                    tier_label, pv, highest_seen
                );
                self.license = std::sync::Arc::new(verified.limits);

                // Monotonic floor advance. Best-effort;
                // failure logs but does not block boot
                // because the in-memory limits are
                // already active.
                if let Err(e) = store.record_accepted(pv) {
                    warn!(
                        "License cache: record_accepted({}) failed: {}. In-memory limits applied anyway.",
                        pv, e
                    );
                }
            }
            Err(e) => {
                warn!(
                    "License cache: cached manifest verify FAILED ({:?}). Staying at conservative() — cached manifest kept on disk for forensic inspection.",
                    e
                );
            }
        }
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
    /// Initialize the SQLCipher-backed bytecode registry
    /// store + rehydrate persisted programs into the in-
    /// memory registry.
    ///
    /// Called AFTER config load + before the scan-cycle
    /// orchestrator starts. No-op when
    /// `config.scripting.bytecode_store_path` is empty
    /// (dev default; in-memory-only registry).
    ///
    /// Failure modes (each logs at error + leaves the
    /// registry empty for this boot):
    /// - SQLCipher open fails (path, permissions, key
    ///   derivation) → store stays None; `cmd_deploy_
    ///   bytecode_program` will still deploy to the
    ///   in-memory registry but programs won't survive
    ///   reboot until the store recovers.
    /// - load_all returns error → store is stored but
    ///   the rehydrate is skipped.
    /// - One or more entries fail registry.insert
    ///   (monotonic / tenant gate, unexpected schema) →
    ///   reported per-entry; other entries still
    ///   rehydrate.
    pub async fn init_bytecode_registry_store(&mut self) {
        let path = self.config.scripting.bytecode_store_path.trim().to_string();
        if path.is_empty() {
            info!(
                "Bytecode registry store disabled (scripting.bytecode_store_path is empty). Deployed programs will not survive reboot."
            );
            return;
        }

        // PR-195 Batch #19 (closes
        // ORPHAN-D3-BOOT-ORDER-002 partial — boot-time
        // graceful degradation half). Adopt the
        // manifest-aware constructor (Batch #15).
        // Empty program_sha at boot per the same
        // option-3 first-program-deploy migration
        // discipline as init_retain_persistence; v2
        // manifests degrade gracefully (warn +
        // self.bytecode_registry_store = None) until
        // the next program-deploy recreates the DB.
        // HC-1 backward compat: legacy v1-only path
        // when keystore.mode = Disabled.
        let store_result: Result<
            crate::scripting::bytecode_registry_store::BytecodeRegistryStore,
            _,
        > = if let Some(ref keystore) = self.keystore {
            crate::scripting::bytecode_registry_store::BytecodeRegistryStore::new_with_keystore_derivation(
                    &path,
                    keystore.clone(),
                    Vec::new(),
                )
                .await
        } else {
            crate::scripting::bytecode_registry_store::BytecodeRegistryStore::new(&path)
        };

        let store = match store_result {
            Ok(s) => std::sync::Arc::new(s),
            Err(e) => {
                error!(
                    "Bytecode registry store open failed at {}: {}. Agent boots with in-memory registry only — deploys will NOT persist until SQLCipher recovers OR (for v2 manifest hosts) until next program-deploy recreates the DB under v2 keystore-derived key per option-3 first-program-deploy migration discipline.",
                    path, e
                );
                return;
            }
        };

        self.bytecode_registry_store = Some(store.clone());

        // Rehydrate existing entries into the in-memory
        // registry. Per-entry failures are logged but
        // do not abort the rehydrate.
        let results = crate::scripting::bytecode_registry_store::load_into_registry(
            &store,
            &self.bytecode_registry,
        )
        .await;

        let mut loaded = 0usize;
        let mut failed = 0usize;
        for r in &results {
            match r {
                Ok(program_id) => {
                    loaded += 1;
                    info!("Bytecode registry rehydrated: program_id={}", program_id);
                }
                Err((program_id, e)) => {
                    failed += 1;
                    error!(
                        "Bytecode registry rehydrate failed for {}: {}",
                        program_id, e
                    );
                }
            }
        }
        info!(
            "Bytecode registry store ready at {}: rehydrated {} + failed {}",
            path, loaded, failed
        );
    }

    /// Initialize the force-registry SQLCipher store +
    /// rehydrate persist_across_reboot=true entries
    /// into the in-memory registry. Batch 202 Faz 6.
    ///
    /// No-op when `config.scripting.force_store_path`
    /// is empty (dev default). Failure (permissions,
    /// schema drift) logs at warn + leaves
    /// `force_registry_store = None`; the agent boots
    /// with in-memory force registry only, `force_
    /// value { persist_across_reboot: true }` still
    /// succeeds but its row never reaches disk.
    pub async fn init_force_registry_store(&mut self) {
        let path = self.config.scripting.force_store_path.trim().to_string();
        if path.is_empty() {
            info!(
                "Force-registry store disabled (scripting.force_store_path is empty). Persistent forces will not survive reboot."
            );
            return;
        }

        let store = match crate::scripting::force_registry_store::ForceRegistryStore::new(&path) {
            Ok(s) => std::sync::Arc::new(s),
            Err(e) => {
                error!(
                    "Force-registry store open failed at {}: {}. Agent boots with in-memory force registry only — persistent forces will NOT persist.",
                    path, e
                );
                return;
            }
        };

        self.force_registry_store = Some(store.clone());

        // Rehydrate existing persistent forces into
        // the in-memory registry.
        // Batch #314 D-9 migration: pass the clock authority
        // so each restored entry mints a MonotonicDeadline
        // through the standard apply() gate.
        let results = crate::scripting::force_registry_store::load_into_registry(
            &store,
            &self.force_registry,
            &*self.clock_authority,
        )
        .await;
        let mut loaded = 0usize;
        let mut failed = 0usize;
        for r in &results {
            match r {
                Ok(tag) => {
                    loaded += 1;
                    info!("Force-registry rehydrated: tag=`{}`", tag);
                }
                Err((tag, e)) => {
                    failed += 1;
                    error!("Force-registry rehydrate failed for `{}`: {}", tag, e);
                }
            }
        }
        info!(
            "Force-registry store ready at {}: rehydrated {} + failed {}",
            path, loaded, failed
        );
    }

    /// Initialize the shared RETAIN SqlitePersistence
    /// store at `{data_dir}/retain.db`. Batch 177 Faz 3.
    ///
    /// Reused by:
    /// - Legacy `ScriptEngine` for JSON-script RETAIN
    ///   variable storage.
    /// - Bytecode `run_scan_tick` for VAR_RETAIN
    ///   persistence across scan cycles + reboots
    ///   (Batch 176 wire).
    ///
    /// Failure (SQLCipher permissions, disk full, key
    /// derivation error) logs at warn + leaves
    /// `retain_persistence` at None; RETAIN becomes a
    /// no-op for the current boot. Agent boots
    /// successfully — RETAIN programs run without
    /// persistence, matching the pre-Batch-176
    /// behavior.
    pub async fn init_retain_persistence(&mut self) {
        let db_path = crate::data_dir::data_dir().join("retain.db");
        let db_path_str = db_path.to_string_lossy().to_string();

        // PR-195 Batch #19 (closes
        // ORPHAN-D3-BOOT-ORDER-002 partial — boot-time
        // graceful degradation half) — adopt the
        // manifest-aware constructor (Batch #15). Pass
        // empty Vec for program_artifact_sha256 because
        // no program is loaded at boot (programs deploy
        // via MQTT post-boot per ADR-031 program-bound
        // consumer lifecycle). Behavior:
        //
        //   - v1 manifest / missing manifest → v1
        //     fallback path; resolver doesn't read
        //     program_sha → opens fine.
        //   - v2 manifest → resolver returns
        //     ProgramSha256Required → constructor
        //     errors → graceful degradation (warn +
        //     self.retain_persistence = None);
        //     post-boot program-deploy command handler
        //     is responsible for recreating the DB
        //     under v2 keystore-derived key with the
        //     deploy's program_sha (option-3 first-
        //     program-deploy migration discipline).
        //
        // HC-1 backward compat: when keystore.mode =
        // Disabled (no keystore), fall back to the
        // legacy v1-only constructor.
        let result: Result<crate::scripting::SqlitePersistence, _> =
            if let Some(ref keystore) = self.keystore {
                crate::scripting::SqlitePersistence::new_with_keystore_derivation(
                    &db_path,
                    keystore.clone(),
                    Vec::new(),
                )
                .await
            } else {
                crate::scripting::SqlitePersistence::new(&db_path)
            };

        match result {
            Ok(p) => {
                info!("Shared RETAIN persistence initialized: {}", db_path_str);
                self.retain_persistence = Some(std::sync::Arc::new(p));
            }
            Err(e) => {
                warn!(
                    "Failed to initialize RETAIN persistence at {} ({}). RETAIN variables + bytecode RETAIN will not survive reboot until SQLCipher recovers OR (for v2 manifest hosts) until next program-deploy recreates the DB under v2 keystore-derived key per option-3 first-program-deploy migration discipline.",
                    db_path_str, e
                );
            }
        }
    }

    /// PR-195 Batch #20 (closes ORPHAN-D3-BOOT-ORDER-002
    /// second half — post-boot program-deploy DB
    /// recreation hook).
    ///
    /// Option-3 first-program-deploy migration
    /// discipline (per ADR-031): program-bound consumer
    /// DBs (`SqlitePersistence` for RETAIN, persistence;
    /// `BytecodeRegistryStore` for bytecode programs)
    /// are bound to a specific program's
    /// `program_artifact_sha256` for v2 keystore-derived
    /// key derivation. At boot, the program SHA is
    /// unavailable (no program loaded yet); init_X
    /// gracefully degrades to `self.X = None` for v2
    /// manifest hosts (Batch #19).
    ///
    /// This method is the "post-deploy open" hook that
    /// closes the gap: when a program deploys, the
    /// deploy handler has the program's SHA and calls
    /// this method. The method:
    ///
    ///   - For each program-bound consumer that's
    ///     currently `None`, calls the manifest-aware
    ///     constructor with the deploy's program_sha.
    ///   - Stores the constructed handle on AppState if
    ///     successful; logs a warning (does NOT fail
    ///     the deploy) if open fails.
    ///   - For consumers that are already `Some`, this
    ///     method is a no-op — the existing handle was
    ///     opened either at boot (v1 fallback path) or
    ///     by an earlier deploy, and is already serving
    ///     the runtime.
    ///
    /// **Why warn-not-fail:** the deploy itself doesn't
    /// fundamentally depend on persistence. RETAIN
    /// programs run without persistence per the
    /// pre-Batch-176 fail-tolerant pattern; bytecode
    /// programs work in-memory per the pre-Batch-169
    /// fail-tolerant pattern. A v2 DB that can't be
    /// opened with the new program's SHA is an
    /// operator-investigation concern (DB content was
    /// derived from a DIFFERENT program — operator
    /// must decide whether to recover or recreate).
    /// Failing the deploy would block the agent from
    /// running the new program at all; warning lets the
    /// deploy succeed + surfaces the DB state as a
    /// persistence problem.
    ///
    /// **Caller contract:** the deploy handler MUST
    /// pass the canonical bytecode SHA-256 — same value
    /// that the migration ceremony would have used for
    /// the v2 derivation (so the keystore yields the
    /// same key). For source-deploy paths, the SHA is
    /// computed over the COMPILED bytecode bytes (not
    /// the source bytes) — this matches `ADR-031`
    /// program-bound consumer context discipline.
    ///
    /// **Idempotency:** calling this method multiple
    /// times with the same program_sha is a no-op
    /// after the first successful open (each consumer
    /// becomes `Some` and stays so). Calling with a
    /// DIFFERENT program_sha after the first open is
    /// a no-op for ALREADY-Some consumers; the new
    /// SHA does not re-key existing handles. Operator
    /// runs `--migrate-db` ceremony again to rekey
    /// under the new SHA, OR (for v1-host first
    /// deploy where DB doesn't exist yet) the
    /// constructor creates it fresh.
    pub async fn try_open_program_bound_dbs_under_program_sha(
        &mut self,
        program_artifact_sha256: Vec<u8>,
    ) {
        let Some(keystore) = self.keystore.clone() else {
            // Keystore disabled (HC-1 backward compat).
            // No v2 derivation; legacy v1 path was
            // already attempted at boot.
            return;
        };

        // RETAIN persistence (program-bound).
        if self.retain_persistence.is_none() {
            let db_path = crate::data_dir::data_dir().join("retain.db");
            let db_path_str = db_path.to_string_lossy().to_string();
            match crate::scripting::SqlitePersistence::new_with_keystore_derivation(
                &db_path,
                keystore.clone(),
                program_artifact_sha256.clone(),
            )
            .await
            {
                Ok(p) => {
                    info!(
                        "PR-195 Batch #20 post-deploy-open: RETAIN persistence opened under deploy's program_sha at {} (option-3 first-program-deploy migration discipline complete for this consumer)",
                        db_path_str
                    );
                    self.retain_persistence = Some(std::sync::Arc::new(p));
                }
                Err(e) => {
                    warn!(
                        "PR-195 Batch #20 post-deploy-open FAILED for RETAIN persistence at {}: {}. The DB content was derived from a different program_sha than the current deploy. Operator must investigate (recover via --migrate-db ceremony with matching program OR delete the DB to recreate fresh under the new program). RETAIN programs run without persistence in the meantime.",
                        db_path_str, e
                    );
                }
            }
        }

        // Bytecode registry store (program-bound).
        if self.bytecode_registry_store.is_none() {
            let path = self.config.scripting.bytecode_store_path.trim().to_string();
            if !path.is_empty() {
                match crate::scripting::bytecode_registry_store::BytecodeRegistryStore::new_with_keystore_derivation(
                    &path,
                    keystore,
                    program_artifact_sha256,
                )
                .await
                {
                    Ok(s) => {
                        info!(
                            "PR-195 Batch #20 post-deploy-open: bytecode registry store opened under deploy's program_sha at {} (option-3 first-program-deploy migration discipline complete for this consumer)",
                            path
                        );
                        self.bytecode_registry_store = Some(std::sync::Arc::new(s));
                    }
                    Err(e) => {
                        warn!(
                            "PR-195 Batch #20 post-deploy-open FAILED for bytecode registry store at {}: {}. The DB content was derived from a different program_sha than the current deploy. Operator must investigate (recover via --migrate-db ceremony with matching program OR delete the DB to recreate fresh under the new program). Bytecode registry runs in-memory only in the meantime.",
                            path, e
                        );
                    }
                }
            }
        }
    }

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
                let handle = match self.config.firmware_update.tryboot_autoboot_path.clone() {
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
        // Initialize Modbus actor. Started UNCONDITIONALLY — even with zero
        // devices — so the runtime can hot-provision a tenant-added drive
        // (SENSOR-CRITICAL-007) without a reboot. An empty actor simply parks on
        // its command channel; every device-touching path already guards on
        // `config.modbus` being non-empty, so no read/write/telemetry surface
        // changes for a Modbus-less edge. "Modbus configured" is derived from
        // `config.modbus`, never from the handle's presence.
        self.modbus_handle = Some(ModbusHandle::new(self.config.modbus.clone()));
        info!(
            "Modbus actor initialized with {} devices",
            self.config.modbus.len()
        );

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
            eprintln!(
                "Boot continuing without coredump-disable; future keystore wire-up will require this."
            );
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
            "--migrate-db" => {
                // PR-195 Batch #6: D-3 SQLCipher v1->v2
                // migration ceremony subcommand. The
                // architectural contract is documented
                // in docs/runbooks/db-migration-rekey-
                // ceremony.md (Batch #4); the
                // implementation lives in
                // db_migration::cli (this module).
                //
                // PR-195 Batch #18 (closes
                // ORPHAN-D3-CLI-DISPATCH-001): wire the
                // execute path. Pre-Batch-#18 the arm
                // called the legacy no-context entry
                // (run_migration_ceremony) which refused
                // execute mode at runtime — operators
                // could only --dry-run. This batch
                // delegates to
                // run_migrate_db_subcommand_with_context
                // which loads the agent config, builds
                // the keystore via the SSoT helper
                // (Batch #16), constructs MigrationContext,
                // and invokes
                // run_migration_ceremony_with_context.
                let sub_argv_owned: Vec<String> = args.get(2..).unwrap_or(&[]).to_vec();
                let exit_code = run_migrate_db_subcommand_with_context(sub_argv_owned);
                std::process::exit(exit_code);
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
                            eprintln!("Error: --audit-verify requires a log file path");
                            eprintln!("Usage: suderra-agent --audit-verify <log-path>");
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
                {
                    use std::io::Write as _;
                    let mut stdout = std::io::stdout().lock();
                    let _ = writeln!(
                        stdout,
                        "    --confirm-active          Confirm the currently-active A/B slot (Batch 110)"
                    );
                }
                {
                    use std::io::Write as _;
                    let mut stdout = std::io::stdout().lock();
                    let _ = writeln!(
                        stdout,
                        "    --migrate-db [args...]    SQLCipher v1->v2 migration ceremony (PR-195 Batch #6)"
                    );
                }
                {
                    use std::io::Write as _;
                    let mut stdout = std::io::stdout().lock();
                    let _ = writeln!(
                        stdout,
                        "    --version                 Print version information"
                    );
                    let _ = writeln!(
                        stdout,
                        "    --help                    Print this help message"
                    );
                }
                println!();
                println!("ENVIRONMENT:");
                println!(
                    "    SUDERRA_CONFIG              Path to config file (default: /etc/suderra/config.yaml)"
                );
                {
                    use std::io::Write as _;
                    let mut stdout = std::io::stdout().lock();
                    let _ = writeln!(
                        stdout,
                        "    SUDERRA_AUDIT_KEY_HEX       64-char hex HMAC key for --audit-verify"
                    );
                }
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
                cfg.mtls.mode, cfg.mtls.enforce_fingerprint_pinning, cfg.mtls.min_tls_version
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
            info!("  RBAC gate: preview-logging active (Sprint 6.4 wires enforcement)");
            info!(
                "  Two-person integrity: preview-logging active for UpdateFirmware/DeployProgram/ForceValue/SafeStateTrigger/Reboot"
            );
            info!("  Retained-msg rejection: active on commands + config topics (plan D-14)");
            info!(
                "  Shutdown drain: command handler drain-aware; timeout={}s drain_budget={}ms (plan D-15)",
                cfg.runtime.shutdown_timeout_secs, cfg.runtime.drain_timeout_ms
            );
            info!(
                "  Replay window: max_age={}s max_skew={}s (IEC 62443 SL-2 FR-7)",
                cfg.runtime.max_command_age_secs, cfg.runtime.max_command_skew_secs
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
                cfg.envelope_dedup.moka_capacity, cfg.envelope_dedup.moka_ttl_secs
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

    // Initialize clock authority (Batch 90 Sprint 6.7 wire).
    //
    // Runs before keystore init because the keystore rotation marker
    // reads trustworthy wallclock state at boot.
    {
        let mut state_guard = state.write().await;
        state_guard.init_clock_authority();
    }

    // Initialize keystore (Batch 83 Sprint 6.3, relocated PR-195 Batch #17).
    //
    // WHY: Plan §5 Faz 2 item 1 + ADR-018 §4 mandate a
    // 3-backend master-key keystore. Batch 82 shipped the
    // FileBacked runtime; Batch 83 wires AppState +
    // boot-time open. Subsequent ADR-031 + PR-195 D-3
    // SQLCipher consumer migration arc requires the
    // keystore to be initialised BEFORE any SQLCipher
    // consumer's `init_X` runs — the manifest-aware
    // constructors landed in Batches #13-#15
    // (`OfflineQueue::with_keystore_derivation`,
    // `LicenseCacheStore::open_with_keystore_derivation`,
    // `SqlitePersistence::new_with_keystore_derivation`,
    // `BytecodeRegistryStore::new_with_keystore_derivation`)
    // each take `Arc<dyn Keystore>` as a required arg.
    //
    // PR-195 Batch #17 (closes ORPHAN-D3-BOOT-ORDER-001):
    // relocated from the post-init block (line ~3391)
    // to BEFORE `init_offline_queue` here. Pre-relocation
    // the keystore was opened AFTER all SQLCipher
    // consumers had already run their v1-only key
    // derivation; that ordering was safe because the
    // legacy constructors didn't depend on the keystore.
    // The new manifest-aware constructors do — relocating
    // is the architectural prerequisite for the init_X
    // callsite switches in Batch #18.
    //
    // FAIL-CLOSED: keystore.mode != Disabled + open failure
    // -> exit(1). The keystore is the trust anchor; weaker
    // fallback would violate ADR-018 §4 invariants.
    {
        // Batch #320 D-1b CLOSURE: init_keystore is async
        // since it now reads/initializes the rotation marker
        // via the trustworthy wallclock at boot.
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_keystore().await {
            error!("Keystore init failed (fail-closed boot): {}", msg);
            std::process::exit(1);
        }
    }

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

    // Initialize user-token manifest store + persistent floor
    // (Batch #250 Faz 5 A-3c boot wire).
    //
    // WHY: Batch #249b wired the MQTT handler that ingests
    // signed user-token manifests, but the AppState Arc was
    // initialized empty (no version store attached) at struct-
    // construction time. Without this boot-time init, every
    // hot_reload_from_bytes call reads floor=0 → an attacker
    // who captured an older signed manifest could replay it
    // across a reboot. This call opens
    // `ManifestVersionStore::open_for_stream(path,
    // STREAM_ID_USER_TOKEN)` (Batch #246 multi-stream) +
    // attaches it via `with_version_store` so the floor
    // persists across reboots.
    //
    // FAIL-CLOSED DISCIPLINE: open failure exits boot.
    // Unlike RbacManifestStore (which has Disabled / Permissive
    // / Enforcing modes for staged rollout), the user-token
    // manifest has no mode gate — the only legitimate states are
    // "version store attached, awaiting MQTT enrollment" or
    // "version store unavailable, fail-closed." A reachable code
    // path that silently runs without persistent floor would
    // open the cross-reboot replay window.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_user_token_manifest_store() {
            error!(
                "User-token manifest store init failed (fail-closed boot): {}",
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

    // Batch 145 Faz 7 wire: open license cache + load +
    // verify + populate AppState.license. Never panics
    // or exits — any failure path leaves license at the
    // conservative() STARTER fallback already set by
    // AppState::new. Operator sees the specific failure
    // in the boot log + can investigate without the
    // agent refusing to boot.
    {
        let mut state_guard = state.write().await;
        // PR-195 Batch #17: init_license_cache is async
        // since it now reads the per-DB sidecar manifest
        // + may await the keystore's TPM-derived key.
        state_guard.init_license_cache().await;
    }

    // Batch 169 Faz 3 wire: bytecode registry SQLCipher
    // store. No-op when scripting.bytecode_store_path is
    // empty (dev default); otherwise opens the file +
    // rehydrates persisted ST programs into the in-memory
    // registry. Called AFTER init_license_cache (which
    // opens its own SQLCipher store) so we reuse the
    // master-key derivation that pass settled.
    {
        let mut state_guard = state.write().await;
        state_guard.init_bytecode_registry_store().await;
    }

    // Batch 177 Faz 3 wire: shared RETAIN SqlitePersistence
    // (retain.db). Used by both the legacy ScriptEngine +
    // the bytecode scan-cycle RETAIN round-trip. Init
    // order matters: the bytecode scan-cycle task
    // spawned below reads retain_persistence from AppState,
    // so this call MUST precede the spawn.
    {
        let mut state_guard = state.write().await;
        // PR-195 Batch #19: init_retain_persistence
        // became async since it now reads the per-DB
        // sidecar manifest + may await the keystore's
        // TPM-derived key.
        state_guard.init_retain_persistence().await;
    }

    // Batch 202 Faz 6 wire: force-registry SQLCipher
    // store. No-op when scripting.force_store_path is
    // empty (dev default). Loads persistent forces
    // BEFORE the sweep task (Batch 198) spawns so the
    // rehydrated entries start with their correct
    // remaining TTL already tracked.
    {
        let mut state_guard = state.write().await;
        state_guard.init_force_registry_store().await;
    }

    // Batch 146 Faz 7 wire: signature_mode consistency
    // gate. If the license (loaded post-init_license_cache)
    // requires signed deploys AND operator
    // signature_mode=Disabled, emit CRITICAL boot log.
    // Plan Faz 7 discipline: CRITICAL log + alarm (no
    // fail-closed — the license mismatch is operator
    // misconfiguration, not an attack; fail-closed would
    // brick the agent over a config drift).
    {
        let state_guard = state.read().await;
        let signature_mode = state_guard.config.signature_mode;
        let result =
            crate::license::check_signature_mode_consistency(&state_guard.license, signature_mode);
        match result {
            crate::license::SignatureModeConsistency::LicenseDoesNotRequireSignedDeploy => {
                // Most common — conservative() + STARTER
                // set signed_deploy_required=false. Log
                // at info level for audit trail.
                info!(
                    "License contract: signed_deploy_required=false (tier={}); signature_mode={:?} accepted without consistency check.",
                    state_guard.license.tier.as_str(),
                    signature_mode
                );
            }
            crate::license::SignatureModeConsistency::Consistent => {
                info!(
                    "License contract: signed_deploy_required=true (tier={}) + signature_mode={:?} — CONSISTENT.",
                    state_guard.license.tier.as_str(),
                    signature_mode
                );
            }
            crate::license::SignatureModeConsistency::CriticalMismatchDisabledSignatureMode => {
                error!(
                    "CRITICAL LICENSE CONTRACT MISMATCH: license tier={} requires signed_deploy_required=true BUT config.signature_mode=Disabled. Agent accepts UNSIGNED mutating commands despite license contract. Operator MUST flip signature_mode to Permissive or Enforcing immediately. This is NOT an attack; this is config drift. Plan Faz 7 discipline: log + alarm (no fail-closed).",
                    state_guard.license.tier.as_str()
                );
            }
        }
    }

    // PR-195 Batch #17: keystore init relocated to
    // BEFORE init_offline_queue (closes
    // ORPHAN-D3-BOOT-ORDER-001) — see the relocated
    // block above (~line 3097). The original position
    // here was safe pre-D-3 because no consumer needed
    // the keystore at construction time; Batches
    // #13-#15 changed that contract.

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
/// PR-195 Batch #18 — `--migrate-db` subcommand entry
/// (closes ORPHAN-D3-CLI-DISPATCH-001).
///
/// Composes:
///   1. `AgentConfig::load()` — loads the same config
///      file the agent's normal boot path reads.
///   2. `crate::keystore::bootstrap::
///      build_production_keystore_from_config(...)` —
///      the SSoT helper from Batch #16.
///   3. `MigrationContext` construction with
///      `device_id` from config, `now_unix` from
///      `chrono::Utc::now().timestamp()`,
///      `program_artifact_sha256: None` (no program is
///      loaded at migration ceremony time —
///      program-bound DBs that exist will surface as
///      `ConsumerOutcome::Failed::Context::ProgramSha256Required`
///      in the orchestrator's outcome JSONL; the
///      operator's runbook documents that program-
///      bound DBs are migrated by re-deploying the
///      program post-ceremony per ADR-031 +
///      ORPHAN-D3-BOOT-ORDER-002 option-3 discipline).
///   4. `run_migration_ceremony_with_context(...)` —
///      the execute-capable CLI entry from Batch #12.
///
/// **Why a per-call tokio runtime:** the dispatch arm
/// runs PRE-AppState — no shared async runtime is in
/// scope. Building a fresh `current_thread` runtime is
/// the lightest-weight option that doesn't require
/// hoisting tokio orchestration into the synchronous
/// dispatch chain.
///
/// **Why `SystemClockAuthority` (not chrony):** the
/// migration ceremony's keystore-build needs a clock
/// for the rotation-marker read; `SystemClockAuthority`
/// is the trusting-zero-age baseline that doesn't
/// depend on chronyd being reachable. The migration
/// ceremony runs at operator command — a chrony
/// failure shouldn't block the migration.
///
/// **Pre-tracing:** same `println`/`eprintln` pattern
/// as `--init` / `--audit-verify` / `--confirm-active`
/// per the existing CLI convention. The dispatch arm
/// runs BEFORE `init_logging`.
#[allow(clippy::print_stderr)]
fn run_migrate_db_subcommand_with_context(sub_argv_owned: Vec<String>) -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("db-migrate-cli: failed to build tokio runtime: {}", e);
            return 1;
        }
    };

    runtime.block_on(async move {
        // Load the agent config from the canonical
        // path. Same call shape main()'s normal boot
        // path uses — single SSoT for config-load.
        let config = match AgentConfig::load() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("db-migrate-cli: config load failed: {:#}", e);
                return 1;
            }
        };

        if config.device_id.is_empty() || config.device_id == "00000000-0000-0000-0000-000000000000"
        {
            eprintln!(
                "db-migrate-cli: config.device_id is empty or unprovisioned ({}). \
                 Run --init + provisioning before migrating SQLCipher consumers; \
                 the v2 keystore-derived key requires a real device UUID for the \
                 device-bound consumer context (ADR-031).",
                config.device_id,
            );
            return 1;
        }

        // Build a SystemClockAuthority for the
        // keystore's rotation-marker read. The migration
        // ceremony is operator-invoked; chrony NTS
        // dependency is unnecessary for this one-shot
        // path.
        let clock: std::sync::Arc<dyn crate::runtime_safety::ClockAuthority> =
            std::sync::Arc::new(crate::runtime_safety::system_clock::SystemClockAuthority::new());

        // Build the keystore via the SSoT (Batch #16
        // extraction). Same construction path as the
        // agent's normal boot — ensures the migration
        // tool derives the SAME v2 key the agent will
        // see at next boot.
        let keystore = match crate::keystore::bootstrap::build_production_keystore_from_config(
            &config,
            clock,
            data_dir::data_dir(),
        )
        .await
        {
            Ok(Some(ks)) => ks,
            Ok(None) => {
                eprintln!(
                    "db-migrate-cli: keystore.mode = Disabled in config; \
                     cannot run migration ceremony without keystore enabled. \
                     Enable keystore.mode = Auto or FileBacked + provision \
                     /etc/suderra/keystore.{{passphrase,salt,acceptance.json}} \
                     before re-running --migrate-db."
                );
                return 1;
            }
            Err(e) => {
                eprintln!("db-migrate-cli: keystore build failed: {}", e);
                return 1;
            }
        };

        let sub_argv: Vec<&str> = sub_argv_owned.iter().map(|s| s.as_str()).collect();
        let ctx = crate::db_migration::cli::MigrationContext {
            device_id: config.device_id.clone(),
            // Program-bound consumers (RetainPersistence +
            // BytecodeRetain) need program_artifact_sha256
            // for v2 derivation, but no program is loaded
            // at ceremony time. The orchestrator records
            // ConsumerOutcome::Failed::Context::ProgramSha256Required
            // for any program-bound DB that exists; the
            // runbook documents that those consumers are
            // migrated naturally on the next program
            // deploy (option-3 first-program-deploy
            // migration discipline per
            // ORPHAN-D3-BOOT-ORDER-002).
            program_artifact_sha256: None,
            keystore,
            now_unix: chrono::Utc::now().timestamp(),
        };

        let exit_code =
            crate::db_migration::cli::run_migration_ceremony_with_context(&sub_argv, ctx);
        match format!("{exit_code:?}").as_str() {
            s if s.contains("status(0)") => 0,
            _ => 1,
        }
    })
}

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

    let cold_boot_budget_secs = crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;

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
            let hmac_hex: String = last_hmac.iter().map(|b| format!("{:02x}", b)).collect();
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
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::trace::Sampler;

    let endpoint = config.telemetry.otlp.endpoint.as_ref()?;

    info!("Initializing OpenTelemetry OTLP export to {}", endpoint);

    // 2026-04-30: opentelemetry-otlp 0.27 removed the old
    // `new_exporter()/new_pipeline()` API. Build the OTLP exporter and SDK
    // provider explicitly so the `telemetry` feature compiles and registers the
    // provider as the process-wide tracer source.
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint)
        .build();

    match exporter {
        Ok(exporter) => {
            let provider = opentelemetry_sdk::trace::TracerProvider::builder()
                .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
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
                ]))
                .build();

            opentelemetry::global::set_tracer_provider(provider.clone());

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
                    error!(
                        "LIFE-SAFETY: Watchdog heartbeat task exited unexpectedly. \
                            systemd will restart the agent after WatchdogSec timeout."
                    );
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
                        state_guard.config.validate().context(
                            "Self-registration response contained invalid config — aborting save",
                        )?;

                        // Save updated config to disk
                        if let Err(e) = state_guard.config.save() {
                            error!(
                                "CRITICAL: Failed to save config after self-registration: {}. Device may re-register on restart!",
                                e
                            );
                            return Err(anyhow::anyhow!(
                                "Failed to persist self-registration config: {}",
                                e
                            ));
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
                        if response
                            .mqtt_tls_enabled
                            .unwrap_or(response.mqtt_port == 8883)
                        {
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

    // Initialize the broker-aware outbound publisher + spawn the
    // queue-drain background task (Batch #253 ARC-002 wire).
    //
    // MUST run AFTER mqtt_client init (provides
    // MqttPublishAdapter), AFTER health_state init (provides
    // connectivity flag), AFTER offline_queue init (provides the
    // persistent queue Arc). All three prerequisites complete
    // before this point in the boot sequence.
    //
    // FAIL-CLOSED: prerequisite missing → exit(1). Operating
    // without a publisher would silently lose messages on broker
    // outage — no degraded mode.
    {
        let mut state_guard = state.write().await;
        if let Err(msg) = state_guard.init_outbound_publisher() {
            error!("OutboundPublisher init failed (fail-closed boot): {}", msg);
            std::process::exit(1);
        }
    }

    // Initial Online status publish — Batch #268 closure of
    // ORPHAN-MEDIUM-022.
    //
    // Pre-Batch-268, MqttClient::new() did `mqtt_client.
    // publish_status(DeviceStatus::Online, 0).await?` directly
    // on the bare client at the end of connect — bypassing the
    // OutboundPublisher dispatcher because MqttClient internal
    // methods don't have AppState reference. A transient broker
    // outage during the connect→publish window would lose the
    // Online status transition silently.
    //
    // Now: connect happens in MqttClient::new (still); the
    // Online status publish moves HERE, post-init_outbound_
    // publisher, so the publish routes through the queue-aware
    // dispatcher. If the broker drops between connect + this
    // helper call, the status transition queues to disk + drains
    // on reconnect. Operator-actionable visibility of "device
    // just came online" preserved across broker flap.
    //
    // Payload shape mirrors the legacy MqttClient::publish_status
    // envelope (device_id, device_code, status, timestamp,
    // agent_version, uptime_seconds=0 since we just connected)
    // — no cloud-side schema break.
    {
        let state_guard = state.read().await;
        if let Some(ref mqtt) = state_guard.mqtt_client {
            let payload = serde_json::json!({
                "device_id": mqtt.device_id(),
                "device_code": mqtt.device_code(),
                "status": crate::mqtt::DeviceStatus::Online,
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "agent_version": env!("CARGO_PKG_VERSION"),
                "uptime_seconds": 0,
            });
            crate::publish_helpers::publish_status(&state_guard, &payload).await;
            info!(
                "Initial Online status published via OutboundPublisher (Batch #268 wire — ORPHAN-MEDIUM-022 closure)"
            );
        }
    }

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

        if safe_count == 0
            && (!state_guard.config.gpio.is_empty()
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

    // Step 6b: Start I/O poll loop (EDGE-HIGH-015: shutdown-
    // coordinated so the always-on sensor/actuator poll loop stops
    // BEFORE the safe-state phase instead of racing it, and releases
    // its Arc<AppState> so the graph can Drop deterministically).
    let io_poll_shutdown = shutdown_coordinator.subscribe();
    let io_poll_handle = tokio::spawn(shutdown::run_until_shutdown(
        io_poll::io_poll_loop(state.clone()),
        io_poll_shutdown,
    ));
    shutdown_coordinator.register_task("io_poll", io_poll_handle);

    // Batch 206 Faz 6 wire + Batch 225 E-1 closure: spawn
    // the watch publisher task ONLY when the agent has a
    // resolved tenant_id. Pre-provisioning boot has
    // tenant_id=None — publishing to `tenants/unknown/...`
    // would (a) pollute the operator's MQTT namespace with
    // a phantom tenant, (b) route HMI live-watch payloads
    // through an unauthorized path under most broker ACLs,
    // (c) surface forensic ambiguity in the audit chain.
    // Correct behavior: defer spawn until tenant resolves.
    // Self-registration flow re-triggers AppState init;
    // post-registration boot picks tenant_id Some and this
    // block spawns normally.
    //
    // Reads sessions_to_publish every 100 ms (cadence
    // tuned under plan R-9 WATCH_MIN_INTERVAL_MS floor
    // of 100 ms). Side-effect of sessions_to_publish
    // drops expired sessions automatically, so a
    // dedicated sweep task isn't needed — the publisher
    // IS the sweep mechanism for the watch-session path.
    {
        let (watch_sessions, process_image, tenant_str_opt, device_code) = {
            let s = state.read().await;
            (
                s.watch_sessions.clone(),
                s.process_image.clone(),
                s.tenant_id.clone(),
                s.config.device_code.clone(),
            )
        };
        match tenant_str_opt {
            Some(tenant_str) => {
                let topic_base = format!("tenants/{}/devices/{}/watch", tenant_str, device_code);
                let sink: std::sync::Arc<dyn crate::scripting::watch_sessions::WatchPublishSink> =
                    std::sync::Arc::new(
                        crate::scripting::watch_publisher_wire::MqttWatchPublishSink::new(
                            state.clone(),
                        ),
                    );

                let (watch_watch_tx, watch_watch_rx) = tokio::sync::watch::channel(false);
                let mut watch_broadcast_rx = shutdown_coordinator.subscribe();
                tokio::spawn(async move {
                    let _ = watch_broadcast_rx.recv().await;
                    let _ = watch_watch_tx.send(true);
                });

                let publisher_handle = tokio::spawn(async move {
                    let summary = crate::scripting::watch_sessions::run_watch_publisher_task(
                        watch_sessions,
                        process_image,
                        sink,
                        topic_base,
                        100,
                        watch_watch_rx,
                    )
                    .await;
                    info!(
                        "watch_publisher exit: ticks={} published={} errors={}",
                        summary.ticks_executed, summary.sessions_published, summary.publish_errors,
                    );
                });
                shutdown_coordinator.register_task("watch_publisher", publisher_handle);
                info!("Watch-session publisher task spawned (cadence=100ms, tenant=resolved)");
            }
            None => {
                // Pre-provisioning boot — tenant not yet
                // assigned. Watch publisher stays down;
                // self-registration flow will re-init
                // AppState + re-enter this block with a
                // resolved tenant_id.
                info!(
                    "Watch-session publisher NOT spawned: tenant_id unresolved (pre-provisioning boot). Will start after successful self-registration."
                );
            }
        }
    }

    // Batch 198 Faz 6 wire: spawn the 1-Hz force-
    // registry sweep task. Always spawned regardless
    // of whether any force is active — the task is
    // cheap (one lock + comparison per second) +
    // ensures TTL-expired entries get cleaned up even
    // if no command or io_poll tick triggers a
    // lookup.
    {
        // Batch #314 D-9 migration: pull the clock authority
        // alongside the registry so the sweep loop runs the
        // monotonic-anchored is_past_now check (immune to
        // operator wallclock rollback within the process
        // lifetime).
        let (force_registry, clock_authority) = {
            let s = state.read().await;
            (s.force_registry.clone(), s.clock_authority.clone())
        };
        let (force_sweep_watch_tx, force_sweep_watch_rx) = tokio::sync::watch::channel(false);
        let mut force_broadcast_rx = shutdown_coordinator.subscribe();
        tokio::spawn(async move {
            let _ = force_broadcast_rx.recv().await;
            let _ = force_sweep_watch_tx.send(true);
        });
        let sweep_handle = tokio::spawn(async move {
            let summary = crate::scripting::force_registry::run_sweep_task_with_clock(
                force_registry,
                clock_authority,
                std::time::Duration::from_secs(1),
                force_sweep_watch_rx,
            )
            .await;
            info!(
                "force_registry_sweep exit: ticks={} total_expired={}",
                summary.ticks_executed, summary.total_expired
            );
        });
        shutdown_coordinator.register_task("force_registry_sweep", sweep_handle);
        info!("Force-registry sweep task spawned (1 Hz)");
    }

    // Batch #320 D-1b CLOSURE: spawn the keystore rotation
    // alarm runner. Reads the same marker that
    // init_keystore wrote/read at boot; emits structured
    // alarms on LeadTimeExceeded / Overdue every interval
    // (default 1 hour per ADR-018 §6 audit-sink dedup
    // window). Per-tick re-emission ensures restarted
    // agents that load an already-Overdue marker alarm
    // immediately on the first tick (Batch #317
    // architectural property pinned).
    //
    // Skipped when keystore.mode == Disabled — there's no
    // master key to track rotation for. TPM-mode (future
    // batch) handles rotation via NV counter, not this
    // marker.
    let keystore_mode_for_alarm = {
        let s = state.read().await;
        s.config.keystore.mode
    };
    if !matches!(
        keystore_mode_for_alarm,
        crate::config::KeystoreMode::Disabled
    ) {
        let clock_for_alarm = {
            let s = state.read().await;
            s.clock_authority.clone()
        };
        let marker_path = data_dir::data_dir().join(crate::keystore::ROTATION_MARKER_FILENAME);
        let (alarm_watch_tx, alarm_watch_rx) = tokio::sync::watch::channel(false);
        let mut alarm_broadcast_rx = shutdown_coordinator.subscribe();
        tokio::spawn(async move {
            let _ = alarm_broadcast_rx.recv().await;
            let _ = alarm_watch_tx.send(true);
        });
        let alarm_marker_path = marker_path.clone();
        let alarm_handle = tokio::spawn(async move {
            let summary = crate::keystore::run_keystore_rotation_alarm_task(
                alarm_marker_path,
                clock_for_alarm,
                std::time::Duration::from_secs(crate::keystore::DEFAULT_ALARM_INTERVAL_SECS),
                alarm_watch_rx,
            )
            .await;
            info!(
                "keystore_rotation_alarm exit: ticks={} lead_time_alarms={} \
                 overdue_alarms={} marker_missing={} clock_unhealthy={}",
                summary.ticks_executed,
                summary.lead_time_alarms,
                summary.overdue_alarms,
                summary.marker_missing_ticks,
                summary.clock_unhealthy_ticks,
            );
        });
        shutdown_coordinator.register_task("keystore_rotation_alarm", alarm_handle);
        info!(
            "Keystore rotation alarm runner spawned (interval={}s, marker={})",
            crate::keystore::DEFAULT_ALARM_INTERVAL_SECS,
            marker_path.display(),
        );
    }

    // Batch 171 Faz 3 + Batch 193 Faz 4 wire: spawn
    // the bytecode scan-cycle / scheduler driver(s).
    // Only when scripting is enabled — disabled
    // scripting (dev / edge-read-only mode) skips
    // spawning so the process image stays operator-
    // controlled without script writes.
    //
    // Dispatch-mode selection (Batch 193):
    // - `config.scripting.tasks` is EMPTY → spawn the
    //   Batch 170 single-cadence loop (backward compat
    //   with v1.6.0 config.yaml).
    // - `config.scripting.tasks` is NON-EMPTY →
    //   construct a TaskScheduler + spawn the Batch
    //   193 multi-task cadence loop + Batch 191 event
    //   listener.
    //
    // Shutdown bridging: ShutdownCoordinator emits a
    // broadcast `()` signal; both loops take a
    // `watch::Receiver<bool>`. A bridge task forwards
    // the broadcast → watch so each loop exits via
    // its `tokio::select!` path.
    {
        let (
            registry,
            pi,
            scan_cycle_ms,
            min_scan_cycle_ms,
            scripting_enabled,
            retain_persistence,
            tasks_config,
            license,
        ) = {
            let s = state.read().await;
            (
                s.bytecode_registry.clone(),
                s.process_image.clone(),
                s.config.scripting.default_scan_cycle_ms,
                s.config.scripting.min_scan_cycle_ms,
                s.config.scripting.enabled,
                s.retain_persistence.clone(),
                s.config.scripting.tasks.clone(),
                s.license.clone(),
            )
        };

        // Batch 214 Faz 7 wire: license task-scheduler cap.
        // Multi-task scheduler is active only when
        // `tasks_config` is non-empty (single-cadence path
        // below doesn't count against the cap because a
        // single scan-cycle is not a "scheduled task" in the
        // Faz 4 sense). Exceed = refuse to start the whole
        // multi-task scheduler — the single-cadence fallback
        // below stays available. Operator fixes config OR
        // upgrades tier.
        let license_permits_scheduler = if tasks_config.is_empty() {
            true
        } else {
            match crate::license::check_task_scheduler_budget(tasks_config.len(), &license) {
                crate::license::TaskSchedulerBudget::WithinBudget { .. } => true,
                crate::license::TaskSchedulerBudget::Exceeded { configured, cap } => {
                    warn!(
                        "multi-task scheduler NOT started: license cap hit (configured={} cap={} tier={}) — reduce tasks or upgrade tier",
                        configured,
                        cap,
                        license.tier.as_str(),
                    );
                    false
                }
            }
        };

        if scripting_enabled {
            // Batch 172 wire: build declared-types catalog
            // from the ProcessImage tag configs so Bool /
            // Int tags round-trip through the VM with
            // their declared type.
            let declared_types =
                crate::scripting::process_image_tagio::declared_types_from_process_image(&pi).await;
            info!(
                "Bytecode scan-cycle declared-types catalog: {} tag(s) mapped",
                declared_types.len()
            );

            if tasks_config.is_empty() || !license_permits_scheduler {
                // Single-cadence branch (Batch 170
                // preserved for backward compat). Also
                // used as the Batch 214 Faz 7 fallback
                // when the license denies the multi-task
                // scheduler — agent stays usable with the
                // legacy single-scan-cycle path until the
                // operator reduces tasks or upgrades tier.
                let (watch_tx, watch_rx) = tokio::sync::watch::channel(false);
                let mut broadcast_rx = shutdown_coordinator.subscribe();
                tokio::spawn(async move {
                    let _ = broadcast_rx.recv().await;
                    let _ = watch_tx.send(true);
                });

                let persistence_opt = retain_persistence;
                let scan_cycle_handle = tokio::spawn(async move {
                    let summary = crate::scripting::bytecode_scan_cycle_task::run_scan_cycle_loop(
                        registry,
                        pi,
                        declared_types,
                        persistence_opt,
                        scan_cycle_ms,
                        crate::scripting::bytecode_runner::ScanTickOptions::default(),
                        watch_rx,
                    )
                    .await;
                    info!(
                        "bytecode_scan_cycle exit: ticks={} ok={} failed={} overruns={}",
                        summary.ticks_executed,
                        summary.programs_ok,
                        summary.programs_failed,
                        summary.overrun_count
                    );
                });
                shutdown_coordinator.register_task("bytecode_scan_cycle", scan_cycle_handle);
                info!(
                    "Bytecode scan-cycle driver spawned (scan_cycle_ms={}, single-cadence)",
                    scan_cycle_ms
                );
            } else {
                // Multi-task scheduler branch (Batch 193).
                match crate::scripting::task_scheduler::TaskScheduler::new(tasks_config) {
                    Ok(scheduler) => {
                        let task_count = scheduler.task_count();
                        let scheduler_arc = std::sync::Arc::new(tokio::sync::Mutex::new(scheduler));

                        // Shared shutdown watch for the
                        // cadence loop + the event listener +
                        // the Batch #302 task_stats publisher
                        // (subscribe BEFORE the watch_tx is
                        // moved into the bridge spawn below).
                        let (watch_tx, _) = tokio::sync::watch::channel(false);
                        let cadence_rx = watch_tx.subscribe();
                        let listener_rx = watch_tx.subscribe();
                        let stats_rx = watch_tx.subscribe();
                        let mut broadcast_rx = shutdown_coordinator.subscribe();
                        tokio::spawn(async move {
                            let _ = broadcast_rx.recv().await;
                            let _ = watch_tx.send(true);
                        });

                        // Spawn event listener bridge.
                        // Batch #302: clone the scheduler Arc
                        // for the task_stats publisher BEFORE
                        // sched_listener is moved into the
                        // event listener spawn.
                        let pi_listener = pi.clone();
                        let sched_listener = scheduler_arc.clone();
                        let sched_stats = scheduler_arc.clone();
                        let listener_handle = tokio::spawn(async move {
                            let summary = crate::scripting::task_scheduler::run_event_listener(
                                &pi_listener,
                                sched_listener,
                                listener_rx,
                            )
                            .await;
                            info!(
                                "scheduler_event_listener exit: received={} matched={} lag={}",
                                summary.events_received, summary.events_matched, summary.lag_events
                            );
                        });
                        shutdown_coordinator
                            .register_task("scheduler_event_listener", listener_handle);

                        // Spawn the scheduler cadence loop.
                        let persistence_opt = retain_persistence;
                        let quantum_ms = min_scan_cycle_ms.max(10);
                        let sched_cadence = scheduler_arc;
                        let pi_cadence = pi;
                        let cadence_handle = tokio::spawn(async move {
                            let summary =
                                crate::scripting::task_scheduler::run_scheduler_cadence_loop(
                                    sched_cadence,
                                    registry,
                                    pi_cadence,
                                    declared_types,
                                    persistence_opt,
                                    crate::scripting::bytecode_runner::ScanTickOptions::default(),
                                    quantum_ms,
                                    cadence_rx,
                                )
                                .await;
                            info!(
                                "scheduler_cadence exit: ticks={} dispatches={} ok={} failed={} watchdog={}",
                                summary.quantum_ticks,
                                summary.total_task_dispatches,
                                summary.programs_ok,
                                summary.programs_failed,
                                summary.watchdog_trips,
                            );
                        });
                        shutdown_coordinator.register_task("scheduler_cadence", cadence_handle);

                        // Batch #302 Faz 4 step 5: per-task
                        // stats MQTT publisher loop. Spawns
                        // alongside the cadence + event-listener
                        // loops in the multi-task scheduler
                        // branch (single-cadence legacy doesn't
                        // have per-task stats). Publishes to
                        // `tenants/{tid}/devices/{did}/task_stats`
                        // at the configured interval (default 30s).
                        // sched_stats + stats_rx were cloned/
                        // subscribed earlier (above the moves).
                        let stats_interval = {
                            let s = state.read().await;
                            s.config.scripting.task_stats_publish_interval_secs
                        };
                        let stats_interval = stats_interval.clamp(5, 3600);
                        let stats_state = state.clone();
                        let stats_handle = tokio::spawn(async move {
                            crate::scripting::task_stats_publisher::run_task_stats_publisher_loop(
                                stats_state,
                                sched_stats,
                                stats_interval,
                                stats_rx,
                            )
                            .await;
                        });
                        shutdown_coordinator.register_task("task_stats_publisher", stats_handle);

                        info!(
                            "Bytecode multi-task scheduler spawned (tasks={}, quantum_ms={}, task_stats_interval={}s)",
                            task_count, quantum_ms, stats_interval
                        );
                    }
                    Err(e) => {
                        error!(
                            "Multi-task scheduler construction FAILED: {} — agent boots with NO bytecode dispatch. Operator must fix config.scripting.tasks.",
                            e
                        );
                    }
                }
            }
        } else {
            info!("Bytecode scan-cycle driver NOT spawned: config.scripting.enabled=false");
        }
    }

    // Batch 219+222 Faz 5: OPC UA server boot path.
    // Runs the Batch 218 init_opc_ua_server gate chain:
    //   operator config switch → Faz 7 license gate →
    //   tag-catalog build → server start →
    //   Batch 222 write-callback adapter wire.
    //
    // Spawns a cancel-bridge task so ShutdownCoordinator's
    // broadcast signal propagates to SuderraOpcUaHandle::
    // cancel. The server's internal run-loop JoinHandle is
    // owned by the SuderraOpcUaHandle; graceful shutdown
    // awaits that internally once cancel fires.
    #[cfg(feature = "opc-ua-server")]
    {
        let (
            opc_ua_cfg,
            pi_for_opcua,
            license_for_opcua,
            force_registry_for_opcua,
            audit_sink_for_opcua,
            rbac_store_for_opcua,
            user_token_store_for_opcua,
            tenant_id_str,
            device_code_string,
        ) = {
            let s = state.read().await;
            (
                s.config.opc_ua_server.clone(),
                s.process_image.clone(),
                s.license.clone(),
                s.force_registry.clone(),
                s.audit_sink.clone(),
                s.rbac_manifest_store.clone(),
                s.user_token_manifest_store.clone(),
                s.tenant_id.clone(),
                // Phase B-1.5 (ADR-031 §1) — capture device_code BEFORE the
                // read-guard scope closes. Cloned String avoids an
                // await-spanning borrow into AppState. The device_code is
                // recorded in the PkiStore genesis ledger entry to bind the
                // on-disk PKI state to a physical device.
                s.config.device_code.clone(),
            )
        };
        // Convert UUID-string tenant_id → TenantId bytes.
        // Missing or unparseable tenant → write callbacks
        // stay unwired; the server still boots with the
        // read path live (operator sees this in boot log).
        let tenant_opt = tenant_id_str.as_deref().and_then(|s| {
            uuid::Uuid::parse_str(s)
                .ok()
                .map(|u| crate::authz::permission::TenantId::new_from_verified(*u.as_bytes()))
        });
        // Batch #325 D-9 migration: pull clock_authority for
        // the OPC UA write-path received_at gate.
        let clock_authority_for_opcua = {
            let s = state.read().await;
            s.clock_authority.clone()
        };
        match opc_ua_server_runtime::init_opc_ua_server(opc_ua_server_runtime::OpcUaInitDeps {
            config: &opc_ua_cfg,
            process_image: &pi_for_opcua,
            force_registry: force_registry_for_opcua,
            audit_sink: audit_sink_for_opcua,
            tenant: tenant_opt,
            rbac_manifest_store: rbac_store_for_opcua,
            user_token_manifest_store: user_token_store_for_opcua,
            license: &license_for_opcua,
            device_code: &device_code_string,
            clock_authority: clock_authority_for_opcua,
        })
        .await
        {
            Ok(Some(handle)) => {
                // Cancel-bridge task: on ShutdownCoordinator
                // broadcast, invoke handle.cancel() so the
                // async-opcua run-loop exits cleanly.
                let handle_for_bridge = handle.clone();
                let mut broadcast_rx = shutdown_coordinator.subscribe();
                let bridge_handle = tokio::spawn(async move {
                    let _ = broadcast_rx.recv().await;
                    handle_for_bridge.cancel();
                    info!("opc_ua_server: cancel signal forwarded from ShutdownCoordinator");
                });
                shutdown_coordinator.register_task("opc_ua_cancel_bridge", bridge_handle);

                let summary_pop = handle
                    .population()
                    .cloned()
                    .map(|s| {
                        format!(
                            "variables={} writable={}",
                            s.variable_nodes_added, s.writable_nodes,
                        )
                    })
                    .unwrap_or_else(|| "(no summary)".to_string());
                info!(
                    "opc_ua_server boot OK: ns_index={:?} {}",
                    handle.namespace_index(),
                    summary_pop
                );
                let mut w = state.write().await;
                w.opc_ua_server = Some(handle);
            }
            Ok(None) => {
                info!(
                    "opc_ua_server boot skipped (either operator switch OFF or license gate closed)"
                );
            }
            Err(e) => {
                // Init failure is NOT fatal — the agent
                // stays operational without OPC UA, and the
                // operator sees the structured reason. Other
                // subsystems (MQTT, scan-cycle, scheduler)
                // continue unaffected.
                error!("opc_ua_server boot FAILED: {}", e);
            }
        }
    }

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
            let cold_boot_budget_secs = crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;
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
                    tenant: crate::authz::permission::TenantId::new_from_verified(tenant_bytes),
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
            shutdown_coordinator.register_task("cold_boot_watchdog", watchdog_handle);
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
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
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
        // EDGE-CRITICAL-002: the SCADA store's at-rest key is derived via
        // the keystore/TPM-aware consumer-key resolver (device-bound),
        // replacing the machine-id-only key + universal fallback.
        let (scada_keystore, scada_deployment_uuid) = {
            let s = state.read().await;
            (s.keystore.clone(), s.config.device_id.clone().into_bytes())
        };
        let scada_db =
            match scada_db::ScadaDb::new(&scada_db_path, scada_keystore, scada_deployment_uuid)
                .await
            {
                Ok(db) => {
                    info!("SCADA database initialized: {}", scada_db_path);
                    Some(Arc::new(db))
                }
                Err(e) => {
                    warn!(
                        "Failed to initialize SCADA database: {}. Runtime features degraded.",
                        e
                    );
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
            let scada_state = scada_server::ScadaState::new_with_runtime(process_image, db, cmd_tx);
            let _scada_handle = scada_server::start_scada_server(scada_state.clone()).await;

            // Store in app state
            {
                let mut state_guard = state.write().await;
                state_guard.scada_state = Some(scada_state.clone());
                state_guard.scada_db = scada_db;
            }
        } else {
            warn!(
                "SCADA database unavailable — SCADA display server will NOT start. Device operates in sensor-only mode."
            );
            let mut state_guard = state.write().await;
            state_guard.scada_db = None;
        }

        // Spawn command executor task (EDGE-HIGH-015: shutdown-
        // coordinated — it exits on the shutdown broadcast and refuses
        // to drive an actuator once shutdown has begun, so an HMI write
        // can never overwrite the safe-state value in the
        // safe-state→disconnect window).
        let cmd_state = state.clone();
        let mut exec_shutdown = shutdown_coordinator.subscribe();
        let exec_handle = tokio::spawn(async move {
            use crate::process_image::{ProtocolConfig, TagQuality};

            loop {
                let cmd = tokio::select! {
                    biased;
                    _ = exec_shutdown.recv() => break,
                    maybe = cmd_rx.recv() => match maybe {
                        Some(c) => c,
                        None => break,
                    },
                };
                // Never drive an actuator once shutdown has begun —
                // mirrors the MQTT command gate (dispatch_lifecycle).
                if cmd_state
                    .read()
                    .await
                    .is_shutting_down
                    .load(std::sync::atomic::Ordering::Acquire)
                {
                    continue;
                }
                let result = async {
                    let s = cmd_state.read().await;
                    let config = s
                        .process_image
                        .get_config(&cmd.tag)
                        .await
                        .ok_or_else(|| format!("Tag '{}' not found", cmd.tag))?;

                    let write_result = match &config.protocol_config {
                        ProtocolConfig::Gpio { pin, .. } => {
                            if let Some(ref handle) = s.gpio_handle {
                                handle
                                    .write_pin(*pin, cmd.value != 0.0)
                                    .await
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
                                        handle
                                            .write_coil(&device.name, *register, cmd.value != 0.0)
                                            .await
                                            .map_err(|e| format!("Modbus coil: {}", e))
                                    } else {
                                        // Analog output: reverse-scale and write register
                                        let raw_value = reverse_scale(cmd.value, &config);
                                        handle
                                            .write_register(
                                                &device.name,
                                                *register,
                                                raw_value as u16,
                                            )
                                            .await
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
                                handle
                                    .write_direct(&cmd.tag, &data)
                                    .await
                                    .map_err(|e| format!("I2C: {}", e))
                            } else {
                                Err("I2C unavailable".to_string())
                            }
                        }
                        _ => Err(format!(
                            "Write unsupported for {:?}",
                            config.protocol_config
                        )),
                    };

                    match write_result {
                        Ok(()) => {
                            s.process_image
                                .update_tag(&cmd.tag, cmd.value, TagQuality::Good, config.source)
                                .await;
                            info!("SCADA command executed: {} = {}", cmd.tag, cmd.value);
                            Ok(cmd.value)
                        }
                        Err(e) => {
                            warn!("SCADA command failed: {} = {} - {}", cmd.tag, cmd.value, e);
                            Err(e)
                        }
                    }
                }
                .await;

                let _ = cmd.response_tx.send(result);
            }
        });
        shutdown_coordinator.register_task("scada_cmd_executor", exec_handle);

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

    // Step 8: Read shared RETAIN persistence from
    // AppState. Batch 177 moved the init to
    // AppState::init_retain_persistence (called above,
    // before the bytecode scan-cycle spawn) so both
    // the legacy ScriptEngine + the bytecode scan-cycle
    // orchestrator share ONE SqlitePersistence handle +
    // key ceremony. Data dir logging is still useful
    // here for operator diagnosis.
    match std::env::var(data_dir::DATA_DIR_ENV_VAR) {
        Ok(dir) => info!(
            "Using data directory from {}: {}",
            data_dir::DATA_DIR_ENV_VAR,
            dir
        ),
        Err(_) => debug!(
            "{} not set, using default: {}",
            data_dir::DATA_DIR_ENV_VAR,
            data_dir::DEFAULT_DATA_DIR
        ),
    }
    let persistence = {
        let s = state.read().await;
        s.retain_persistence.clone()
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

    // Batch #258 C-7 fix — flip the shutdown-race gate BEFORE
    // signaling tasks. Every command-dispatch path checks
    // `is_shutting_down` at the top of `execute_command`; flipping
    // here guarantees that any command arriving AFTER this point
    // gets the structured ServiceShuttingDown rejection rather
    // than racing the in-progress safe-state transition.
    {
        let state_guard = state.read().await;
        state_guard
            .is_shutting_down
            .store(true, std::sync::atomic::Ordering::Release);
    }
    info!("Shutdown race gate flipped: new commands will be rejected with ServiceShuttingDown");

    // EDGE-HIGH-015 / PR935-HIGH-003: whole-sequence shutdown deadline. The
    // coordinator now drains tasks CONCURRENTLY (src/shutdown.rs), so the
    // whole drain is bounded to one `shutdown_timeout_secs` regardless of task
    // count, and the safe-state phase below is reached in well under this
    // ceiling. This watchdog is the last-resort backstop for a wedge in
    // safe-state / flush itself.
    //
    // Two correctness properties the previous tokio-task watchdog lacked:
    //   1. It runs on a DETACHED OS THREAD, not a tokio task. The wedge class
    //      this backstop exists for includes CPU-bound / blocking tasks that
    //      starve the 2-worker runtime — a `tokio::time::sleep` timer would be
    //      starved alongside them and never fire, degrading to the SIGKILL it
    //      was built to pre-empt. `std::thread::sleep` is immune to runtime
    //      starvation.
    //   2. It exits NON-ZERO. A forced exit that skipped the safe-state /
    //      flush phases is a FAILURE; systemd `Restart=on-failure`, the
    //      hardware watchdog, and the PLC-side fail-safe must all see it as
    //      one. Exiting 0 previously told monitoring the shutdown was clean.
    let hard_deadline_secs = shutdown_timeout_secs
        .saturating_mul(2)
        .saturating_add(10)
        .min(80);
    std::thread::Builder::new()
        .name("shutdown-watchdog".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(hard_deadline_secs));
            // eprintln!, not tracing: a wedged runtime may also stall a
            // tracing appender; stderr is the robust last-resort sink.
            eprintln!(
                "FATAL: graceful shutdown exceeded {hard_deadline_secs}s hard deadline — \
                 forcing non-zero exit. Safe-state may be incomplete; external \
                 watchdog / PLC fail-safe must take over."
            );
            std::process::exit(1);
        })
        .expect("failed to spawn shutdown-watchdog thread");

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
    let (offline_queue, drain_shutdown, drain_handle) = {
        let mut state_guard = state.write().await;
        (
            state_guard.offline_queue.clone(),
            state_guard.outbound_publisher_drain_shutdown.take(),
            state_guard.outbound_publisher_drain_handle.take(),
        )
    };
    // 2026-04-29 enterprise offline queue shutdown:
    // stop the drain task, await its exit, then force SQLite checkpoint/fsync.
    //
    // What it solves: the shutdown "flush" phase is no longer a placeholder;
    // it coordinates the live drain loop and durable queue storage in a
    // deterministic order.
    if let Some(tx) = drain_shutdown {
        if tx.send(()).is_err() {
            warn!("Offline queue drain task was already stopped before shutdown signal");
        }
    }
    if let Some(mut handle) = drain_handle {
        match tokio::time::timeout(Duration::from_millis(drain_timeout_ms), &mut handle).await {
            Ok(Ok(())) => info!("Offline queue drain task stopped cleanly"),
            Ok(Err(e)) => warn!("Offline queue drain task join failed: {}", e),
            Err(_) => {
                warn!(
                    "Offline queue drain task did not stop within {}ms; aborting before checkpoint",
                    drain_timeout_ms
                );
                handle.abort();
                match handle.await {
                    Ok(()) => info!("Offline queue drain task stopped after abort"),
                    Err(e) if e.is_cancelled() => {
                        info!("Offline queue drain task aborted before checkpoint")
                    }
                    Err(e) => warn!("Offline queue drain task abort join failed: {}", e),
                }
            }
        }
    }
    if let Some(queue) = offline_queue {
        match queue.checkpoint_and_fsync_async().await {
            Ok(()) => info!("Offline queue flush step complete"),
            Err(e) => error!("Offline queue checkpoint/fsync failed: {:#}", e),
        }
    } else {
        info!("Offline queue flush skipped: queue not initialized");
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
                let topic = format!("suderra/{}/status", state_guard.config.device_id);
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
            state_guard
                .config
                .lorawan
                .as_ref()
                .map_or(false, |c| c.enabled)
        };

        if should_init {
            let lora_handle = {
                let state_guard = state.read().await;
                let Some(lora_cfg) = state_guard.config.lorawan.as_ref() else {
                    error!(
                        "LoRaWAN init skipped: config disappeared between readiness check and handle creation"
                    );
                    return;
                };
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
    let resolved = state
        .config
        .mqtt
        .topics
        .resolve(tenant_id, &state.config.device_id);
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
    match (
        config.raw_min,
        config.raw_max,
        config.eng_min,
        config.eng_max,
    ) {
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
