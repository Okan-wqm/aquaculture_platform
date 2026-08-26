//! Top-level configuration for `sensor-ingestion`.
//!
//! Loaded from a TOML file whose path is supplied via:
//!   1. `--config <path>` argv (highest precedence).
//!   2. `SENSOR_INGESTION_CONFIG` env var.
//!   3. Default: `/etc/sensor-ingestion/config.toml`.
//!
//! Individual fields can also be overridden via env vars (matched
//! upper-snake-cased with prefix `SENSOR_INGESTION__`, e.g.
//! `SENSOR_INGESTION__RUNTIME__WORKER_THREADS=2`). This file ships
//! only the TOML path; the env-var merge layer lands when the
//! deployment pipeline calls for it (Faz 2 stage 5+).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ConfigError;

/// Default path consulted when neither argv nor env supplies one.
pub const DEFAULT_CONFIG_PATH: &str = "/etc/sensor-ingestion/config.toml";

/// Env var consulted when no `--config` argv is given.
pub const CONFIG_PATH_ENV: &str = "SENSOR_INGESTION_CONFIG";

/// Secret-only override. The production compose passes the dedicated database
/// role password here so credentials never need to exist in the mounted TOML.
pub const POSTGRES_PASSWORD_ENV: &str = "SENSOR_INGESTION_POSTGRES_PASSWORD";
pub const MQTT_USERNAME_ENV: &str = "SENSOR_INGESTION_MQTT_USERNAME";
pub const MQTT_PASSWORD_ENV: &str = "SENSOR_INGESTION_MQTT_PASSWORD";

/// Top-level config struct. Each section maps to one of the workspace
/// crates the binary wires together.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Tracing / observability init knobs. See
    /// [`observability::TracingOpts`].
    pub observability: observability::TracingOpts,

    /// Prometheus metrics exporter knobs. Off by default — every
    /// stub-mode / smoke-run boot stays silent. A production deploy
    /// enables via the `[metrics]` block in config.toml; the global
    /// recorder installs at boot and (when `bind_addr` is set) the
    /// `/metrics` HTTP endpoint starts on that socket.
    ///
    /// See [`observability::MetricsOpts`] for the field shape.
    #[serde(default)]
    pub metrics: observability::MetricsOpts,

    /// Tokio runtime tuning (worker threads, blocking pool, etc.).
    /// Defaults match the plan's
    /// `docs/plans/sensor-rust-migration/PLAN.md` § Faz 2 Tokio
    /// Runtime Tuning section.
    #[serde(default)]
    pub runtime: RuntimeConfig,

    /// MQTT broker connection. Filled in by a follow-on commit when
    /// the rumqttc subscribe loop lands.
    #[serde(default)]
    pub mqtt: Option<MqttConfig>,

    /// NATS broker connection (mTLS-only per ADR-014/015).
    /// Filled in by a follow-on commit when the publisher lands.
    #[serde(default)]
    pub nats: Option<nats_client::MtlsConfig>,

    /// PostgreSQL / TimescaleDB connection. When present the binary
    /// wires `PostgresSink` as the persistence layer; when absent the
    /// stub `LoggingSink` is used (sidecar boots clean without a DB
    /// for smoke tests).
    #[serde(default)]
    pub postgres: Option<crate::persistence::PostgresConfig>,

    /// Per-tenant `IngestBackend` selection — the strangler-fig
    /// rollout switch (ADR-025 / ADR-027 `docs/adr/027-per-tenant-
    /// ingest-backend-toggle.md`). Default: `Node`, every tenant routes
    /// to NestJS `sensor-service`. Tenants explicitly listed under
    /// `tenant_overrides` are processed by this Rust sidecar.
    #[serde(default)]
    pub ingest_backend: IngestBackendConfig,
}

/// Tokio runtime tuning. Defaults track the plan exactly so the
/// production posture is the same with or without an operator-supplied
/// override.
///
/// The plan also calls for the LIFO-slot to stay enabled. On stable
/// tokio the LIFO slot is always on and there is no public toggle —
/// disabling it requires the unstable `tokio_unstable` cfg flag plus
/// the private `disable_lifo_slot` builder method. Until we have a
/// concrete reason to opt out (and the willingness to depend on
/// `tokio_unstable`), the knob is intentionally absent from this
/// struct so the operator cannot configure something we have no
/// switch for.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    /// Number of worker threads. Plan: 2 (because the container's
    /// CPU budget is 0.35 vCPU; more workers = pure context-switch
    /// overhead).
    #[serde(default = "default_worker_threads")]
    pub worker_threads: usize,

    /// Maximum size of the blocking thread pool. Plan: 8 (DB COPY
    /// blocking pool runs separately from the async workers).
    #[serde(default = "default_max_blocking_threads")]
    pub max_blocking_threads: usize,

    /// Per-thread stack size in kilobytes. Plan: 256 KiB (saves
    /// ~4 MiB heap given 16 max threads).
    #[serde(default = "default_thread_stack_kb")]
    pub thread_stack_kb: usize,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            worker_threads: default_worker_threads(),
            max_blocking_threads: default_max_blocking_threads(),
            thread_stack_kb: default_thread_stack_kb(),
        }
    }
}

const fn default_worker_threads() -> usize {
    2
}
const fn default_max_blocking_threads() -> usize {
    8
}
const fn default_thread_stack_kb() -> usize {
    256
}

/// MQTT broker connection.
///
/// WHY the three TLS material fields are `Option<PathBuf>`:
///   The dev-mode local broker uses plain `mqtt://`; cloud production
///   uses `mqtts://` with the platform CA pinned (no system roots) and
///   a client cert that authenticates the sidecar (ADR-014/015 cert-
///   is-identity, mirrored from the NATS posture). The `Option` keeps
///   dev-mode boot frictionless — but [`crate::mqtt::validate_config`]
///   refuses to start when the URL scheme is `mqtts://` and any of the
///   three paths is missing, so a misconfiguration cannot fall through
///   to silent system-roots TLS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    /// Broker URL (`mqtts://broker:8883` or `mqtt://broker:1883`).
    pub broker_url: String,
    /// MQTT client id. MUST be globally unique within the broker so
    /// session takeover semantics behave.
    pub client_id: String,
    /// Topic filters to subscribe to on connect. Plan defaults:
    /// `sensors/#` and `tenants/+/devices/+/io_data`.
    pub topic_filters: Vec<String>,
    /// QoS level. Plan: 1 (at-least-once; QoS-2 is not part of the
    /// baseline).
    #[serde(default = "default_qos")]
    pub qos: u8,
    /// Dedicated broker username for the internal HTTP-auth listener.
    #[serde(default)]
    pub username: Option<String>,
    /// Broker credential. Production overrides the mounted placeholder via env.
    #[serde(default)]
    pub password: Option<String>,
    /// PEM-encoded broker CA certificate. REQUIRED when `broker_url`
    /// uses the `mqtts://` scheme. System roots are NEVER consulted —
    /// the platform CA is the only trust anchor. Optional for plain
    /// `mqtt://` to keep local-broker dev boots frictionless.
    #[serde(default)]
    pub server_ca_cert_pem: Option<PathBuf>,
    /// PEM-encoded client certificate used for mTLS. REQUIRED when
    /// `broker_url` uses the `mqtts://` scheme.
    #[serde(default)]
    pub client_cert_pem: Option<PathBuf>,
    /// PEM-encoded client private key paired with `client_cert_pem`.
    /// REQUIRED when `broker_url` uses the `mqtts://` scheme.
    #[serde(default)]
    pub client_key_pem: Option<PathBuf>,
}

impl MqttConfig {
    /// Returns true when the broker URL uses the `mqtts://` scheme.
    /// The mTLS material fields are then required; the validator
    /// enforces the rule at process start so misconfiguration cannot
    /// surface only at first publish.
    #[must_use]
    pub fn tls_required(&self) -> bool {
        self.broker_url.starts_with("mqtts://")
    }
}

const fn default_qos() -> u8 {
    1
}

/// Backend that processes a tenant's ingestion stream — the strangler-
/// fig rollout knob per ADR-025. `Node` keeps the existing NestJS
/// `sensor-service` pipeline; `Rust` routes the tenant to this sidecar.
///
/// WHY the lowercase serde representation:
///   The TOML config uses lowercase string literals (`"node"`,
///   `"rust"`) to match the operator-facing CLI / log convention and
///   the `INGEST_BACKEND` env-var values from `docs/adr/_draft/025-
///   rust-sidecar-architecture.md` Faz 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IngestBackend {
    /// Tenant stays on the NestJS `sensor-service` ingestion path —
    /// the safe default for every tenant not explicitly opted in.
    Node,
    /// Tenant is processed by this Rust sidecar.
    Rust,
}

impl Default for IngestBackend {
    fn default() -> Self {
        Self::Node
    }
}

/// Per-tenant `IngestBackend` selection. Constructed from the
/// `[ingest_backend]` TOML section; consumed by
/// [`crate::ingest_backend::IngestBackendSnapshot::from_config`] to
/// seed the production [`crate::ingest_backend::DynamicBackendPolicy`]
/// (ADR-031). The test-only `StaticBackendPolicy` also accepts this
/// same config shape so test harnesses + production paths remain
/// wire-compatible.
///
/// WHY a HashMap of UUIDs and not a bitmap or interval set:
///   Tenants opt in one at a time as the rollout proceeds. The override
///   table is expected to grow from 0 entries (greenfield) through
///   single digits during pilot to the full tenant set at cutover. A
///   HashMap lookup is O(1) and the operator-facing diff stays
///   readable in PR review (each tenant id is a single TOML line).
///
/// WHY default = Node (no overrides):
///   Safe rollout: a misconfigured `[ingest_backend]` section degrades
///   to "no behaviour change" rather than "every tenant flipped". The
///   policy gate in `main::drain_mqtt_stream` then drops messages for
///   every tenant, which is observable via the `node_routed_count`
///   counter — operators see the gate is on but the override list is
///   empty, instead of the sidecar silently double-processing.
///
/// WHY the disk + bootstrap knobs live HERE rather than a separate
/// `[policy_bootstrap]` block:
///   ADR-031 treats the policy as one architectural concern. The
///   cold-start fallback chain (NATS → disk → TOML) is a property of
///   the same gate the `default_backend` / `tenant_overrides` configure.
///   Splitting the config into two blocks would let operators drift the
///   two — e.g. a disk path on one side with no overrides on the
///   other — where keeping them together makes a misconfigured rollout
///   impossible to construct (the invalid state has no representation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestBackendConfig {
    /// Backend used for any tenant that is not in `tenant_overrides`.
    /// Defaults to [`IngestBackend::Node`].
    #[serde(default)]
    pub default_backend: IngestBackend,

    /// Per-tenant override table. Tenants present here are processed
    /// by the named backend regardless of `default_backend`.
    #[serde(default)]
    pub tenant_overrides: HashMap<Uuid, IngestBackend>,

    /// On-disk path the sidecar writes the latest authoritative
    /// policy snapshot to after every
    /// `policy.ingest_backend.changed` event.
    /// On a cold boot where NATS is unreachable, this file is the
    /// second preference in the fallback chain (after a live NATS
    /// snapshot, before the TOML `default_backend` /
    /// `tenant_overrides` pair). Defaults to
    /// `/var/lib/sensor-ingestion/last-known-policy.json`.
    #[serde(default = "default_policy_disk_fallback_path")]
    pub disk_fallback_path: PathBuf,

    /// Wall-clock timeout for ONE `policy.ingest_backend.snapshot`
    /// request-reply attempt at cold-start. Units: seconds.
    /// See [`crate::policy::bootstrap_policy`] for the retry +
    /// fallback sequence. Default: 5 seconds (matches the plan's
    /// NATS round-trip budget + 3σ jitter headroom).
    #[serde(default = "default_policy_snapshot_timeout_secs")]
    pub snapshot_request_timeout_secs: u64,

    /// Maximum number of NATS request-reply attempts before the
    /// bootstrap path falls back to disk / TOML.
    /// Default: 3. With the 5s timeout, the worst-case bootstrap
    /// wall-clock is 15 seconds before the fallback engages — long
    /// enough to absorb a broker failover, short enough that operators
    /// are not left wondering why the sidecar has not started draining
    /// yet.
    #[serde(default = "default_policy_snapshot_retries")]
    pub snapshot_request_retries: u8,
}

fn default_policy_disk_fallback_path() -> PathBuf {
    PathBuf::from("/var/lib/sensor-ingestion/last-known-policy.json")
}

const fn default_policy_snapshot_timeout_secs() -> u64 {
    5
}

const fn default_policy_snapshot_retries() -> u8 {
    3
}

impl Default for IngestBackendConfig {
    fn default() -> Self {
        Self {
            default_backend: IngestBackend::Node,
            tenant_overrides: HashMap::new(),
            disk_fallback_path: default_policy_disk_fallback_path(),
            snapshot_request_timeout_secs: default_policy_snapshot_timeout_secs(),
            snapshot_request_retries: default_policy_snapshot_retries(),
        }
    }
}

impl Config {
    /// Resolve the config-file path per the precedence in the module
    /// docs and load it.
    ///
    /// Errors:
    /// - [`ConfigError::ReadFile`] — file missing or unreadable.
    /// - [`ConfigError::ParseToml`] — TOML deserialisation failed.
    pub fn load_from_env_or_default() -> Result<Self, ConfigError> {
        let path = resolve_config_path();
        Self::load_from_path(&path)
    }

    /// Load from a specific path. Used by tests + the public
    /// load_from_env_or_default after path resolution.
    pub fn load_from_path(path: &Path) -> Result<Self, ConfigError> {
        let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::ReadFile {
            path: path.to_path_buf(),
            source,
        })?;
        let mut config: Self = toml::from_str(&raw).map_err(|source| ConfigError::ParseToml {
            path: path.to_path_buf(),
            source,
        })?;
        apply_postgres_password_override(&mut config, std::env::var(POSTGRES_PASSWORD_ENV).ok());
        apply_mqtt_credentials_override(
            &mut config,
            std::env::var(MQTT_USERNAME_ENV).ok(),
            std::env::var(MQTT_PASSWORD_ENV).ok(),
        );
        Ok(config)
    }
}

fn apply_mqtt_credentials_override(
    config: &mut Config,
    username: Option<String>,
    password: Option<String>,
) {
    if let Some(mqtt) = &mut config.mqtt {
        if let Some(username) = username.filter(|value| !value.is_empty()) {
            mqtt.username = Some(username);
        }
        if let Some(password) = password.filter(|value| !value.is_empty()) {
            mqtt.password = Some(password);
        }
    }
}

fn apply_postgres_password_override(config: &mut Config, password: Option<String>) {
    if let (Some(postgres), Some(password)) = (&mut config.postgres, password)
        && !password.is_empty()
    {
        postgres.password = password;
    }
}

fn resolve_config_path() -> PathBuf {
    // argv takes precedence — `--config <path>`.
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == "--config" {
            if let Some(value) = args.next() {
                return PathBuf::from(value);
            }
        }
    }
    if let Ok(value) = std::env::var(CONFIG_PATH_ENV) {
        return PathBuf::from(value);
    }
    PathBuf::from(DEFAULT_CONFIG_PATH)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::NamedTempFile;

    use super::{Config, RuntimeConfig, apply_postgres_password_override};

    fn write_config(toml: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(toml.as_bytes()).unwrap();
        f
    }

    #[test]
    fn minimal_config_loads_with_defaults() {
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"
        "#;
        let f = write_config(toml);
        let cfg = Config::load_from_path(f.path()).unwrap();
        assert_eq!(cfg.observability.service_name, "sensor-ingestion");
        assert_eq!(cfg.runtime.worker_threads, 2);
        assert_eq!(cfg.runtime.max_blocking_threads, 8);
        assert_eq!(cfg.runtime.thread_stack_kb, 256);
        assert!(cfg.mqtt.is_none());
        assert!(cfg.nats.is_none());
    }

    #[test]
    fn runtime_defaults_match_plan() {
        let r = RuntimeConfig::default();
        assert_eq!(r.worker_threads, 2);
        assert_eq!(r.max_blocking_threads, 8);
        assert_eq!(r.thread_stack_kb, 256);
    }

    #[test]
    fn postgres_password_secret_override_replaces_mounted_placeholder() {
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"

            [postgres]
            host = "postgres"
            port = 5432
            db_name = "aquaculture"
            user = "sensor_ingestion"
            password = "REPLACE_FROM_SECRETS"
            ca_cert_pem = "/etc/postgres/ca.pem"
            pool_size = 4
        "#;
        let mut config: Config = toml::from_str(toml).unwrap();
        apply_postgres_password_override(&mut config, Some("runtime-secret".to_owned()));

        assert_eq!(config.postgres.unwrap().password, "runtime-secret");
    }

    #[test]
    fn runtime_tuning_overridable() {
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"

            [runtime]
            worker_threads = 4
            max_blocking_threads = 16
            thread_stack_kb = 512
        "#;
        let f = write_config(toml);
        let cfg = Config::load_from_path(f.path()).unwrap();
        assert_eq!(cfg.runtime.worker_threads, 4);
        assert_eq!(cfg.runtime.max_blocking_threads, 16);
        assert_eq!(cfg.runtime.thread_stack_kb, 512);
    }

    #[test]
    fn load_from_path_missing_file() {
        let r = Config::load_from_path(std::path::Path::new("/nonexistent/sensor.toml"));
        match r {
            Err(super::ConfigError::ReadFile { path, .. }) => {
                assert_eq!(path.to_str().unwrap(), "/nonexistent/sensor.toml");
            }
            other => panic!("expected ReadFile, got {other:?}"),
        }
    }

    #[test]
    fn load_from_path_malformed_toml() {
        let f = write_config("this isn't TOML = ====");
        let r = Config::load_from_path(f.path());
        match r {
            Err(super::ConfigError::ParseToml { .. }) => {}
            other => panic!("expected ParseToml, got {other:?}"),
        }
    }

    #[test]
    fn mqtt_section_parses_when_present() {
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"

            [mqtt]
            broker_url = "mqtts://broker.internal:8883"
            client_id = "sensor-ingestion-1"
            topic_filters = ["sensors/#", "tenants/+/devices/+/io_data"]
        "#;
        let f = write_config(toml);
        let cfg = Config::load_from_path(f.path()).unwrap();
        let m = cfg.mqtt.unwrap();
        assert_eq!(m.broker_url, "mqtts://broker.internal:8883");
        assert_eq!(m.client_id, "sensor-ingestion-1");
        assert_eq!(m.topic_filters.len(), 2);
        assert_eq!(m.qos, 1);
    }

    #[test]
    fn nats_section_parses_when_present() {
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"

            [nats]
            server_url = "tls://nats.internal:4222"
            server_ca_cert_pem = "/etc/aqua/ca.pem"
            client_cert_pem = "/etc/aqua/client.crt"
            client_key_pem = "/etc/aqua/client.key"
            connect_timeout = 15
        "#;
        let f = write_config(toml);
        let cfg = Config::load_from_path(f.path()).unwrap();
        let n = cfg.nats.unwrap();
        assert_eq!(n.server_url, "tls://nats.internal:4222");
        assert_eq!(n.connect_timeout.as_secs(), 15);
    }

    #[test]
    fn mqtt_tls_required_only_for_mqtts() {
        // WHY assert both branches: tls_required is the gate the
        // validator uses to decide whether to enforce the cert-paths-
        // present rule, so a regression on it would silently let
        // mqtts:// boot without the platform CA pinned.
        let mut m = super::MqttConfig {
            broker_url: "mqtt://broker:1883".to_owned(),
            client_id: "x".to_owned(),
            topic_filters: vec!["sensors/#".to_owned()],
            qos: 1,
            username: None,
            password: None,
            server_ca_cert_pem: None,
            client_cert_pem: None,
            client_key_pem: None,
        };
        assert!(!m.tls_required(), "plain mqtt:// must not require TLS");
        m.broker_url = "mqtts://broker:8883".to_owned();
        assert!(m.tls_required(), "mqtts:// must require TLS");
    }

    #[test]
    fn mqtt_config_default_tls_paths_are_none() {
        // Round-trip through TOML without supplying any of the new TLS
        // material fields. WHY: every existing operator config file
        // pre-stage-13 omits these; the deserializer must default them
        // to None or every existing TOML file would suddenly fail to
        // parse.
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"

            [mqtt]
            broker_url = "mqtt://broker:1883"
            client_id = "x"
            topic_filters = ["sensors/#"]
        "#;
        let f = write_config(toml);
        let cfg = Config::load_from_path(f.path()).unwrap();
        let m = cfg.mqtt.unwrap();
        assert!(m.server_ca_cert_pem.is_none());
        assert!(m.client_cert_pem.is_none());
        assert!(m.client_key_pem.is_none());
    }

    #[test]
    fn ingest_backend_section_parses_when_present() {
        // The TOML inline-table syntax for the override map is the
        // operator-facing default per ADR-025 §rollout. WHY assert
        // the round-trip: the rename_all = "lowercase" and Default
        // impl together decide every behaviour the rollout depends on.
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"

            [ingest_backend]
            default_backend = "node"
            tenant_overrides = { "11111111-1111-1111-1111-111111111111" = "rust" }
        "#;
        let f = write_config(toml);
        let cfg = Config::load_from_path(f.path()).unwrap();
        assert_eq!(
            cfg.ingest_backend.default_backend,
            super::IngestBackend::Node
        );
        let overridden = uuid::Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        assert_eq!(
            cfg.ingest_backend
                .tenant_overrides
                .get(&overridden)
                .copied(),
            Some(super::IngestBackend::Rust)
        );
        assert_eq!(cfg.ingest_backend.tenant_overrides.len(), 1);
    }

    #[test]
    fn ingest_backend_defaults_when_section_missing() {
        // No [ingest_backend] block at all — the rollout must default
        // to "every tenant on Node" so a misconfigured deploy cannot
        // silently flip every tenant onto the Rust path.
        let toml = r#"
            [observability]
            service_name = "sensor-ingestion"
            service_version = "0.1.0"
        "#;
        let f = write_config(toml);
        let cfg = Config::load_from_path(f.path()).unwrap();
        assert_eq!(
            cfg.ingest_backend.default_backend,
            super::IngestBackend::Node
        );
        assert!(cfg.ingest_backend.tenant_overrides.is_empty());
    }
}
