//! The agent's trust root: the fleet-root signed trust-anchors bundle
//! (ADR-048 DEC-3.3, DEC-3.4, DEC-3.7, DEC-22). Suderra OS profile only.
//!
//! From P0 the bundle is the single source of every key and CA the agent
//! trusts: the platform `command` key that RBAC actors map to, the
//! `rbac-manifest` and `config-integrity` keys, the `edge-release` and
//! `edge-provisioning` keys (each equal to an OS pin), and the `mqtt-ca`
//! root set of the broker (DEC-10.6). The root installer verifies it and
//! writes it into the read-only site directory; the agent verifies it again
//! here, against the fleet-root keys pinned in the verity rootfs
//! (`/etc/suderra/keys/fleet-root/<epoch>.pub`), with DSSE PAE and
//! `verify_strict`, the contract's strict JSON and schema rules, the
//! anchor-consistency checks and the device's tenant scope
//! (statements.json, `verified_by.agent`). Nothing in the agent's
//! configuration can add a key: the generic profile's config-file keys are
//! not compiled in this profile (DEC-3.3).
//!
//! The bundle's `bundle_seq` ratchet is root's (statements.json
//! `verified_by.agent.omits` lists `sequence-replay` and
//! `key-epoch-below-ratchet` for this statement): root never installs a
//! bundle below the last one it accepted, and the agent reads only the
//! installed one.
//!
//! The device identity the statements are bound to is the one root records
//! at first provisioning and mirrors to `/run/suderra/identity.json`
//! (DEC-3.6); the agent never derives it from its own configuration or from
//! the activation response.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::edge_contract::dsse::Envelope;
use crate::edge_contract::encoding::is_uuid;
use crate::edge_contract::json::check_strict_object;
use crate::edge_contract::keys::{KeyEntry, KeyStore, parse_pin_epoch, parse_spki_pem};
use crate::edge_contract::registry::{BoardProfile, Purpose, Reason, StatementType};
use crate::edge_contract::statements::{DeviceBinding, TrustAnchors};
use crate::edge_contract::verify::{
    Accepted, AgentDevice, Identity, Scope, Verified, bundle_keys, mqtt_ca_certificates,
    verify_trust_anchors,
};
use crate::paths::AgentPaths;

/// Largest signed statement file the agent reads (the envelope schema caps
/// the base64 payload at 1 MiB).
pub const MAX_STATEMENT_BYTES: u64 = 2 * 1024 * 1024;
/// Largest identity document or key pin the agent reads.
const MAX_SMALL_FILE_BYTES: u64 = 64 * 1024;

/// Why the trust root could not be established. Every variant leaves the
/// agent without trust anchors: no signed command, no RBAC manifest and no
/// broker connection is accepted (fail closed), while local control goes on.
#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    /// A file could not be read.
    #[error("cannot read {path}: {source}")]
    Io {
        /// The file.
        path: PathBuf,
        /// The cause.
        source: std::io::Error,
    },
    /// A file exceeds its size bound.
    #[error("{path} exceeds {max} bytes")]
    TooLarge {
        /// The file.
        path: PathBuf,
        /// The bound.
        max: u64,
    },
    /// The OS identity document is missing a part or malformed.
    #[error("device identity {path} is not usable: {reason}")]
    Identity {
        /// The identity document.
        path: PathBuf,
        /// What is wrong.
        reason: String,
    },
    /// The OS key pins are malformed.
    #[error("OS key pins under {path}: {reason}")]
    Pins {
        /// The pin directory or file.
        path: PathBuf,
        /// What is wrong.
        reason: String,
    },
    /// An `mqtt-ca` anchor certificate is not decodable PEM.
    #[error("mqtt-ca anchor certificate is not decodable: {reason}")]
    MqttCa {
        /// What is wrong.
        reason: String,
    },
    /// A signed statement was rejected.
    #[error("{statement} at {path} rejected: {}", reasons_text(.reasons))]
    Rejected {
        /// The statement file.
        path: PathBuf,
        /// Its statement type.
        statement: StatementType,
        /// Every failing contract reason.
        reasons: BTreeSet<Reason>,
    },
}

/// Contract reason codes, comma-separated.
pub fn reasons_text(reasons: &BTreeSet<Reason>) -> String {
    reasons
        .iter()
        .map(|r| r.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

/// Reads a regular file of at most `max` bytes.
pub fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>, TrustError> {
    let io = |source| TrustError::Io {
        path: path.to_path_buf(),
        source,
    };
    let file = std::fs::File::open(path).map_err(io)?;
    let meta = file.metadata().map_err(io)?;
    if !meta.is_file() {
        return Err(io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        )));
    }
    if meta.len() > max {
        return Err(TrustError::TooLarge {
            path: path.to_path_buf(),
            max,
        });
    }
    let mut bytes = Vec::new();
    file.take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if u64::try_from(bytes.len()).map_or(true, |n| n > max) {
        return Err(TrustError::TooLarge {
            path: path.to_path_buf(),
            max,
        });
    }
    Ok(bytes)
}

/// Current UTC time in the contract timestamp form (statements.json
/// `dsse.time_window`).
pub fn now_timestamp() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

// ------------------------------------------------------------------ identity

/// `/run/suderra/identity.json` as `suderra-identity mirror` writes it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityDocument {
    board_profile: BoardProfile,
    device_binding: DeviceBinding,
    #[serde(default)]
    device: Option<DeviceIdentityRecord>,
}

/// The tenant and device root recorded at first provisioning.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceIdentityRecord {
    tenant_id: String,
    device_id: String,
    device_code: String,
}

/// Parses the OS identity document into the device the agent verifies
/// statements for. A device that is not provisioned has no identity, so no
/// statement can be bound to it.
pub fn parse_identity(path: &Path, bytes: &[u8]) -> Result<AgentDevice, TrustError> {
    let fail = |reason: String| TrustError::Identity {
        path: path.to_path_buf(),
        reason,
    };
    check_strict_object(bytes).map_err(fail)?;
    let doc: IdentityDocument = serde_json::from_slice(bytes).map_err(|e| fail(e.to_string()))?;
    doc.device_binding.validate().map_err(fail)?;
    let board = doc.board_profile.spec();
    if doc.device_binding.method != board.device_binding_method {
        return Err(fail(format!(
            "binding method {} differs from {} of board {}",
            doc.device_binding.method, board.device_binding_method, doc.board_profile
        )));
    }
    let device = doc.device.ok_or_else(|| {
        fail("no tenant and device identity: the device is not provisioned".to_owned())
    })?;
    if !is_uuid(&device.tenant_id) || !is_uuid(&device.device_id) || device.device_code.is_empty()
    {
        return Err(fail("tenant_id, device_id or device_code is malformed".to_owned()));
    }
    Ok(AgentDevice {
        board: doc.board_profile,
        arch: board.arch,
        binding: doc.device_binding,
        identity: Identity {
            tenant_id: device.tenant_id,
            device_id: device.device_id,
        },
    })
}

// ------------------------------------------------------------------ OS pins

/// Loads every key pinned in the OS image for the os-image purposes
/// (`<dir>/<purpose>/<epoch>.pub`). A purpose without a directory has no
/// pin; anything malformed fails closed.
pub fn load_os_pins(dir: &Path) -> Result<KeyStore, TrustError> {
    let mut entries = Vec::new();
    for purpose in Purpose::ALL
        .iter()
        .copied()
        .filter(|p| p.anchored_in_os_image())
    {
        let purpose_dir = dir.join(purpose.as_str());
        let listing = match std::fs::read_dir(&purpose_dir) {
            Ok(listing) => listing,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(TrustError::Io {
                    path: purpose_dir,
                    source,
                });
            }
        };
        for item in listing {
            let item = item.map_err(|source| TrustError::Io {
                path: purpose_dir.clone(),
                source,
            })?;
            let path = item.path();
            let pin_error = |reason: String| TrustError::Pins {
                path: path.clone(),
                reason,
            };
            let name = item.file_name();
            let epoch = name
                .to_str()
                .and_then(parse_pin_epoch)
                .ok_or_else(|| pin_error("not <epoch>.pub".to_owned()))?;
            let text = String::from_utf8(read_bounded(&path, MAX_SMALL_FILE_BYTES)?)
                .map_err(|_| pin_error("not UTF-8".to_owned()))?;
            entries.push(KeyEntry {
                purpose,
                epoch,
                raw: parse_spki_pem(&text).map_err(pin_error)?,
            });
        }
    }
    KeyStore::from_entries(entries).map_err(|reason| TrustError::Pins {
        path: dir.to_path_buf(),
        reason,
    })
}

// ------------------------------------------------------------------ bundle

/// The verified installed bundle with the device and OS keys it verified
/// against.
#[derive(Debug, Clone)]
pub struct InstalledTrust {
    device: AgentDevice,
    os_keys: KeyStore,
    bundle: Verified<TrustAnchors>,
    bundle_keys: KeyStore,
}

impl InstalledTrust {
    /// Loads the identity, the OS pins and the installed bundle from the
    /// profile's paths and verifies the bundle at `now`.
    pub fn load(paths: &AgentPaths, now: &str) -> Result<Self, TrustError> {
        Self::load_from(
            &paths.identity_file(),
            &paths.key_pins_dir(),
            &paths.trust_anchors_file(),
            now,
        )
    }

    /// [`Self::load`] with explicit locations.
    pub fn load_from(
        identity_file: &Path,
        key_pins_dir: &Path,
        bundle_file: &Path,
        now: &str,
    ) -> Result<Self, TrustError> {
        let device = parse_identity(
            identity_file,
            &read_bounded(identity_file, MAX_SMALL_FILE_BYTES)?,
        )?;
        let os_keys = load_os_pins(key_pins_dir)?;
        let bytes = read_bounded(bundle_file, MAX_STATEMENT_BYTES)?;
        Self::verify(device, os_keys, bundle_file, &bytes, now)
    }

    /// Verifies bundle `bytes` for `device` against `os_keys`.
    pub fn verify(
        device: AgentDevice,
        os_keys: KeyStore,
        bundle_file: &Path,
        bytes: &[u8],
        now: &str,
    ) -> Result<Self, TrustError> {
        let rejected = |reasons: BTreeSet<Reason>| TrustError::Rejected {
            path: bundle_file.to_path_buf(),
            statement: StatementType::TrustAnchors,
            reasons,
        };
        let env = Envelope::parse(bytes).map_err(|r| rejected(BTreeSet::from([r])))?;
        let no_gates = BTreeMap::new();
        let scope = Scope {
            os_keys: &os_keys,
            device: &device,
            gates: &no_gates,
            now,
        };
        let bundle = verify_trust_anchors(&env, &scope)
            .accepted()
            .map_err(rejected)?;
        let bundle_keys = bundle_keys(&bundle.statement)
            .ok_or_else(|| rejected(BTreeSet::from([Reason::AnchorInvalid])))?;
        Ok(Self {
            device,
            os_keys,
            bundle,
            bundle_keys,
        })
    }

    /// The device the bundle was verified for.
    pub fn device(&self) -> &AgentDevice {
        &self.device
    }

    /// Keys pinned in the OS image.
    pub fn os_keys(&self) -> &KeyStore {
        &self.os_keys
    }

    /// Bundle-only anchors (`command`, `rbac-manifest`, `config-integrity`).
    pub fn bundle_keys(&self) -> &KeyStore {
        &self.bundle_keys
    }

    /// The bundle's `bundle_seq`.
    pub fn bundle_seq(&self) -> u64 {
        self.bundle.statement.bundle_seq
    }

    /// The bundle's statement digest.
    pub fn digest(&self) -> &str {
        &self.bundle.digest
    }

    /// A verification scope for statements resolved against this trust root.
    pub fn scope<'a>(
        &'a self,
        gates: &'a BTreeMap<StatementType, Accepted>,
        now: &'a str,
    ) -> Scope<'a> {
        Scope {
            os_keys: &self.os_keys,
            device: &self.device,
            gates,
            now,
        }
    }

    /// The DER root certificates of the bundle's `mqtt-ca` anchor: the only
    /// roots the broker connection trusts (DEC-10.6). Empty when the bundle
    /// anchors no broker CA.
    pub fn mqtt_ca_der(&self) -> Result<Vec<Vec<u8>>, TrustError> {
        mqtt_ca_certificates(&self.bundle.statement)
            .into_iter()
            .map(|text| {
                pem::parse(text)
                    .map(pem::Pem::into_contents)
                    .map_err(|e| TrustError::MqttCa {
                        reason: e.to_string(),
                    })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;

    fn contract() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contracts/suderra-edge/v1")
    }

    /// An OS image's pins and identity for the contract fixtures' active
    /// revpi-connect4 device, laid out as on the device.
    fn device_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        let ring: serde_json::Value =
            serde_json::from_slice(&std::fs::read(contract().join("test-keys/keyring.json")).unwrap())
                .unwrap();
        for key in ring["keys"].as_array().unwrap() {
            if key["fixture_anchor"] != "os-image" {
                continue;
            }
            let dir = root.path().join("keys").join(key["purpose"].as_str().unwrap());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::copy(
                contract().join(key["path"].as_str().unwrap()),
                dir.join(format!("{}.pub", key["epoch"])),
            )
            .unwrap();
        }
        let index: serde_json::Value = serde_json::from_slice(
            &std::fs::read(contract().join("fixtures/index.json")).unwrap(),
        )
        .unwrap();
        let ctx = &index["device_contexts"]["revpi-active"];
        let identity = serde_json::json!({
            "board_profile": ctx["board_profile"],
            "device_binding": ctx["device_binding"],
            "device": {
                "tenant_id": ctx["tenant_id"],
                "device_id": ctx["device_id"],
                "device_code": "EDGE-REVPI-0001",
            },
        });
        std::fs::write(root.path().join("identity.json"), identity.to_string()).unwrap();
        root
    }

    fn bundle(root: &Path, fixture: &str) -> PathBuf {
        let path = root.join("trust-anchors.dsse");
        std::fs::copy(contract().join("fixtures").join(fixture), &path).unwrap();
        path
    }

    const NOW: &str = "2026-10-20T12:00:00Z";

    #[test]
    fn installed_bundle_verifies_against_the_fleet_root_pin() {
        let root = device_root();
        let file = bundle(root.path(), "trust-anchors/valid/bundle-seq-1.dsse.json");
        let trust = InstalledTrust::load_from(
            &root.path().join("identity.json"),
            &root.path().join("keys"),
            &file,
            NOW,
        )
        .unwrap();
        assert_eq!(trust.bundle_seq(), 1);
        assert_eq!(trust.bundle_keys().of_purpose(Purpose::Command).count(), 1);
        assert_eq!(trust.bundle_keys().of_purpose(Purpose::RbacManifest).count(), 1);
        let cas = trust.mqtt_ca_der().unwrap();
        assert!(!cas.is_empty());
        assert!(x509_parser::parse_x509_certificate(&cas[0]).is_ok());
    }

    #[test]
    fn a_rejected_bundle_names_its_contract_reason() {
        let root = device_root();
        for (fixture, reason) in [
            ("trust-anchors/invalid/wrong-purpose-key.dsse.json", Reason::KeyPurposeMismatch),
            ("trust-anchors/invalid/bad-signature.dsse.json", Reason::SignatureInvalid),
            ("trust-anchors/invalid/tenant-scope-excludes-device.dsse.json", Reason::TenantScopeMismatch),
            ("trust-anchors/invalid/anchor-not-os-pinned.dsse.json", Reason::AnchorNotOsPinned),
            ("trust-anchors/invalid/two-signatures.dsse.json", Reason::EnvelopeInvalid),
        ] {
            let file = bundle(root.path(), fixture);
            let err = InstalledTrust::load_from(
                &root.path().join("identity.json"),
                &root.path().join("keys"),
                &file,
                NOW,
            )
            .unwrap_err();
            match err {
                TrustError::Rejected { reasons, .. } => {
                    assert_eq!(reasons, BTreeSet::from([reason]), "{fixture}")
                }
                other => panic!("{fixture}: {other}"),
            }
        }
    }

    #[test]
    fn an_unprovisioned_or_mismatched_identity_fails_closed() {
        let root = device_root();
        let path = root.path().join("identity.json");
        let mut doc: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        doc.as_object_mut().unwrap().remove("device");
        assert!(matches!(
            parse_identity(&path, doc.to_string().as_bytes()),
            Err(TrustError::Identity { .. })
        ));
        let mut doc: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        doc["board_profile"] = serde_json::json!("rpi4-cm4");
        assert!(matches!(
            parse_identity(&path, doc.to_string().as_bytes()),
            Err(TrustError::Identity { .. })
        ));
        let dup = br#"{"board_profile":"revpi-connect4","board_profile":"rpi4-cm4"}"#;
        assert!(parse_identity(&path, dup).is_err());
    }

    #[test]
    fn malformed_pins_fail_closed() {
        let root = device_root();
        let dir = root.path().join("keys/fleet-root");
        std::fs::write(dir.join("01.pub"), "x").unwrap();
        assert!(matches!(
            load_os_pins(&root.path().join("keys")),
            Err(TrustError::Pins { .. })
        ));
        std::fs::remove_file(dir.join("01.pub")).unwrap();
        std::fs::write(dir.join("2.pub"), "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")
            .unwrap();
        assert!(load_os_pins(&root.path().join("keys")).is_err());
    }

    #[test]
    fn oversized_statements_are_not_read() {
        let root = device_root();
        let path = root.path().join("big.dsse");
        std::fs::write(&path, vec![b' '; 2048]).unwrap();
        assert!(matches!(
            read_bounded(&path, 1024),
            Err(TrustError::TooLarge { .. })
        ));
    }
}
