//! Top-level error types for `sensor-ingestion`.
//!
//! Each subsystem (config loader, runtime builder, MQTT subscriber,
//! ...) keeps its own typed error variant; the binary's `main`
//! converts them into process exit codes documented in the module
//! header of `main.rs`.

use std::path::PathBuf;

use thiserror::Error;

/// Errors raised while loading [`crate::config::Config`].
#[derive(Debug, Error)]
pub enum ConfigError {
    /// Config file path was not readable (missing, permissions, EIO).
    #[error("cannot read config file at {path}: {source}")]
    ReadFile {
        /// File path that failed to load.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },

    /// File loaded but TOML deserialisation failed.
    #[error("malformed TOML at {path}: {source}")]
    ParseToml {
        /// File path that failed to parse.
        path: PathBuf,
        /// Underlying serde error.
        #[source]
        source: toml::de::Error,
    },

    /// A deployment supplied only part of the cert-is-identity environment
    /// contract, or supplied it without a configured NATS client.
    #[error(
        "NATS_TLS_CA, NATS_TLS_CERT, and NATS_TLS_KEY must be supplied together with a [nats] section"
    )]
    IncompleteNatsTlsEnvironment,
}
