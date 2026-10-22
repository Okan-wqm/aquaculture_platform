//! The Suderra OS agent's site configuration trust (ADR-048 DEC-4.10,
//! DEC-4.12, DEC-9.9). Suderra OS profile only.
//!
//! WHY: the site directory (`/var/lib/suderra-site`, a read-only bind the
//! root installer fills) holds what decides the device's physical outputs
//! and its trust: `config.yaml` (broker endpoint, fieldbus inventory, I/O),
//! the RBAC manifest and the trust-anchors bundle. Root verifies them when
//! it installs them, but the agent must not act on a file only because it
//! sits in that directory: a partial delivery, a root-installer defect or a
//! file changed after installation would otherwise drive outputs and choose
//! a broker. The generic profile's config integrity is self-referential (the
//! key that verifies `config.yaml` is inside `config.yaml`), so it is not
//! compiled in this profile.
//!
//! WHAT: [`SiteTrust::establish`] is the only way the agent obtains its
//! configuration on Suderra OS (`AgentConfig::from_site` takes a
//! [`SiteTrust`]; there is no unverified load). It
//!
//! 1. establishes the trust root: the root-recorded identity, the OS key
//!    pins and the fleet-root signed trust-anchors bundle
//!    ([`InstalledTrust`]);
//! 2. verifies `site-config.dsse` (`suderra.site-config.v1`) against the
//!    bundle's `config-integrity` anchor with the contract's agent verifier,
//!    which also verifies the delivered RBAC manifest against the bundle's
//!    `rbac-manifest` anchor and compares the digest and size of every
//!    delivered site file (`config.yaml` among them) with the statement —
//!    exactly the files it names, no more;
//! 3. applies the agent's own version gates, kept in the policy cache
//!    (contract mutable-state.json): a higher `update_seq` /
//!    `policy_version` is a new acceptance, the identical statement at the
//!    accepted value is a re-verification whose window is not applied again
//!    (so the installed site keeps working past its window), anything else
//!    is `sequence-replay`;
//! 4. advances both gates durably before anything is acted on, and returns
//!    the `config.yaml` bytes it verified — the agent parses those bytes,
//!    never a second read of the file.
//!
//! Any failure leaves the gates as they were and gives the agent nothing to
//! act on: it stays in standby (no output touched, no broker connection) and
//! retries, so a statement rejected before time sync (`not-yet-valid`)
//! recovers without a restart once the clock is right.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::authz::manifest_runtime::RbacGateRecord;
use crate::edge_contract::dsse::Envelope;
use crate::edge_contract::registry::{Reason, SitePath, StatementType};
use crate::edge_contract::statements::{RbacManifest, SiteConfig};
use crate::edge_contract::verify::{Accepted, SiteFiles, Verified, verify_site_config};
use crate::paths::AgentPaths;
use crate::trust_anchors::{InstalledTrust, MAX_STATEMENT_BYTES, TrustError, read_bounded};

/// Largest site file the agent reads (site-config.schema.json
/// `size_bytes` maximum).
pub const MAX_SITE_FILE_BYTES: u64 = 1_048_576;

/// The agent's site-config version gate (contract mutable-state.json
/// policy-cache contents, DEC-4.10): `update_seq` and statement digest of
/// the site config it accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteConfigGateRecord {
    /// Accepted `update_seq`.
    pub update_seq: u64,
    /// Statement digest (SHA-256 of the DSSE payload) of that site config.
    pub statement_digest: String,
}

impl SiteConfigGateRecord {
    /// Reads the gate; `None` before the first acceptance.
    pub fn read(path: &Path) -> Result<Option<Self>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(format!(
                    "site-config version gate {}: {}",
                    path.display(),
                    e
                ));
            }
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| {
            format!(
                "site-config version gate {} is corrupt: {}",
                path.display(),
                e
            )
        })
    }

    /// Durably writes the gate (0600; temporary name, fsync, rename,
    /// directory fsync).
    pub fn write(&self, path: &Path) -> Result<(), String> {
        crate::shared_io::atomic_json_sidecar::write_atomic_json_owner_only(path, self)
            .map_err(|e| e.to_string())
    }
}

/// Where the inputs of the site trust live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteLocations {
    /// The OS identity document.
    pub identity: PathBuf,
    /// The OS key pins.
    pub key_pins: PathBuf,
    /// The installed trust-anchors bundle.
    pub trust_anchors: PathBuf,
    /// The site directory holding the delivered site files.
    pub site_dir: PathBuf,
    /// The installed site-config statement.
    pub site_config: PathBuf,
    /// The installed RBAC manifest statement.
    pub rbac_manifest: PathBuf,
    /// The agent's site-config version gate.
    pub site_gate: PathBuf,
    /// The agent's RBAC version gate.
    pub rbac_gate: PathBuf,
}

impl SiteLocations {
    /// The profile's locations.
    pub fn of(paths: &AgentPaths) -> Self {
        Self {
            identity: paths.identity_file(),
            key_pins: paths.key_pins_dir(),
            trust_anchors: paths.trust_anchors_file(),
            site_dir: paths.site_dir(),
            site_config: paths.site_config_file(),
            rbac_manifest: paths.rbac_manifest_file(),
            site_gate: paths.site_config_gate_file(),
            rbac_gate: paths.rbac_gate_file(),
        }
    }
}

/// Whether a successful verification advances the version gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateUse {
    /// The agent is about to act on the site: advance (boot, reload).
    Advance,
    /// A diagnostic look (`--preflight`): read the gates, write nothing.
    ReadOnly,
}

/// Why the site cannot be trusted. The agent acts on nothing of it.
#[derive(Debug, thiserror::Error)]
pub enum SiteTrustError {
    /// The trust root, a statement or a site file failed.
    #[error(transparent)]
    Trust(#[from] TrustError),
    /// A version gate could not be read or written.
    #[error("{0}")]
    Gate(String),
}

/// A site the agent verified and may act on.
#[derive(Debug, Clone)]
pub struct SiteTrust {
    trust: Arc<InstalledTrust>,
    site: Verified<SiteConfig>,
    rbac: Verified<RbacManifest>,
    config_yaml: Vec<u8>,
    /// The other site files the site config named, with the bytes whose
    /// digest and size it verified.
    files: SiteFiles,
}

impl SiteTrust {
    /// Establishes the trust root and verifies the delivered site at `now`
    /// (see the module documentation).
    pub fn establish(
        loc: &SiteLocations,
        now: &str,
        gates: GateUse,
    ) -> Result<Self, SiteTrustError> {
        let trust =
            InstalledTrust::load_from(&loc.identity, &loc.key_pins, &loc.trust_anchors, now)?;
        let site_bytes = read_bounded(&loc.site_config, MAX_STATEMENT_BYTES)?;
        let rbac_bytes = read_bounded(&loc.rbac_manifest, MAX_STATEMENT_BYTES)?;
        let mut files = read_site_files(&loc.site_dir)?;
        let site_env = Envelope::parse(&site_bytes)
            .map_err(|r| rejected(&loc.site_config, StatementType::SiteConfig, [r]))?;
        let rbac_env = Envelope::parse(&rbac_bytes)
            .map_err(|r| rejected(&loc.rbac_manifest, StatementType::RbacManifest, [r]))?;

        let mut accepted = BTreeMap::new();
        if let Some(gate) =
            SiteConfigGateRecord::read(&loc.site_gate).map_err(SiteTrustError::Gate)?
        {
            accepted.insert(
                StatementType::SiteConfig,
                Accepted {
                    seq: gate.update_seq,
                    statement_digest: gate.statement_digest,
                },
            );
        }
        if let Some(gate) = RbacGateRecord::read(&loc.rbac_gate).map_err(SiteTrustError::Gate)? {
            accepted.insert(
                StatementType::RbacManifest,
                Accepted {
                    seq: gate.policy_version,
                    statement_digest: gate.statement_digest,
                },
            );
        }

        let scope = trust.scope(&accepted, now);
        let (site_verdict, rbac_verdict) =
            verify_site_config(&site_env, &scope, trust.bundle_keys(), &rbac_env, &files);
        let site = site_verdict
            .accepted()
            .map_err(|reasons| rejected(&loc.site_config, StatementType::SiteConfig, reasons))?;
        // An accepted site config merged every RBAC reason, so its RBAC
        // verdict is accepted too; anything else is refused all the same.
        let rbac = rbac_verdict
            .ok_or_else(|| {
                rejected(
                    &loc.rbac_manifest,
                    StatementType::RbacManifest,
                    [Reason::RbacManifestDigestMismatch],
                )
            })?
            .accepted()
            .map_err(|reasons| {
                rejected(&loc.rbac_manifest, StatementType::RbacManifest, reasons)
            })?;
        let config_yaml = files.remove(&SitePath::ConfigYaml).ok_or_else(|| {
            rejected(
                &loc.site_config,
                StatementType::SiteConfig,
                [Reason::SiteFileDigestMismatch],
            )
        })?;

        if gates == GateUse::Advance {
            if !site.reverified {
                SiteConfigGateRecord {
                    update_seq: site.statement.update_seq,
                    statement_digest: site.digest.clone(),
                }
                .write(&loc.site_gate)
                .map_err(SiteTrustError::Gate)?;
            }
            if !rbac.reverified {
                RbacGateRecord {
                    policy_version: rbac.statement.policy_version,
                    statement_digest: rbac.digest.clone(),
                }
                .write(&loc.rbac_gate)
                .map_err(SiteTrustError::Gate)?;
            }
        }
        Ok(Self {
            trust: Arc::new(trust),
            site,
            rbac,
            config_yaml,
            files,
        })
    }

    /// The verified trust root.
    pub fn trust(&self) -> &Arc<InstalledTrust> {
        &self.trust
    }

    /// The verified RBAC manifest the site config names.
    pub fn rbac(&self) -> &Verified<RbacManifest> {
        &self.rbac
    }

    /// The `config.yaml` bytes whose digest and size the site config names.
    pub fn config_yaml(&self) -> &[u8] {
        &self.config_yaml
    }

    /// The bytes of another site file (`revpi/config.rsc`, `io-config.yaml`,
    /// ...) whose digest and size the site config named and the verifier
    /// checked; `None` when the site delivered no such file. The agent parses
    /// these bytes, never a second read of the file.
    pub fn site_file(&self, path: SitePath) -> Option<&[u8]> {
        self.files.get(&path).map(Vec::as_slice)
    }

    /// The accepted `update_seq`.
    pub fn update_seq(&self) -> u64 {
        self.site.statement.update_seq
    }

    /// The site config's statement digest.
    pub fn digest(&self) -> &str {
        &self.site.digest
    }

    /// The site config is the one the gate already held.
    pub fn reverified(&self) -> bool {
        self.site.reverified
    }
}

fn rejected(
    path: &Path,
    statement: StatementType,
    reasons: impl IntoIterator<Item = Reason>,
) -> TrustError {
    TrustError::Rejected {
        path: path.to_path_buf(),
        statement,
        reasons: reasons.into_iter().collect(),
    }
}

/// Every site file present in `dir`, by fixed path. A file that is absent
/// is not delivered; any other read failure fails closed.
fn read_site_files(dir: &Path) -> Result<SiteFiles, TrustError> {
    let mut files = SiteFiles::new();
    for site_path in SitePath::ALL {
        let file = dir.join(site_path.as_str());
        match read_bounded(&file, MAX_SITE_FILE_BYTES) {
            Ok(bytes) => {
                files.insert(*site_path, bytes);
            }
            Err(TrustError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            }
            Err(e) => return Err(e),
        }
    }
    Ok(files)
}

/// The contract fixtures' active device with a delivered site, for tests
/// of the site trust and its consumers.
#[cfg(test)]
pub(crate) mod test_support {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use super::*;
    use crate::trust_anchors::test_support::{device_root, fixture};

    /// The bundle every fixture site is verified against.
    pub(crate) const BUNDLE: &str = "trust-anchors/valid/bundle-seq-1.dsse.json";
    /// The RBAC manifest every valid fixture site config names.
    pub(crate) const POLICY_1: &str = "rbac-manifest/valid/platform-actor-policy-1.dsse.json";
    /// The fixture site config at update_seq 2 (window 2026-10-20..21).
    pub(crate) const SEQ_2: &str = "site-config/valid/revpi-connect4-seq-2.dsse.json";

    /// A device with the trust root of the contract fixtures and a site
    /// directory delivered as root installs it.
    pub(crate) struct Site {
        pub(crate) root: tempfile::TempDir,
        pub(crate) loc: SiteLocations,
    }

    impl Site {
        pub(crate) fn new(site_config: &str, config_yaml: &str) -> Self {
            let root = device_root();
            let site_dir = root.path().join("site");
            std::fs::create_dir_all(site_dir.join("revpi")).unwrap();
            let loc = SiteLocations {
                identity: root.path().join("identity.json"),
                key_pins: root.path().join("keys"),
                trust_anchors: site_dir.join("trust-anchors.dsse"),
                site_config: site_dir.join("site-config.dsse"),
                rbac_manifest: site_dir.join("rbac-manifest.dsse"),
                site_dir,
                site_gate: root.path().join("policy-cache/site-config.gate.json"),
                rbac_gate: root.path().join("policy-cache/rbac-manifest.gate.json"),
            };
            let site = Self { root, loc };
            site.install(BUNDLE, &site.loc.trust_anchors.clone());
            site.install(POLICY_1, &site.loc.rbac_manifest.clone());
            site.install(site_config, &site.loc.site_config.clone());
            site.install(config_yaml, &site.loc.site_dir.join("config.yaml"));
            site.install(
                "site-files/v1/revpi/config.rsc",
                &site.loc.site_dir.join("revpi/config.rsc"),
            );
            site
        }

        pub(crate) fn install(&self, fixture_rel: &str, to: &Path) {
            std::fs::write(to, fixture(fixture_rel)).unwrap();
        }

        pub(crate) fn establish(&self, now: &str) -> Result<SiteTrust, SiteTrustError> {
            SiteTrust::establish(&self.loc, now, GateUse::Advance)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use std::collections::BTreeSet;

    use super::test_support::{BUNDLE, SEQ_2, Site};
    use super::*;
    use crate::trust_anchors::test_support::{FIXTURE_NOW, fixture};

    const FIRST: &str = "site-config/valid/revpi-connect4-first.dsse.json";

    fn reasons(err: SiteTrustError) -> BTreeSet<Reason> {
        match err {
            SiteTrustError::Trust(TrustError::Rejected { reasons, .. }) => reasons,
            other => panic!("not a contract rejection: {other}"),
        }
    }

    #[test]
    fn a_delivered_site_verifies_and_advances_both_gates() {
        let site = Site::new(SEQ_2, "site-files/v2/config.yaml");
        let trusted = site.establish(FIXTURE_NOW).unwrap();
        assert_eq!(trusted.config_yaml(), fixture("site-files/v2/config.yaml"));
        assert_eq!(trusted.update_seq(), 2);
        assert!(!trusted.reverified());
        assert_eq!(trusted.rbac().statement.policy_version, 1);
        let gate = SiteConfigGateRecord::read(&site.loc.site_gate)
            .unwrap()
            .unwrap();
        assert_eq!(gate.update_seq, 2);
        assert_eq!(gate.statement_digest, trusted.digest());
        let rbac = RbacGateRecord::read(&site.loc.rbac_gate).unwrap().unwrap();
        assert_eq!(rbac.policy_version, 1);
        assert_eq!(rbac.statement_digest, trusted.rbac().digest);
    }

    #[test]
    fn the_accepted_site_reverifies_after_its_window_and_a_lower_seq_is_a_replay() {
        let site = Site::new(SEQ_2, "site-files/v2/config.yaml");
        site.establish(FIXTURE_NOW).unwrap();
        // Every later boot: identical statements, long after the windows.
        let again = site.establish("2099-01-01T00:00:00Z").unwrap();
        assert!(again.reverified());
        assert!(again.rbac().reverified);
        // update_seq 1 after 2 was accepted: a rollback.
        site.install(FIRST, &site.loc.site_config);
        site.install(
            "site-files/v1/config.yaml",
            &site.loc.site_dir.join("config.yaml"),
        );
        let err = site.establish(FIXTURE_NOW).unwrap_err();
        assert!(reasons(err).contains(&Reason::SequenceReplay));
        assert_eq!(
            SiteConfigGateRecord::read(&site.loc.site_gate)
                .unwrap()
                .unwrap()
                .update_seq,
            2,
            "a refused site never moves the gate"
        );
    }

    #[test]
    fn a_changed_or_extra_site_file_is_refused_and_no_gate_moves() {
        let tampered = Site::new(SEQ_2, "site-files/tampered/config.yaml");
        assert_eq!(
            reasons(tampered.establish(FIXTURE_NOW).unwrap_err()),
            BTreeSet::from([Reason::SiteFileDigestMismatch])
        );
        assert!(!tampered.loc.site_gate.exists());
        assert!(!tampered.loc.rbac_gate.exists());

        let extra = Site::new(SEQ_2, "site-files/v2/config.yaml");
        extra.install(
            "site-files/extra/hardware-inventory.yaml",
            &extra.loc.site_dir.join("hardware-inventory.yaml"),
        );
        assert_eq!(
            reasons(extra.establish(FIXTURE_NOW).unwrap_err()),
            BTreeSet::from([Reason::SiteFileDigestMismatch])
        );

        let missing = Site::new(SEQ_2, "site-files/v2/config.yaml");
        std::fs::remove_file(missing.loc.site_dir.join("revpi/config.rsc")).unwrap();
        assert_eq!(
            reasons(missing.establish(FIXTURE_NOW).unwrap_err()),
            BTreeSet::from([Reason::SiteFileDigestMismatch])
        );
    }

    #[test]
    fn the_rbac_manifest_must_be_the_one_the_site_names() {
        let site = Site::new(
            "site-config/invalid/rbac-digest-mismatch.dsse.json",
            "site-files/v2/config.yaml",
        );
        assert!(
            reasons(site.establish(FIXTURE_NOW).unwrap_err())
                .contains(&Reason::RbacManifestDigestMismatch)
        );

        // Another manifest at the policy version the gate accepted is a
        // replay, whatever the site config says.
        let site = Site::new(SEQ_2, "site-files/v2/config.yaml");
        site.establish(FIXTURE_NOW).unwrap();
        site.install(
            "rbac-manifest/invalid/same-policy-version-changed.dsse.json",
            &site.loc.rbac_manifest,
        );
        let refused = reasons(site.establish(FIXTURE_NOW).unwrap_err());
        assert!(refused.contains(&Reason::SequenceReplay), "{refused:?}");
        assert!(
            refused.contains(&Reason::RbacManifestDigestMismatch),
            "{refused:?}"
        );
    }

    #[test]
    fn statements_the_contract_refuses_fail_closed() {
        for (rel, reason) in [
            (
                "site-config/invalid/wrong-tenant.dsse.json",
                Reason::TenantMismatch,
            ),
            (
                "site-config/invalid/wrong-device-id.dsse.json",
                Reason::DeviceIdMismatch,
            ),
            (
                "site-config/invalid/bad-signature.dsse.json",
                Reason::SignatureInvalid,
            ),
            (
                "site-config/invalid/wrong-purpose-key.dsse.json",
                Reason::KeyPurposeMismatch,
            ),
            ("site-config/invalid/expired.dsse.json", Reason::Expired),
            (BUNDLE, Reason::PayloadTypeMismatch),
        ] {
            let site = Site::new(rel, "site-files/v2/config.yaml");
            assert!(
                reasons(site.establish(FIXTURE_NOW).unwrap_err()).contains(&reason),
                "{rel}"
            );
            assert!(!site.loc.site_gate.exists(), "{rel}");
        }
        // No trust root, no site.
        let site = Site::new(SEQ_2, "site-files/v2/config.yaml");
        std::fs::remove_file(&site.loc.trust_anchors).unwrap();
        assert!(matches!(
            site.establish(FIXTURE_NOW),
            Err(SiteTrustError::Trust(TrustError::Io { .. }))
        ));
        drop(site.root);
    }

    /// m10: a statement refused before time sync (`not-yet-valid`) is
    /// accepted by a later attempt in the same process once the clock is
    /// right; the refusal left nothing behind.
    #[test]
    fn a_clock_window_rejection_recovers_without_restart() {
        let site = Site::new(SEQ_2, "site-files/v2/config.yaml");
        let before_sync = "2026-10-19T08:00:00Z";
        assert!(reasons(site.establish(before_sync).unwrap_err()).contains(&Reason::NotYetValid));
        assert!(!site.loc.site_gate.exists());
        assert_eq!(site.establish(FIXTURE_NOW).unwrap().update_seq(), 2);
    }

    #[test]
    fn a_read_only_look_advances_no_gate() {
        let site = Site::new(SEQ_2, "site-files/v2/config.yaml");
        SiteTrust::establish(&site.loc, FIXTURE_NOW, GateUse::ReadOnly).unwrap();
        assert!(!site.loc.site_gate.exists());
        assert!(!site.loc.rbac_gate.exists());
    }

    #[test]
    fn the_profile_locations_are_the_site_bind_and_the_policy_cache() {
        let loc = SiteLocations::of(&AgentPaths::suderra_os());
        assert_eq!(loc.site_dir, Path::new("/var/lib/suderra-site"));
        assert_eq!(
            loc.site_config,
            Path::new("/var/lib/suderra-site/site-config.dsse")
        );
        assert_eq!(
            loc.rbac_manifest,
            Path::new("/var/lib/suderra-site/rbac-manifest.dsse")
        );
        assert_eq!(
            loc.trust_anchors,
            Path::new("/var/lib/suderra-site/trust-anchors.dsse")
        );
        assert!(loc.site_gate.starts_with("/var/lib/suderra/policy-cache"));
        assert!(loc.rbac_gate.starts_with("/var/lib/suderra/policy-cache"));
    }
}
