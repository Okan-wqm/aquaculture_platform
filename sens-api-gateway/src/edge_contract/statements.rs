//! Typed statement payloads the agent verifies
//! (contracts/suderra-edge/v1/schemas/*.schema.json).
//!
//! Every struct denies unknown members and every constraint of the schema is
//! checked in `validate`, so a payload is accepted here exactly when the JSON
//! Schema accepts it; anything else is `schema-invalid`.

use std::collections::{BTreeMap, BTreeSet};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::encoding::{
    is_ed25519_public_key, is_kernel_symbol, is_os_version, is_pem_certificate, is_semver,
    is_sha256_hex, is_tag_id, is_timestamp, is_uuid,
};
use super::json::{MAX_SAFE_INTEGER, check_strict_object};
use super::registry::{
    AgentProfile, Arch, BindingMethod, BoardProfile, CargoFeature, Purpose, Reason, SitePath,
    StatementType,
};

type Check = Result<(), String>;

fn ensure(ok: bool, what: &str) -> Check {
    if ok { Ok(()) } else { Err(what.to_owned()) }
}

fn unique<T: Ord>(items: &[T]) -> bool {
    items.iter().collect::<BTreeSet<_>>().len() == items.len()
}

fn sequence(value: u64, what: &str) -> Check {
    ensure((1..=MAX_SAFE_INTEGER).contains(&value), what)
}

fn epoch(value: u64, what: &str) -> Check {
    ensure((1..=65_535).contains(&value), what)
}

fn uuid(value: &str, what: &str) -> Check {
    ensure(is_uuid(value), what)
}

fn window(not_before: &str, expires_at: &str) -> Check {
    ensure(
        is_timestamp(not_before),
        "not_before is not a contract timestamp",
    )?;
    ensure(
        is_timestamp(expires_at),
        "expires_at is not a contract timestamp",
    )
}

/// common.schema.json `digest`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Digest {
    /// Lowercase hex SHA-256.
    pub sha256: String,
}

impl Digest {
    fn validate(&self) -> Check {
        ensure(
            is_sha256_hex(&self.sha256),
            "digest is not lowercase hex SHA-256",
        )
    }
}

/// common.schema.json `device_binding`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceBinding {
    /// How the binding was derived.
    pub method: BindingMethod,
    /// Digest of the hardware identity.
    pub digest: Digest,
}

impl DeviceBinding {
    /// Schema constraints serde does not enforce.
    pub fn validate(&self) -> Check {
        self.digest.validate()
    }
}

/// Behaviour shared by every signed statement payload.
pub trait Statement: DeserializeOwned {
    /// The statement type this payload belongs to.
    const TYPE: StatementType;
    /// Every schema constraint serde does not already enforce.
    fn validate(&self) -> Check;
    /// `(not_before, expires_at)` when the statement has a window.
    fn window(&self) -> Option<(&str, &str)> {
        None
    }
    /// device_binding of a device-bound statement.
    fn binding(&self) -> Option<&DeviceBinding> {
        None
    }
    /// device_id of a device-bound statement.
    fn device_id(&self) -> Option<&str> {
        None
    }
    /// tenant_id of a tenant-bound statement (the bundle uses tenant_scope).
    fn tenant_id(&self) -> Option<&str> {
        None
    }
    /// Value of the sequence member, if the type has one.
    fn sequence(&self) -> Option<u64> {
        None
    }
}

/// Parses verified payload bytes as `T` (strict JSON, then schema).
pub fn parse_payload<T: Statement>(bytes: &[u8]) -> Result<T, Reason> {
    check_strict_object(bytes).map_err(|_| Reason::PayloadJsonInvalid)?;
    let value: T = serde_json::from_slice(bytes).map_err(|_| Reason::SchemaInvalid)?;
    value.validate().map_err(|_| Reason::SchemaInvalid)?;
    Ok(value)
}

fn type_member(value: &str, expected: StatementType) -> Check {
    ensure(
        value == expected.as_str(),
        "_type differs from the statement type",
    )
}

// ------------------------------------------------------------- edge-release

/// suderra.edge-release.v1.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EdgeRelease {
    #[serde(rename = "_type")]
    type_: String,
    name: String,
    /// Path-safe semantic version.
    pub version: String,
    /// Monotonic rollback ordinal.
    pub security_version: u64,
    /// Board profile.
    pub board_profile: BoardProfile,
    /// Architecture.
    pub arch: Arch,
    /// Agent profile.
    pub agent_profile: AgentProfile,
    /// Exact cargo feature set.
    pub cargo_features: Vec<CargoFeature>,
    /// The release artifact.
    pub artifact: ReleaseArtifact,
    /// Oldest OS VERSION_ID it runs on.
    pub min_os_version: String,
    /// Agent ABI.
    pub agent_abi: u64,
    /// Kernel symbols it needs.
    pub required_kernel_config: Vec<String>,
    provenance: Provenance,
}

/// edge-release `artifact`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseArtifact {
    /// Artifact file name.
    pub name: String,
    format: String,
    /// Exact artifact size.
    pub size_bytes: u64,
    /// Artifact digest.
    pub digest: Digest,
    binary_name: String,
    /// Digest of the single suderra-agent member.
    pub binary_digest: Digest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Provenance {
    predicate_type: String,
    digest: Digest,
}

/// `^suderra-agent-os-[0-9A-Za-z.-]+-[a-z0-9_-]+-(aarch64|x86_64)\.tar\.gz$`.
fn is_artifact_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("suderra-agent-os-")
        .and_then(|n| n.strip_suffix(".tar.gz"))
    else {
        return false;
    };
    let Some((head, arch)) = stem.rsplit_once('-') else {
        return false;
    };
    let arch_ok = arch == "aarch64" || arch == "x86_64";
    // The version and board parts share '-', so split anywhere that fits.
    let fits = head.char_indices().any(|(i, c)| {
        let (Some(version), Some(board)) = (head.get(..i), head.get(i + 1..)) else {
            return false;
        };
        c == '-'
            && !version.is_empty()
            && version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && !board.is_empty()
            && board
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    });
    arch_ok && fits
}

impl Statement for EdgeRelease {
    const TYPE: StatementType = StatementType::EdgeRelease;

    fn validate(&self) -> Check {
        type_member(&self.type_, Self::TYPE)?;
        ensure(self.name == "suderra-agent", "name must be suderra-agent")?;
        ensure(
            is_semver(&self.version),
            "version is not a path-safe semver",
        )?;
        ensure(
            self.security_version <= u64::from(u32::MAX),
            "security_version out of range",
        )?;
        ensure(
            !self.cargo_features.is_empty() && unique(&self.cargo_features),
            "cargo_features must be a non-empty set",
        )?;
        let a = &self.artifact;
        ensure(
            is_artifact_name(&a.name),
            "artifact.name does not match its pattern",
        )?;
        ensure(
            a.format == super::registry::naming::FORMAT,
            "artifact.format must be tar.gz",
        )?;
        ensure(
            (1..=268_435_456).contains(&a.size_bytes),
            "artifact.size_bytes out of range",
        )?;
        a.digest.validate()?;
        ensure(
            a.binary_name == super::registry::naming::BINARY_NAME,
            "artifact.binary_name must be suderra-agent",
        )?;
        a.binary_digest.validate()?;
        ensure(
            is_os_version(&self.min_os_version),
            "min_os_version is not an OS version",
        )?;
        ensure(
            (1..=65_535).contains(&self.agent_abi),
            "agent_abi out of range",
        )?;
        ensure(
            unique(&self.required_kernel_config)
                && self
                    .required_kernel_config
                    .iter()
                    .all(|s| is_kernel_symbol(s)),
            "required_kernel_config must be unique CONFIG_ symbols",
        )?;
        ensure(
            self.provenance.predicate_type == "https://slsa.dev/provenance/v1",
            "provenance.predicate_type",
        )?;
        self.provenance.digest.validate()
    }
}

// ---------------------------------------------------------- activation receipt

/// suderra.edge-activation-receipt.v1.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationReceipt {
    #[serde(rename = "_type")]
    type_: String,
    /// Tenant.
    pub tenant_id: String,
    /// Device.
    pub device_id: String,
    /// Hardware binding.
    pub device_binding: DeviceBinding,
    /// Statement digest of the installed provisioning manifest.
    pub manifest_digest: Digest,
    /// Cloud activation id.
    pub activation_id: String,
    /// When the cloud committed the activation.
    pub activated_at: String,
    /// Window start.
    pub not_before: String,
    /// Window end.
    pub expires_at: String,
}

impl Statement for ActivationReceipt {
    const TYPE: StatementType = StatementType::EdgeActivationReceipt;

    fn validate(&self) -> Check {
        type_member(&self.type_, Self::TYPE)?;
        uuid(&self.tenant_id, "tenant_id is not a UUID")?;
        uuid(&self.device_id, "device_id is not a UUID")?;
        self.device_binding.validate()?;
        self.manifest_digest.validate()?;
        uuid(&self.activation_id, "activation_id is not a UUID")?;
        ensure(is_timestamp(&self.activated_at), "activated_at")?;
        window(&self.not_before, &self.expires_at)
    }

    fn window(&self) -> Option<(&str, &str)> {
        Some((&self.not_before, &self.expires_at))
    }
    fn binding(&self) -> Option<&DeviceBinding> {
        Some(&self.device_binding)
    }
    fn device_id(&self) -> Option<&str> {
        Some(&self.device_id)
    }
    fn tenant_id(&self) -> Option<&str> {
        Some(&self.tenant_id)
    }
}

// --------------------------------------------------------------- trust anchors

/// An Ed25519 anchor of the bundle.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ed25519Anchor {
    /// Purpose the key serves.
    pub purpose: Purpose,
    algorithm: String,
    /// Declared keyid.
    pub keyid: String,
    /// Key epoch.
    pub epoch: u64,
    /// Standard base64 of the raw key.
    pub public_key: String,
}

/// The MQTT CA anchor of the bundle.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct X509Anchor {
    purpose: Purpose,
    algorithm: String,
    /// PEM root certificates.
    pub certificates: Vec<String>,
}

/// One bundle anchor (`oneOf` ed25519 / x509).
#[derive(Debug, Clone)]
pub enum Anchor {
    /// Ed25519 key anchor.
    Ed25519(Ed25519Anchor),
    /// X.509 root set.
    X509(X509Anchor),
}

impl<'de> Deserialize<'de> for Anchor {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = Value::deserialize(d)?;
        match value.get("algorithm").and_then(Value::as_str) {
            Some("ed25519") => serde_json::from_value(value)
                .map(Anchor::Ed25519)
                .map_err(D::Error::custom),
            Some("x509") => serde_json::from_value(value)
                .map(Anchor::X509)
                .map_err(D::Error::custom),
            _ => Err(D::Error::custom("anchor algorithm must be ed25519 or x509")),
        }
    }
}

/// suderra.trust-anchors.v1.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustAnchors {
    #[serde(rename = "_type")]
    type_: String,
    /// Monotonic bundle sequence.
    pub bundle_seq: u64,
    issued_at: String,
    /// Tenants this bundle serves.
    pub tenant_scope: Vec<String>,
    /// Anchors.
    pub anchors: Vec<Anchor>,
}

impl Statement for TrustAnchors {
    const TYPE: StatementType = StatementType::TrustAnchors;

    fn validate(&self) -> Check {
        type_member(&self.type_, Self::TYPE)?;
        sequence(self.bundle_seq, "bundle_seq out of range")?;
        ensure(is_timestamp(&self.issued_at), "issued_at")?;
        ensure(
            !self.tenant_scope.is_empty()
                && unique(&self.tenant_scope)
                && self.tenant_scope.iter().all(|t| is_uuid(t)),
            "tenant_scope must be a non-empty set of UUIDs",
        )?;
        ensure(!self.anchors.is_empty(), "anchors must not be empty")?;
        for anchor in &self.anchors {
            match anchor {
                Anchor::Ed25519(a) => {
                    ensure(a.algorithm == "ed25519", "anchor algorithm")?;
                    ensure(
                        a.purpose.anchored_in_bundle() && a.purpose != Purpose::MqttCa,
                        "ed25519 anchor purpose outside the bundle set",
                    )?;
                    ensure(is_sha256_hex(&a.keyid), "anchor keyid")?;
                    epoch(a.epoch, "anchor epoch out of range")?;
                    ensure(is_ed25519_public_key(&a.public_key), "anchor public_key")?;
                }
                Anchor::X509(a) => {
                    ensure(a.algorithm == "x509", "anchor algorithm")?;
                    ensure(
                        a.purpose == Purpose::MqttCa,
                        "x509 anchor purpose must be mqtt-ca",
                    )?;
                    ensure(
                        !a.certificates.is_empty()
                            && unique(&a.certificates)
                            && a.certificates.iter().all(|c| is_pem_certificate(c)),
                        "certificates must be a non-empty set of PEM certificates",
                    )?;
                }
            }
        }
        Ok(())
    }

    fn sequence(&self) -> Option<u64> {
        Some(self.bundle_seq)
    }
}

// ----------------------------------------------------------------- site config

/// A site file the site config names.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SiteFile {
    /// Digest of the file bytes.
    pub digest: Digest,
    /// Exact size.
    pub size_bytes: u64,
}

/// site-config `rbac_manifest`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RbacRef {
    /// Statement digest of the delivered RBAC manifest.
    pub digest: Digest,
    /// Its policy_version.
    pub policy_version: u64,
}

/// suderra.site-config.v1.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteConfig {
    #[serde(rename = "_type")]
    type_: String,
    /// Tenant.
    pub tenant_id: String,
    /// Device.
    pub device_id: String,
    /// Hardware binding.
    pub device_binding: DeviceBinding,
    /// Monotonic per device.
    pub update_seq: u64,
    /// Window start.
    pub not_before: String,
    /// Window end.
    pub expires_at: String,
    /// Every site file by fixed path.
    pub files: BTreeMap<SitePath, SiteFile>,
    /// The delivered RBAC manifest.
    pub rbac_manifest: RbacRef,
}

impl Statement for SiteConfig {
    const TYPE: StatementType = StatementType::SiteConfig;

    fn validate(&self) -> Check {
        type_member(&self.type_, Self::TYPE)?;
        uuid(&self.tenant_id, "tenant_id is not a UUID")?;
        uuid(&self.device_id, "device_id is not a UUID")?;
        self.device_binding.validate()?;
        sequence(self.update_seq, "update_seq out of range")?;
        window(&self.not_before, &self.expires_at)?;
        ensure(
            self.files.contains_key(&SitePath::ConfigYaml),
            "files must name config.yaml",
        )?;
        for file in self.files.values() {
            file.digest.validate()?;
            ensure(
                file.size_bytes <= 1_048_576,
                "site file size_bytes out of range",
            )?;
        }
        self.rbac_manifest.digest.validate()?;
        sequence(
            self.rbac_manifest.policy_version,
            "policy_version out of range",
        )
    }

    fn window(&self) -> Option<(&str, &str)> {
        Some((&self.not_before, &self.expires_at))
    }
    fn binding(&self) -> Option<&DeviceBinding> {
        Some(&self.device_binding)
    }
    fn device_id(&self) -> Option<&str> {
        Some(&self.device_id)
    }
    fn tenant_id(&self) -> Option<&str> {
        Some(&self.tenant_id)
    }
    fn sequence(&self) -> Option<u64> {
        Some(self.update_seq)
    }
}

// --------------------------------------------------------------- RBAC manifest

/// RBAC actor (contract 1.x: exactly the platform actor, DEC-9.4).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    /// Actor UUID; the command envelope's `actor`.
    pub actor_id: String,
    kind: String,
    /// Declared keyid.
    pub keyid: String,
    /// Standard base64 of the raw command key.
    pub public_key: String,
    /// Role names (contract 1.x: `[platform-authenticated]`).
    pub roles: Vec<String>,
}

/// RBAC role with its permissions in the agent's `Permission` wire form.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Role {
    /// Role name.
    pub name: String,
    /// Permissions (rbac-manifest.schema.json `$defs/permission`).
    pub permissions: Vec<Value>,
    /// Role window start.
    pub not_before: String,
    /// Role window end.
    pub expires_at: String,
}

/// suderra.rbac-manifest.v1.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RbacManifest {
    #[serde(rename = "_type")]
    type_: String,
    /// Tenant.
    pub tenant_id: String,
    /// Monotonic per tenant.
    pub policy_version: u64,
    /// Window start.
    pub not_before: String,
    /// Window end.
    pub expires_at: String,
    /// Actors.
    pub actors: Vec<Actor>,
    /// Roles.
    pub roles: Vec<Role>,
}

/// The one actor kind and role name of contract 1.x (DEC-9.4).
pub const PLATFORM_ACTOR_KIND: &str = "platform";
/// See [`PLATFORM_ACTOR_KIND`].
pub const PLATFORM_ROLE: &str = "platform-authenticated";

/// Unit permissions of `$defs/permission`. The two-person-integrity class
/// (DEC-9.4) is absent: no 1.x manifest can grant it.
pub const PLAIN_PERMISSIONS: [&str; 10] = [
    "ReadTag",
    "ReadAuditLog",
    "FailoverControl",
    "ManagePolicy",
    "ManageIoConfig",
    "ManageCertPinning",
    "ManageLicense",
    "ManageUserTokenManifest",
    "WatchSubscribe",
    "DebugStep",
];

/// Parameterised permissions of `$defs/permission`.
pub const PARAMETERISED_PERMISSIONS: [&str; 7] = [
    "WriteTag",
    "ModbusWrite",
    "GpioWrite",
    "PwmWrite",
    "SpiWrite",
    "AffectActuator",
    "EmergencyActuator",
];

const PLAIN_ACTUATOR_CLASSES: [&str; 8] = [
    "Filtration",
    "Lighting",
    "Feeding",
    "Recirculation",
    "WasteRemoval",
    "Degassing",
    "EmergencyContainment",
    "Inventory",
];

/// The single member of an object, if it has exactly one.
fn single_member(value: &Value) -> Option<(&str, &Value)> {
    let map = value.as_object()?;
    if map.len() != 1 {
        return None;
    }
    map.iter().next().map(|(k, v)| (k.as_str(), v))
}

/// An object with exactly the given members, in the given order.
fn exact_members<'a>(value: &'a Value, names: &[&str]) -> Option<Vec<&'a Value>> {
    let map = value.as_object()?;
    if map.len() != names.len() {
        return None;
    }
    names.iter().map(|n| map.get(*n)).collect()
}

fn uint_at_most(value: &Value, max: u64) -> bool {
    value.as_u64().is_some_and(|v| v <= max)
}

fn actuator_class_ok(value: &Value) -> bool {
    if let Some(text) = value.as_str() {
        return PLAIN_ACTUATOR_CLASSES.contains(&text);
    }
    match single_member(value) {
        Some(("Aeration", v)) => matches!(v.as_str(), Some("Normal" | "LifeSupport")),
        Some(("Chemistry", v)) => {
            matches!(
                v.as_str(),
                Some("Nutrient" | "PhAdjust" | "LifeSupportDose")
            )
        }
        Some(("Thermal", v)) => matches!(v.as_str(), Some("Heating" | "Cooling")),
        _ => false,
    }
}

/// rbac-manifest `$defs/permission`, plus the register-range order JSON
/// Schema cannot state (start must not exceed end).
pub fn permission_ok(value: &Value) -> bool {
    if let Some(text) = value.as_str() {
        return PLAIN_PERMISSIONS.contains(&text);
    }
    let Some((name, body)) = single_member(value) else {
        return false;
    };
    match name {
        "WriteTag" => exact_members(body, &["tag_id"])
            .is_some_and(|m| m.first().and_then(|v| v.as_str()).is_some_and(is_tag_id)),
        "ModbusWrite" => exact_members(body, &["device_id", "register_range"]).is_some_and(|m| {
            let (Some(device), Some(range)) = (m.first(), m.get(1)) else {
                return false;
            };
            uint_at_most(device, 255)
                && exact_members(range, &["start", "end"]).is_some_and(|r| {
                    let (Some(start), Some(end)) = (r.first(), r.get(1)) else {
                        return false;
                    };
                    uint_at_most(start, 65_535)
                        && uint_at_most(end, 65_535)
                        && start.as_u64() <= end.as_u64()
                })
        }),
        "GpioWrite" => exact_members(body, &["pin"])
            .is_some_and(|m| m.first().is_some_and(|v| uint_at_most(v, 255))),
        "PwmWrite" => exact_members(body, &["channel"])
            .is_some_and(|m| m.first().is_some_and(|v| uint_at_most(v, 255))),
        "SpiWrite" => exact_members(body, &["device_id"])
            .is_some_and(|m| m.first().is_some_and(|v| uint_at_most(v, 255))),
        "AffectActuator" | "EmergencyActuator" => exact_members(body, &["class"])
            .is_some_and(|m| m.first().is_some_and(|v| actuator_class_ok(v))),
        _ => false,
    }
}

impl Statement for RbacManifest {
    const TYPE: StatementType = StatementType::RbacManifest;

    fn validate(&self) -> Check {
        type_member(&self.type_, Self::TYPE)?;
        uuid(&self.tenant_id, "tenant_id is not a UUID")?;
        sequence(self.policy_version, "policy_version out of range")?;
        window(&self.not_before, &self.expires_at)?;
        ensure(self.actors.len() == 1, "exactly one actor")?;
        for actor in &self.actors {
            uuid(&actor.actor_id, "actor_id is not a UUID")?;
            ensure(
                actor.kind == PLATFORM_ACTOR_KIND,
                "actor kind must be platform",
            )?;
            ensure(is_sha256_hex(&actor.keyid), "actor keyid")?;
            ensure(is_ed25519_public_key(&actor.public_key), "actor public_key")?;
            ensure(
                actor.roles == [PLATFORM_ROLE],
                "actor roles must be [platform-authenticated]",
            )?;
        }
        ensure(self.roles.len() == 1, "exactly one role")?;
        for role in &self.roles {
            ensure(role.name == PLATFORM_ROLE, "role name")?;
            ensure(
                !role.permissions.is_empty(),
                "permissions must not be empty",
            )?;
            let distinct: BTreeSet<String> =
                role.permissions.iter().map(Value::to_string).collect();
            ensure(
                distinct.len() == role.permissions.len(),
                "permissions must be unique",
            )?;
            ensure(
                role.permissions.iter().all(permission_ok),
                "permission outside the schema",
            )?;
            window(&role.not_before, &role.expires_at)?;
        }
        Ok(())
    }

    fn window(&self) -> Option<(&str, &str)> {
        Some((&self.not_before, &self.expires_at))
    }
    fn tenant_id(&self) -> Option<&str> {
        Some(&self.tenant_id)
    }
    fn sequence(&self) -> Option<u64> {
        Some(self.policy_version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_names_follow_the_schema_pattern() {
        assert!(is_artifact_name(
            "suderra-agent-os-1.6.0-revpi-connect4-aarch64.tar.gz"
        ));
        assert!(is_artifact_name(
            "suderra-agent-os-1.0.0-rc.1-qemu-x86_64-x86_64.tar.gz"
        ));
        assert!(!is_artifact_name(
            "suderra-agent-os-1.6.0-revpi-connect4-armv7.tar.gz"
        ));
        assert!(!is_artifact_name("suderra-agent-1.6.0-x86_64-linux.tar.gz"));
        assert!(!is_artifact_name("suderra-agent-os--x-aarch64.tar.gz"));
    }

    #[test]
    fn permissions_follow_the_schema() {
        for ok in [
            r#""ReadTag""#,
            r#"{"WriteTag":{"tag_id":"pond.1:do"}}"#,
            r#"{"ModbusWrite":{"device_id":3,"register_range":{"start":10,"end":10}}}"#,
            r#"{"AffectActuator":{"class":{"Aeration":"LifeSupport"}}}"#,
            r#"{"EmergencyActuator":{"class":"Feeding"}}"#,
        ] {
            let value: Value = serde_json::from_str(ok).unwrap_or(Value::Null);
            assert!(permission_ok(&value), "{ok}");
        }
        for bad in [
            r#""SafeStateTrigger""#,
            r#""Reboot""#,
            r#"{"ReadTag":null}"#,
            r#"{"ModbusWrite":{"device_id":3,"register_range":{"start":11,"end":10}}}"#,
            r#"{"GpioWrite":{"pin":256}}"#,
            r#"{"WriteTag":{"tag_id":"x","extra":1}}"#,
            r#"{"WriteTag":{"tag_id":"x"},"GpioWrite":{"pin":1}}"#,
        ] {
            let value: Value = serde_json::from_str(bad).unwrap_or(Value::Null);
            assert!(!permission_ok(&value), "{bad}");
        }
    }
}
