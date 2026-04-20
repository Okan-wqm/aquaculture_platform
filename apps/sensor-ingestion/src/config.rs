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

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::ConfigError;

/// Default path consulted when neither argv nor env supplies one.
pub const DEFAULT_CONFIG_PATH: &str = "/etc/sensor-ingestion/config.toml";

/// Env var consulted when no `--config` argv is given.
pub const CONFIG_PATH_ENV: &str = "SENSOR_INGESTION_CONFIG";

/// Top-level config struct. Each section maps to one of the workspace
/// crates the binary wires together.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Tracing / observability init knobs. See
    /// [`observability::TracingOpts`].
    pub observability: observability::TracingOpts,

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

/// MQTT broker connection. The actual subscriber (rumqttc) lands in a
/// follow-on commit; this struct is here so the config TOML schema is
/// stable from day one.
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
}

const fn default_qos() -> u8 {
    1
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
        toml::from_str(&raw).map_err(|source| ConfigError::ParseToml {
            path: path.to_path_buf(),
            source,
        })
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

    use super::{Config, RuntimeConfig};

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
}
