//! Inactive bootstrap boundary for the Marine analysis worker.
//!
//! This package deliberately has no consumer, provider client, child
//! process, storage client, or deploy artifact. It anchors the validated
//! configuration and cross-language event contract while the worker's
//! production deployment and capacity gates remain closed.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
    )
)]

use nats_client::{ScopedInboxPrefix, ScopedInboxPrefixError};
use thiserror::Error;

/// Environment flag that remains locked to `false` until the worker's
/// production gates are implemented and reviewed.
pub const ENABLED_ENV: &str = "MARINE_ANALYSIS_WORKER_ENABLED";

/// Environment key for the process concurrency ceiling.
pub const MAX_CONCURRENCY_ENV: &str = "MARINE_ANALYSIS_WORKER_MAX_CONCURRENCY";

/// Environment key for the worker-control RPC reply inbox prefix.
pub const CONTROL_INBOX_PREFIX_ENV: &str = "MARINE_ANALYSIS_WORKER_CONTROL_INBOX_PREFIX";

/// Certificate-ACL-scoped reply namespace shared by all seven worker
/// control RPCs on their dedicated Core NATS connection.
pub const CONTROL_INBOX_PREFIX: &str = event_contracts_rs::MARINE_WORKER_SCOPED_INBOX_PREFIX;

/// Fixed concurrency ceiling for the first production worker design.
pub const MAX_CONCURRENCY: usize = 1;

/// Configuration failures that stop bootstrap before any transport can
/// be created.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    /// An environment value was not valid Unicode.
    #[error("environment variable {name} is not valid Unicode")]
    NonUnicode {
        /// Environment variable name.
        name: &'static str,
    },

    /// The activation value was neither `true` nor `false`.
    #[error("{ENABLED_ENV} must be `false`; received an invalid boolean")]
    InvalidEnabled,

    /// Activation cannot occur from this inactive package.
    #[error("{ENABLED_ENV}=true is rejected because the worker has no production consumer")]
    ActivationLocked,

    /// Concurrency was malformed or did not equal the capacity-gated
    /// ceiling.
    #[error("{MAX_CONCURRENCY_ENV} must equal 1")]
    InvalidMaxConcurrency,

    /// The inbox prefix was not one uppercase purpose-specific NATS token.
    #[error("{CONTROL_INBOX_PREFIX_ENV} is invalid")]
    InvalidInboxPrefix(#[source] ScopedInboxPrefixError),

    /// A valid but unscoped prefix would not match the certificate ACL.
    #[error("{CONTROL_INBOX_PREFIX_ENV} must equal {CONTROL_INBOX_PREFIX}")]
    UnexpectedInboxPrefix,
}

impl ConfigError {
    /// Stable, non-secret operator code suitable for structured logs.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NonUnicode { .. } => "CONFIG_NON_UNICODE",
            Self::InvalidEnabled => "CONFIG_ENABLED_INVALID",
            Self::ActivationLocked => "CONFIG_ACTIVATION_LOCKED",
            Self::InvalidMaxConcurrency => "CONFIG_CONCURRENCY_INVALID",
            Self::InvalidInboxPrefix(_) => "CONFIG_CONTROL_INBOX_INVALID",
            Self::UnexpectedInboxPrefix => "CONFIG_CONTROL_INBOX_UNSCOPED",
        }
    }
}

/// Validated configuration for the inactive worker transport spine.
///
/// Fields are private so downstream code cannot construct an active or
/// over-capacity state directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerConfig {
    control_inbox_prefix: ScopedInboxPrefix,
}

impl WorkerConfig {
    /// Read and validate the worker's environment contract.
    ///
    /// # Errors
    /// Returns [`ConfigError`] for non-Unicode values, activation
    /// attempts, concurrency drift, or reply namespace drift.
    pub fn from_env() -> Result<Self, ConfigError> {
        let enabled = read_env(ENABLED_ENV)?;
        let max_concurrency = read_env(MAX_CONCURRENCY_ENV)?;
        let inbox_prefix = read_env(CONTROL_INBOX_PREFIX_ENV)?;
        Self::from_values(
            enabled.as_deref(),
            max_concurrency.as_deref(),
            inbox_prefix.as_deref(),
        )
    }

    /// Borrow the validated worker-control reply namespace.
    #[must_use]
    pub fn control_inbox_prefix(&self) -> &ScopedInboxPrefix {
        &self.control_inbox_prefix
    }

    /// Durable event type this worker will consume once its activation
    /// gates are complete.
    #[must_use]
    pub const fn requested_event_type(&self) -> &'static str {
        event_contracts_rs::MARINE_ANALYSIS_REQUESTED_EVENT_TYPE
    }

    /// This package cannot represent an active worker.
    #[must_use]
    pub const fn is_active(&self) -> bool {
        false
    }

    fn from_values(
        enabled: Option<&str>,
        max_concurrency: Option<&str>,
        inbox_prefix: Option<&str>,
    ) -> Result<Self, ConfigError> {
        match enabled.unwrap_or("false") {
            "false" => {}
            "true" => return Err(ConfigError::ActivationLocked),
            _ => return Err(ConfigError::InvalidEnabled),
        }

        let parsed_concurrency = max_concurrency
            .unwrap_or("1")
            .parse::<usize>()
            .map_err(|_| ConfigError::InvalidMaxConcurrency)?;
        if parsed_concurrency != MAX_CONCURRENCY {
            return Err(ConfigError::InvalidMaxConcurrency);
        }

        let prefix = ScopedInboxPrefix::try_new(inbox_prefix.unwrap_or(CONTROL_INBOX_PREFIX))
            .map_err(ConfigError::InvalidInboxPrefix)?;
        if prefix.as_str() != CONTROL_INBOX_PREFIX {
            return Err(ConfigError::UnexpectedInboxPrefix);
        }

        Ok(Self {
            control_inbox_prefix: prefix,
        })
    }
}

fn read_env(name: &'static str) -> Result<Option<String>, ConfigError> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(ConfigError::NonUnicode { name }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CONTROL_INBOX_PREFIX, ConfigError, MAX_CONCURRENCY, WorkerConfig};

    #[test]
    fn defaults_are_inactive_scoped_and_single_concurrency() {
        let config = WorkerConfig::from_values(None, None, None).unwrap();

        assert!(!config.is_active());
        assert_eq!(config.control_inbox_prefix().as_str(), CONTROL_INBOX_PREFIX);
        assert_eq!(MAX_CONCURRENCY, 1);
        assert_eq!(config.requested_event_type(), "MarineAnalysisRequested");
    }

    #[test]
    fn activation_is_fail_closed() {
        assert_eq!(
            WorkerConfig::from_values(Some("true"), None, None),
            Err(ConfigError::ActivationLocked)
        );
        assert_eq!(
            WorkerConfig::from_values(Some("TRUE"), None, None),
            Err(ConfigError::InvalidEnabled)
        );
    }

    #[test]
    fn concurrency_cannot_exceed_capacity_gate() {
        assert_eq!(
            WorkerConfig::from_values(None, Some("2"), None),
            Err(ConfigError::InvalidMaxConcurrency)
        );
        assert_eq!(
            WorkerConfig::from_values(None, Some("not-a-number"), None),
            Err(ConfigError::InvalidMaxConcurrency)
        );
    }

    #[test]
    fn control_inbox_must_match_scoped_acl_namespace() {
        for invalid in [
            "_INBOX",
            "_INBOX.*",
            "_INBOXMARINE.REPLY",
            "_INBOXMarine",
            "_INBOXMARINE-ANALYSIS",
        ] {
            assert!(matches!(
                WorkerConfig::from_values(None, None, Some(invalid)),
                Err(ConfigError::InvalidInboxPrefix(_))
            ));
        }
        assert_eq!(
            WorkerConfig::from_values(None, None, Some("_INBOXBILLINGCFG")),
            Err(ConfigError::UnexpectedInboxPrefix)
        );
    }

    #[test]
    fn copernicus_toolbox_lock_pins_the_reviewed_linux_artifact() {
        let actual: serde_json::Value =
            serde_json::from_str(include_str!("../copernicus-toolbox.lock.json")).unwrap();

        assert_eq!(
            actual,
            json!({
                "schemaVersion": 1,
                "tool": "copernicusmarine",
                "version": "2.4.1",
                "artifact": {
                    "name": "copernicusmarine_linux-glibc-2.35.cli",
                    "sizeBytes": 154_166_192_u64,
                    "sha256": "e65f72db9fc7075f91fc9bd90368246248aa39a599a8a79eb4d06a5705b15864"
                }
            })
        );
    }
}
