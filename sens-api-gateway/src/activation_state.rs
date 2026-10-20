//! The activation result, kept in the agent's state directory (ADR-048
//! DEC-4.6; SENSOR-CRITICAL-200).
//!
//! `config.yaml` is operator/site material: on Suderra OS the root installer
//! writes it from a signed payload into a read-only bind, and the generic
//! unit mounts `/etc/suderra` read-only too. The agent therefore never
//! persists what activation produced by rewriting that file. Activation
//! writes this document instead — `<state>/activation.json`, mode 0600,
//! written under a temporary name, fsynced, renamed and the directory
//! fsynced — and [`crate::config::AgentConfig::load`] overlays it on every
//! load (boot, SIGHUP, CLIs), so no caller can forget it.
//!
//! ## One rule for which file owns a field
//!
//! * **State fields** — what the cloud assigned at activation: the broker
//!   credential, the tenant, and (self-registration only) the device id and
//!   code. They live here and nowhere else; the agent never writes them to
//!   `config.yaml`. A v1.6.0 device activated before this document existed
//!   keeps them in `config.yaml`, which is read as the fallback when no
//!   activation document exists (DEC-4 consequences, HC-1).
//! * **Endpoint fields** — broker host, port and TLS. `config.yaml` is
//!   their source whenever it names a broker (DEC-4.6: the signed config is
//!   the only source of security and endpoint fields). The activation
//!   response's broker is recorded here only when `config.yaml` names
//!   none, and is applied only while that stays true.
//!
//! The spent single-use provisioning and tenant tokens are dropped from the
//! in-memory configuration once an activation document exists.

use std::path::Path;

use anyhow::{Context, Result};
use secrecy::{ExposeSecret, Secret};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::config::AgentConfig;

/// Schema version of the document.
pub const ACTIVATION_STATE_VERSION: u32 = 1;

/// The broker endpoint an activation response named, kept only for a
/// configuration that names no broker of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerEndpoint {
    /// Broker host.
    pub host: String,
    /// Broker port.
    pub port: u16,
    /// The response required TLS (explicitly, or by naming port 8883).
    pub tls_required: bool,
}

/// What activation produced (see the module documentation).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationState {
    /// Always [`ACTIVATION_STATE_VERSION`].
    pub version: u32,
    /// Device id the cloud assigned at self-registration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Device code the cloud assigned at self-registration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_code: Option<String>,
    /// Tenant the device belongs to.
    pub tenant_id: String,
    /// MQTT broker username.
    pub mqtt_username: String,
    /// MQTT broker password. Stored as is in the 0600 document on the
    /// (LUKS-encrypted on Suderra OS) data partition; an encoding such as
    /// base64 would protect nothing.
    #[serde(
        serialize_with = "serialize_secret",
        deserialize_with = "deserialize_secret"
    )]
    pub mqtt_password: Secret<String>,
    /// Broker endpoint of the response, when the configuration names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker: Option<BrokerEndpoint>,
}

fn serialize_secret<S: Serializer>(secret: &Secret<String>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(secret.expose_secret())
}

fn deserialize_secret<'de, D: Deserializer<'de>>(d: D) -> Result<Secret<String>, D::Error> {
    String::deserialize(d).map(Secret::new)
}

/// The fields of one activation response the document is built from.
pub struct ActivationResult<'a> {
    /// Device id, for a self-registration (the cloud assigns it).
    pub assigned_device_id: Option<&'a str>,
    /// Device code, for a self-registration.
    pub assigned_device_code: Option<&'a str>,
    /// Tenant id.
    pub tenant_id: &'a str,
    /// Broker host.
    pub mqtt_broker: &'a str,
    /// Broker port.
    pub mqtt_port: u16,
    /// Explicit TLS indication of the response, if any.
    pub mqtt_tls_enabled: Option<bool>,
    /// Broker username.
    pub mqtt_username: &'a str,
    /// Broker password.
    pub mqtt_password: &'a str,
}

impl ActivationState {
    /// Build the document for `result`, given the configuration activation
    /// ran under (which decides who owns the endpoint fields).
    pub fn from_result(config: &AgentConfig, result: &ActivationResult<'_>) -> Self {
        let broker = config.mqtt.broker.is_none().then(|| BrokerEndpoint {
            host: result.mqtt_broker.to_string(),
            port: result.mqtt_port,
            tls_required: result.mqtt_tls_enabled.unwrap_or(result.mqtt_port == 8883),
        });
        Self {
            version: ACTIVATION_STATE_VERSION,
            device_id: result.assigned_device_id.map(str::to_string),
            device_code: result.assigned_device_code.map(str::to_string),
            tenant_id: result.tenant_id.to_string(),
            mqtt_username: result.mqtt_username.to_string(),
            mqtt_password: Secret::new(result.mqtt_password.to_string()),
            broker,
        }
    }

    /// Read the document at `path`; `None` when there is none yet. A
    /// document that exists but cannot be read or parsed is an error: the
    /// token it was bought with is spent, so silently re-activating would
    /// fail anyway, and loudly is the only way an operator sees it.
    pub fn load(path: &Path) -> Result<Option<Self>> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(e).with_context(|| {
                    format!("Failed to read activation state {}", path.display())
                });
            }
        };
        let state: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("Failed to parse activation state {}", path.display()))?;
        if state.version != ACTIVATION_STATE_VERSION {
            anyhow::bail!(
                "Activation state {} has version {}, this agent reads version {}",
                path.display(),
                state.version,
                ACTIVATION_STATE_VERSION
            );
        }
        Ok(Some(state))
    }

    /// Durably write the document to `path` (mode 0600; temporary name,
    /// fsync, rename, directory fsync).
    pub fn persist(&self, path: &Path) -> Result<()> {
        crate::shared_io::atomic_json_sidecar::write_atomic_json_owner_only(path, self)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .with_context(|| format!("Failed to persist activation state {}", path.display()))
    }

    /// Overlay the document on `config` by the module's ownership rule.
    pub fn apply_to(&self, config: &mut AgentConfig) {
        if let Some(device_id) = &self.device_id {
            config.device_id = device_id.clone();
        }
        if let Some(device_code) = &self.device_code {
            config.device_code = device_code.clone();
        }
        config.tenant_id = Some(self.tenant_id.clone());
        config.mqtt.username = Some(self.mqtt_username.clone());
        config.mqtt.password = Some(self.mqtt_password.clone());
        if config.mqtt.broker.is_none() {
            if let Some(broker) = &self.broker {
                config.mqtt.broker = Some(broker.host.clone());
                config.mqtt.port = broker.port;
                if broker.tls_required {
                    config.mqtt.tls.enabled = true;
                }
            }
        }
        // The single-use tokens activation consumed.
        config.provisioning_token = None;
        config.tenant_token = None;
    }
}

/// The configuration fields [`ActivationState::apply_to`] replaces, as
/// they were before the overlay. A generic-profile `save()` (the HC-1
/// config-topic and Modbus-provisioning paths) writes `config.yaml` back
/// with these values, so it never copies a state field into the file
/// (DEC-4.6). The Suderra OS profile never writes `config.yaml`.
#[cfg(not(feature = "suderra-os"))]
#[derive(Debug, Clone)]
pub struct FieldsBeforeOverlay {
    device_id: String,
    device_code: String,
    tenant_id: Option<String>,
    mqtt_username: Option<String>,
    mqtt_password: Option<Secret<String>>,
    mqtt_broker: Option<String>,
    mqtt_port: u16,
    mqtt_tls_enabled: bool,
    provisioning_token: Option<Secret<String>>,
    tenant_token: Option<Secret<String>>,
}

#[cfg(not(feature = "suderra-os"))]
impl FieldsBeforeOverlay {
    /// Record the overlaid fields of `config`.
    pub fn capture(config: &AgentConfig) -> Self {
        Self {
            device_id: config.device_id.clone(),
            device_code: config.device_code.clone(),
            tenant_id: config.tenant_id.clone(),
            mqtt_username: config.mqtt.username.clone(),
            mqtt_password: config.mqtt.password.clone(),
            mqtt_broker: config.mqtt.broker.clone(),
            mqtt_port: config.mqtt.port,
            mqtt_tls_enabled: config.mqtt.tls.enabled,
            provisioning_token: config.provisioning_token.clone(),
            tenant_token: config.tenant_token.clone(),
        }
    }

    /// Put the recorded values back into `config`.
    pub fn restore_into(&self, config: &mut AgentConfig) {
        config.device_id = self.device_id.clone();
        config.device_code = self.device_code.clone();
        config.tenant_id = self.tenant_id.clone();
        config.mqtt.username = self.mqtt_username.clone();
        config.mqtt.password = self.mqtt_password.clone();
        config.mqtt.broker = self.mqtt_broker.clone();
        config.mqtt.port = self.mqtt_port;
        config.mqtt.tls.enabled = self.mqtt_tls_enabled;
        config.provisioning_token = self.provisioning_token.clone();
        config.tenant_token = self.tenant_token.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: &str = "123e4567-e89b-42d3-a456-426614174000";
    const TENANT: &str = "223e4567-e89b-42d3-a456-426614174000";

    fn config(broker: Option<&str>) -> AgentConfig {
        let broker_line = broker
            .map(|b| format!("  broker: \"{b}\"\n  port: 1883\n"))
            .unwrap_or_default();
        let yaml = format!(
            "device_id: \"{DEVICE}\"\ndevice_code: \"RPI-1\"\napi_url: \"https://api.example.test\"\n\
             provisioning_token: \"single-use\"\nmqtt:\n{broker_line}"
        );
        serde_yaml::from_str(&yaml).expect("config")
    }

    fn result() -> ActivationResult<'static> {
        ActivationResult {
            assigned_device_id: None,
            assigned_device_code: None,
            tenant_id: TENANT,
            mqtt_broker: "broker.cloud.test",
            mqtt_port: 8883,
            mqtt_tls_enabled: None,
            mqtt_username: "dev-user",
            mqtt_password: "dev-pass",
        }
    }

    #[test]
    fn persisted_document_round_trips_and_is_owner_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state").join("activation.json");
        let state = ActivationState::from_result(&config(None), &result());
        state.persist(&path).expect("persist");
        let loaded = ActivationState::load(&path)
            .expect("load")
            .expect("present");
        assert_eq!(loaded.tenant_id, TENANT);
        assert_eq!(loaded.mqtt_password.expose_secret(), "dev-pass");
        assert_eq!(loaded.broker, state.broker);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().expect("parent"))
            .expect("ls")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "activation.json")
            .collect();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");
    }

    #[test]
    fn missing_document_is_none_and_corrupt_document_is_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("activation.json");
        assert!(ActivationState::load(&path).expect("load").is_none());
        std::fs::write(&path, b"{not json").expect("seed");
        assert!(ActivationState::load(&path).is_err());
    }

    /// DEC-4.6: the configuration owns the endpoint whenever it names a
    /// broker — the document then carries no endpoint at all, so the same
    /// field never lives in two places.
    #[test]
    fn a_configured_broker_keeps_the_endpoint_out_of_the_state() {
        let cfg = config(Some("broker.site.test"));
        let state = ActivationState::from_result(&cfg, &result());
        assert!(state.broker.is_none());
        let mut applied = cfg.clone();
        state.apply_to(&mut applied);
        assert_eq!(applied.mqtt.broker.as_deref(), Some("broker.site.test"));
        assert_eq!(applied.mqtt.port, 1883);
        assert!(!applied.mqtt.tls.enabled);
    }

    #[test]
    fn without_a_configured_broker_the_response_endpoint_applies() {
        let cfg = config(None);
        let state = ActivationState::from_result(&cfg, &result());
        let mut applied = cfg.clone();
        state.apply_to(&mut applied);
        assert_eq!(applied.mqtt.broker.as_deref(), Some("broker.cloud.test"));
        assert_eq!(applied.mqtt.port, 8883);
        assert!(applied.mqtt.tls.enabled, "port 8883 implies TLS");
    }

    #[test]
    fn state_fields_and_spent_tokens_are_overlaid() {
        let cfg = config(Some("broker.site.test"));
        let mut res = result();
        res.assigned_device_id = Some("323e4567-e89b-42d3-a456-426614174000");
        res.assigned_device_code = Some("RPI-ASSIGNED");
        let state = ActivationState::from_result(&cfg, &res);
        let mut applied = cfg.clone();
        state.apply_to(&mut applied);
        assert_eq!(applied.device_id, "323e4567-e89b-42d3-a456-426614174000");
        assert_eq!(applied.device_code, "RPI-ASSIGNED");
        assert_eq!(applied.tenant_id.as_deref(), Some(TENANT));
        assert_eq!(applied.mqtt.username.as_deref(), Some("dev-user"));
        assert_eq!(
            applied
                .mqtt
                .password
                .as_ref()
                .map(|p| p.expose_secret().as_str()),
            Some("dev-pass")
        );
        assert!(applied.provisioning_token.is_none());
        assert!(applied.tenant_token.is_none());
    }

    /// DEC-4.6 "the same field never lives in two places": a generic
    /// `save()` after an activation writes config.yaml back without any
    /// state field, while the operator's own fields and edits persist.
    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn generic_save_never_writes_state_fields_into_config_yaml() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.yaml");
        let mut cfg = config(None);
        let state = ActivationState::from_result(&cfg, &result());
        cfg.apply_activation_state(&state);
        cfg.telemetry.interval_seconds = 42;
        cfg.save_to(&path).expect("save");

        let written = std::fs::read_to_string(&path).expect("read back");
        assert!(!written.contains("dev-user"), "{written}");
        assert!(
            !written.contains("ZGV2LXBhc3M"),
            "b64 of the password: {written}"
        );
        assert!(!written.contains(TENANT), "{written}");
        assert!(!written.contains("broker.cloud.test"), "{written}");
        let reread: AgentConfig = serde_yaml::from_str(&written).expect("parse");
        assert_eq!(reread.telemetry.interval_seconds, 42);
        assert_eq!(reread.device_id, DEVICE);
        assert!(reread.mqtt.username.is_none());
    }

    /// Every load (boot, SIGHUP, CLIs) overlays the activation state.
    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn agent_config_load_overlays_the_activation_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = crate::paths::AgentPaths::generic(crate::paths::GenericOverrides {
            config_file: Some(dir.path().join("config.yaml")),
            data_root: Some(dir.path().join("data")),
            ..Default::default()
        });
        let cfg = config(Some("broker.site.test"));
        std::fs::write(
            paths.config_file(),
            serde_yaml::to_string(&cfg).expect("yaml"),
        )
        .expect("seed config");
        let before = AgentConfig::load(&paths).expect("load before activation");
        assert!(before.mqtt.username.is_none());

        ActivationState::from_result(&cfg, &result())
            .persist(&paths.activation_state_file())
            .expect("persist");
        let after = AgentConfig::load(&paths).expect("load after activation");
        assert_eq!(after.mqtt.username.as_deref(), Some("dev-user"));
        assert_eq!(after.tenant_id.as_deref(), Some(TENANT));
        assert!(after.provisioning_token.is_none());
    }

    #[test]
    fn device_first_activation_does_not_claim_the_device_id() {
        let state = ActivationState::from_result(&config(None), &result());
        assert!(state.device_id.is_none());
        assert!(state.device_code.is_none());
    }

    #[test]
    fn unknown_fields_and_versions_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("activation.json");
        std::fs::write(
            &path,
            br#"{"version":1,"tenant_id":"t","mqtt_username":"u","mqtt_password":"p","api_url":"x"}"#,
        )
        .expect("seed");
        assert!(
            ActivationState::load(&path).is_err(),
            "endpoint-ish extra field"
        );
        std::fs::write(
            &path,
            br#"{"version":2,"tenant_id":"t","mqtt_username":"u","mqtt_password":"p"}"#,
        )
        .expect("seed");
        assert!(ActivationState::load(&path).is_err(), "future version");
    }
}
