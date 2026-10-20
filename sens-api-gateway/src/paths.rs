//! The agent's filesystem contract: the one path resolver (ADR-048 DEC-4.5,
//! DEC-19, DEC-24, DEC-28).
//!
//! Every file the agent reads or writes is named here and nowhere else. Boot,
//! config-integrity verification, SIGHUP reload and the CLIs all resolve their
//! paths through [`AgentPaths::current`], so they cannot disagree about where
//! the config, the state or the secrets live (EDGE-CRITICAL-046, EDGE-LOW-103).
//!
//! Two profiles, selected at compile time:
//!
//! * **`suderra-os`** — every path is a compile-time constant of the read-only
//!   root's mutable-state table (`contracts/suderra-edge/v1/mutable-state.json`,
//!   DEC-4.2). The agent writes only below its six data subdirectories and its
//!   log directory, which the OS creates before the unit starts (DEC-4.3,
//!   DEC-4.11); the site directory is a read-only bind the root installer fills
//!   from a signed payload (DEC-4.6, DEC-4.10). No environment variable is
//!   consulted (DEC-19). `tests/invariants/no_etc_write_paths.rs` checks these
//!   constants against the contract.
//! * **generic** (DEC-28, the v1.6.0 HC-1 fleet) — the legacy layout: config
//!   and operator-delivered files under `/etc/suderra`, agent state flat under
//!   the data root. `SUDERRA_CONFIG`, `SUDERRA_DATA_DIR` and
//!   `SUDERRA_DB_KEY_PATH` are honoured through `crate::generic_env`, read
//!   once when the process first asks for its paths.
//!
//! In both profiles nothing the agent itself writes resolves under `/etc`
//! (ADR-048 DEC-4.1): the agent-written copies of the RBAC manifest, the I/O
//! map, the scripts and the device secret live under the data root, and the
//! generic profile only *reads* the legacy `/etc/suderra` copies an operator or
//! an older agent left there.
//!
//! The module depends on `std` (and, in the generic profile, on
//! `crate::generic_env`) alone, because the filesystem-contract invariant
//! compiles it into its own test crate.

#[cfg(feature = "suderra-os")]
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Compile-time paths of the Suderra OS profile, one per entry of the
/// contract's mutable-state table the agent touches.
#[cfg(feature = "suderra-os")]
pub mod suderra_os {
    /// The site's `config.yaml` (DEC-4.5, DEC-4.7), in the read-only bind of
    /// `/data/suderra/site` (root:suderra 0750) that only the root installer
    /// writes, from a signed payload (DEC-4.6, DEC-4.10).
    pub const CONFIG_FILE: &str = "/var/lib/suderra-site/config.yaml";
    /// The RBAC manifest statement the root installer delivered (DEC-4.12).
    pub const RBAC_MANIFEST_FILE: &str = "/var/lib/suderra-site/rbac-manifest.dsse";
    /// The fleet-root signed trust-anchors bundle the root installer
    /// delivered (DEC-3.7, contract delivery.json `installation`).
    pub const TRUST_ANCHORS_FILE: &str = "/var/lib/suderra-site/trust-anchors.dsse";
    /// Keys pinned in the verity rootfs, `<purpose>/<epoch>.pub`
    /// (statements.json `os_key_pin_layout`, DEC-3.4). Read-only.
    pub const KEY_PINS_DIR: &str = "/etc/suderra/keys";
    /// The OS-owned device identity: board, hardware binding and, once
    /// provisioned, tenant and device (DEC-3.6). Root writes it; the agent
    /// only reads it.
    pub const IDENTITY_FILE: &str = "/run/suderra/identity.json";
    /// Agent data root (`/data/suderra/agent`, suderra:suderra 0750). The
    /// agent reads it but writes only the subdirectories below.
    pub const DATA_ROOT: &str = "/var/lib/suderra";
    /// Activation result, broker credential, receipts (0600 files, DEC-4.6).
    pub const STATE_DIR: &str = "/var/lib/suderra/state";
    /// The device secret (0700 directory, 0400 files, DEC-4.8).
    pub const SECRETS_DIR: &str = "/var/lib/suderra/secrets";
    /// The offline queue.
    pub const QUEUE_DIR: &str = "/var/lib/suderra/queue";
    /// Script runtime storage.
    pub const SCRIPTS_DIR: &str = "/var/lib/suderra/scripts";
    /// Version gates of accepted policy statements (DEC-4.10, DEC-9.9).
    pub const POLICY_CACHE_DIR: &str = "/var/lib/suderra/policy-cache";
    /// Update requests for the root worker (DEC-2.3).
    pub const UPDATE_REQUESTS_DIR: &str = "/var/lib/suderra/update-requests";
    /// Application logs and the audit log (DEC-4.9).
    pub const LOG_DIR: &str = "/var/log/suderra";
    /// Health document read by the root health check (DEC-6.3).
    pub const AGENT_HEALTH_DIR: &str = "/run/suderra/agent-health";

    /// Every directory the agent may write below, exactly the agent
    /// `read-write` entries of the contract's mutable-state table and the
    /// unit's `ReadWritePaths=` (unit-directives.json).
    pub const WRITABLE_DIRS: &[&str] = &[
        AGENT_HEALTH_DIR,
        POLICY_CACHE_DIR,
        QUEUE_DIR,
        SCRIPTS_DIR,
        SECRETS_DIR,
        STATE_DIR,
        UPDATE_REQUESTS_DIR,
        LOG_DIR,
    ];
}

/// Legacy paths of the generic profile (DEC-28). They are the defaults the
/// v1.6.0 fleet was installed with; changing one strands that fleet's data.
#[cfg(not(feature = "suderra-os"))]
pub mod generic {
    /// Operator configuration directory (read-only to the agent under the
    /// contract's generic unit: `ReadOnlyPaths=/etc/suderra`).
    pub const ETC_DIR: &str = "/etc/suderra";
    /// Default config file when `SUDERRA_CONFIG` is unset.
    pub const CONFIG_FILE: &str = "/etc/suderra/config.yaml";
    /// Default agent data root when `SUDERRA_DATA_DIR` is unset.
    pub const DATA_ROOT: &str = "/var/lib/suderra";
    /// Log directory (`ReadWritePaths=/var/log/suderra`).
    pub const LOG_DIR: &str = "/var/log/suderra";
    /// Legacy application log file default of `logging.file`.
    pub const LEGACY_APP_LOG_FILE: &str = "/var/log/suderra-agent.log";
}

/// Name of the activation-state document inside the state directory.
const ACTIVATION_STATE_FILENAME: &str = "activation.json";
/// Name of the device secret inside the secrets directory.
const DB_KEY_FILENAME: &str = "db.key";
/// Name of the agent health view (contract mutable-state.json,
/// `/run/suderra/agent-health` contents).
const AGENT_HEALTH_FILENAME: &str = "health.json";
/// The cloud-signed activation receipt the agent hands to root (contract
/// mutable-state.json `/var/lib/suderra/state` contents, DEC-5.8).
#[cfg(feature = "suderra-os")]
const ACTIVATION_RECEIPT_FILENAME: &str = "activation-receipt.dsse";
/// The cloud-signed lifecycle statement the agent hands to root (contract
/// mutable-state.json `/var/lib/suderra/state` contents, DEC-5.14, DEC-12).
#[cfg(feature = "suderra-os")]
const LIFECYCLE_REQUEST_FILENAME: &str = "lifecycle-request.dsse";
/// The agent's RBAC version gate in the policy cache (DEC-9.9).
#[cfg(feature = "suderra-os")]
const RBAC_GATE_FILENAME: &str = "rbac-manifest.gate.json";

/// Resolved paths of one agent process.
///
/// The fields hold the profile's roots; every artifact path is derived from
/// them by the accessors, so the layout is defined once per profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPaths {
    config_file: PathBuf,
    data_root: PathBuf,
    log_dir: PathBuf,
    /// Explicit device-secret file (`SUDERRA_DB_KEY_PATH`, generic only).
    #[cfg(not(feature = "suderra-os"))]
    db_key_override: Option<PathBuf>,
}

/// Generic-profile overrides, as read from the environment once at start.
#[cfg(not(feature = "suderra-os"))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GenericOverrides {
    /// `SUDERRA_CONFIG`.
    pub config_file: Option<PathBuf>,
    /// `SUDERRA_DATA_DIR`.
    pub data_root: Option<PathBuf>,
    /// `SUDERRA_DB_KEY_PATH`.
    pub db_key_file: Option<PathBuf>,
}

#[cfg(not(feature = "suderra-os"))]
impl GenericOverrides {
    /// Read the overrides from the process environment.
    pub fn from_env() -> Self {
        Self {
            config_file: crate::generic_env::config_path(),
            data_root: crate::generic_env::data_dir(),
            db_key_file: crate::generic_env::db_key_path(),
        }
    }
}

/// Why a configured path override is not acceptable in the Suderra OS
/// profile (see [`AgentPaths::check_agent_writable`]).
#[cfg(feature = "suderra-os")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathPolicyError {
    /// The path is relative.
    NotAbsolute(PathBuf),
    /// The path contains `.` or `..` components, so its prefix proves nothing.
    NotNormalized(PathBuf),
    /// The path lies outside every directory the agent may write.
    OutsideWritableDirs(PathBuf),
}

#[cfg(feature = "suderra-os")]
impl std::fmt::Display for PathPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAbsolute(p) => write!(f, "{} is not an absolute path", p.display()),
            Self::NotNormalized(p) => write!(
                f,
                "{} contains `.` or `..` components; write it in normal form",
                p.display()
            ),
            Self::OutsideWritableDirs(p) => write!(
                f,
                "{} is outside every directory the agent may write; the Suderra OS \
                 agent writes only below its data subdirectories and its log \
                 directory (ADR-048 DEC-4.2, DEC-4.11)",
                p.display()
            ),
        }
    }
}

#[cfg(feature = "suderra-os")]
impl std::error::Error for PathPolicyError {}

static CURRENT: LazyLock<AgentPaths> = LazyLock::new(AgentPaths::resolve);

impl AgentPaths {
    /// The paths of this process, resolved on first use and fixed after
    /// that, so every subsystem sees the same answer for the whole run.
    pub fn current() -> &'static AgentPaths {
        &CURRENT
    }

    /// The Suderra OS profile's paths: compile-time constants.
    #[cfg(feature = "suderra-os")]
    fn resolve() -> Self {
        Self::suderra_os()
    }

    /// The generic profile's paths: the legacy defaults with the
    /// environment overrides applied.
    #[cfg(not(feature = "suderra-os"))]
    fn resolve() -> Self {
        Self::generic(GenericOverrides::from_env())
    }

    /// The Suderra OS profile's paths.
    #[cfg(feature = "suderra-os")]
    pub fn suderra_os() -> Self {
        Self {
            config_file: PathBuf::from(suderra_os::CONFIG_FILE),
            data_root: PathBuf::from(suderra_os::DATA_ROOT),
            log_dir: PathBuf::from(suderra_os::LOG_DIR),
        }
    }

    /// The generic profile's paths for the given overrides.
    #[cfg(not(feature = "suderra-os"))]
    pub fn generic(overrides: GenericOverrides) -> Self {
        Self {
            config_file: overrides
                .config_file
                .unwrap_or_else(|| PathBuf::from(generic::CONFIG_FILE)),
            data_root: overrides
                .data_root
                .unwrap_or_else(|| PathBuf::from(generic::DATA_ROOT)),
            log_dir: PathBuf::from(generic::LOG_DIR),
            db_key_override: overrides.db_key_file,
        }
    }

    // ------------------------------------------------------------------
    // Roots
    // ------------------------------------------------------------------

    /// The agent configuration document.
    pub fn config_file(&self) -> &Path {
        &self.config_file
    }

    /// The agent data root.
    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    /// The log directory.
    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    /// Directory of the agent's own state documents.
    pub fn state_dir(&self) -> PathBuf {
        self.data_root.join("state")
    }

    /// Directory of the device secret.
    pub fn secrets_dir(&self) -> PathBuf {
        self.data_root.join("secrets")
    }

    /// Directory that holds the stores of the Suderra OS layout's
    /// subdirectory `sub`, or the flat data root in the generic layout.
    fn store_dir(&self, sub: &str) -> PathBuf {
        if cfg!(feature = "suderra-os") {
            self.data_root.join(sub)
        } else {
            self.data_root.clone()
        }
    }

    // ------------------------------------------------------------------
    // Configuration and its integrity
    // ------------------------------------------------------------------

    /// Detached config-integrity sidecar: the config file name plus `.sig`
    /// (the legacy `/etc/suderra/config.yaml.sig` under the default config).
    pub fn config_integrity_sidecar(&self) -> PathBuf {
        let mut raw = self.config_file.as_os_str().to_os_string();
        raw.push(".sig");
        PathBuf::from(raw)
    }

    /// Directory of the config-integrity version floor.
    pub fn config_integrity_floor_dir(&self) -> PathBuf {
        self.store_dir("policy-cache")
    }

    // ------------------------------------------------------------------
    // Activation and secrets
    // ------------------------------------------------------------------

    /// Activation result: broker credential, tenant and device identity
    /// (DEC-4.6). The agent never writes them into `config.yaml`.
    pub fn activation_state_file(&self) -> PathBuf {
        self.state_dir().join(ACTIVATION_STATE_FILENAME)
    }

    /// The agent health view (ADR-048 DEC-6.3, DEC-6.8): degraded mode and
    /// control-loop liveness. Suderra OS: `health.json` in the contract's
    /// tmpfs `/run/suderra/agent-health`, which the root health check reads.
    /// Generic: under the state directory (the generic unit grants no
    /// runtime directory); it is rewritten only when its content changes.
    #[cfg(feature = "suderra-os")]
    pub fn agent_health_file(&self) -> PathBuf {
        Path::new(suderra_os::AGENT_HEALTH_DIR).join(AGENT_HEALTH_FILENAME)
    }

    /// See the Suderra OS variant.
    #[cfg(not(feature = "suderra-os"))]
    pub fn agent_health_file(&self) -> PathBuf {
        self.state_dir().join(AGENT_HEALTH_FILENAME)
    }

    /// The activation receipt root's `suderra-activation.path` watches
    /// (DEC-5.8). Written by the agent, verbatim as the cloud signed it.
    #[cfg(feature = "suderra-os")]
    pub fn activation_receipt_file(&self) -> PathBuf {
        self.state_dir().join(ACTIVATION_RECEIPT_FILENAME)
    }

    /// The lifecycle request root's `suderra-lifecycle.path` watches
    /// (DEC-5.14). Written by the agent, verbatim as the cloud signed it.
    #[cfg(feature = "suderra-os")]
    pub fn lifecycle_request_file(&self) -> PathBuf {
        self.state_dir().join(LIFECYCLE_REQUEST_FILENAME)
    }

    /// Directory of update requests for the root worker (DEC-2.3).
    #[cfg(feature = "suderra-os")]
    pub fn update_requests_dir(&self) -> PathBuf {
        self.data_root.join("update-requests")
    }

    /// The trust-anchors bundle (DEC-3.7).
    #[cfg(feature = "suderra-os")]
    pub fn trust_anchors_file(&self) -> PathBuf {
        PathBuf::from(suderra_os::TRUST_ANCHORS_FILE)
    }

    /// The OS key pins (DEC-3.4).
    #[cfg(feature = "suderra-os")]
    pub fn key_pins_dir(&self) -> PathBuf {
        PathBuf::from(suderra_os::KEY_PINS_DIR)
    }

    /// The OS-owned device identity (DEC-3.6).
    #[cfg(feature = "suderra-os")]
    pub fn identity_file(&self) -> PathBuf {
        PathBuf::from(suderra_os::IDENTITY_FILE)
    }

    /// Where the agent creates its device secret when none exists.
    pub fn db_key_file(&self) -> PathBuf {
        self.secrets_dir().join(DB_KEY_FILENAME)
    }

    /// The device-secret file the operator pinned with `SUDERRA_DB_KEY_PATH`.
    #[cfg(not(feature = "suderra-os"))]
    pub fn db_key_override(&self) -> Option<&Path> {
        self.db_key_override.as_deref()
    }

    /// The v1.6.0 fleet's device secret, created by older agents under the
    /// config directory. Read when present; never created.
    #[cfg(not(feature = "suderra-os"))]
    pub fn legacy_db_key_file(&self) -> PathBuf {
        Path::new(generic::ETC_DIR).join(DB_KEY_FILENAME)
    }

    // ------------------------------------------------------------------
    // Stores
    // ------------------------------------------------------------------

    /// SQLCipher offline queue.
    pub fn offline_queue_db(&self) -> PathBuf {
        self.store_dir("queue").join("offline_queue.db")
    }

    /// Persisted script definitions.
    pub fn scripts_dir(&self) -> PathBuf {
        self.data_root.join("scripts")
    }

    /// Script definitions an older generic agent kept under the config
    /// directory; imported once into [`Self::scripts_dir`].
    #[cfg(not(feature = "suderra-os"))]
    pub fn legacy_scripts_dir(&self) -> PathBuf {
        Path::new(generic::ETC_DIR).join("scripts")
    }

    /// RETAIN variable persistence of the script runtime.
    pub fn retain_db(&self) -> PathBuf {
        self.store_dir("scripts").join("retain.db")
    }

    /// Deployed IEC 61131-3 program state.
    pub fn program_state_file(&self) -> PathBuf {
        self.store_dir("state").join("program.json")
    }

    /// SQLCipher license cache.
    pub fn license_cache_db(&self) -> PathBuf {
        self.store_dir("state").join("license_cache.sqlite")
    }

    /// SQLCipher persistent tier of the envelope `jti` dedup.
    pub fn jti_dedup_db(&self) -> PathBuf {
        self.store_dir("state").join("jti_dedup.sqlite")
    }

    /// RBAC manifest version floor.
    pub fn rbac_version_db(&self) -> PathBuf {
        self.store_dir("policy-cache").join("rbac_version.sqlite")
    }

    /// The Suderra OS agent's RBAC version gate: `policy_version` and
    /// statement digest of the manifest it accepted (contract
    /// mutable-state.json policy-cache contents, DEC-9.9).
    #[cfg(feature = "suderra-os")]
    pub fn rbac_gate_file(&self) -> PathBuf {
        self.store_dir("policy-cache").join(RBAC_GATE_FILENAME)
    }

    /// OPC UA user-token manifest version floor.
    pub fn user_token_version_db(&self) -> PathBuf {
        self.store_dir("policy-cache")
            .join("user_token_version.sqlite")
    }

    /// Keystore rotation marker.
    pub fn keystore_rotation_marker(&self, filename: &str) -> PathBuf {
        self.store_dir("state").join(filename)
    }

    /// Backup archives.
    pub fn backup_dir(&self) -> PathBuf {
        self.store_dir("state").join("backups")
    }

    /// SCADA process and package documents.
    pub fn scada_dir(&self) -> PathBuf {
        self.store_dir("state").join("scada")
    }

    /// SCADA SQLCipher store.
    pub fn scada_db(&self) -> PathBuf {
        self.scada_dir().join("scada.db")
    }

    /// LoRaWAN session store.
    pub fn lora_sessions_db(&self) -> PathBuf {
        self.store_dir("state").join("lora_sessions.db")
    }

    /// OPC UA server's own key pair and certificate.
    pub fn opcua_own_pki_dir(&self) -> PathBuf {
        if cfg!(feature = "suderra-os") {
            self.secrets_dir().join("opcua-pki").join("own")
        } else {
            self.data_root.join("pki").join("own")
        }
    }

    /// OPC UA server's trusted client certificates.
    pub fn opcua_trusted_certs_dir(&self) -> PathBuf {
        if cfg!(feature = "suderra-os") {
            self.state_dir()
                .join("opcua-pki")
                .join("trusted")
                .join("certs")
        } else {
            self.data_root.join("pki").join("trusted").join("certs")
        }
    }

    /// A/B partition state of the agent-owned updater (not compiled when
    /// the OS manages updates, ADR-048 DEC-2).
    #[cfg(not(feature = "os-managed-updates"))]
    pub fn partition_store_file(&self) -> PathBuf {
        self.store_dir("state").join("partition.json")
    }

    /// Audit log (DEC-4.9).
    pub fn audit_log_file(&self) -> PathBuf {
        self.log_dir.join("audit.log")
    }

    /// Default of the (informational) `logging.file` setting.
    #[cfg(feature = "suderra-os")]
    pub fn app_log_file(&self) -> PathBuf {
        self.log_dir.join("agent.log")
    }

    /// Default of the (informational) `logging.file` setting: the v1.6.0
    /// default, kept so a generic config that never named it is unchanged.
    #[cfg(not(feature = "suderra-os"))]
    pub fn app_log_file(&self) -> PathBuf {
        PathBuf::from(generic::LEGACY_APP_LOG_FILE)
    }

    // ------------------------------------------------------------------
    // Site files (read-only) and generic agent-written copies
    // ------------------------------------------------------------------

    /// The RBAC manifest the agent loads at boot.
    ///
    /// Suderra OS: the statement the root installer delivered into the
    /// read-only site directory (DEC-4.12). Generic: the copy the agent
    /// persisted after an `update_policy`, when there is one, else the
    /// operator-delivered `/etc/suderra/rbac_manifest.json`.
    #[cfg(feature = "suderra-os")]
    pub fn rbac_manifest_file(&self) -> PathBuf {
        PathBuf::from(suderra_os::RBAC_MANIFEST_FILE)
    }

    /// See the Suderra OS variant.
    #[cfg(not(feature = "suderra-os"))]
    pub fn rbac_manifest_file(&self) -> PathBuf {
        let persisted = self.rbac_manifest_persist_file();
        if persisted.exists() {
            persisted
        } else {
            Path::new(generic::ETC_DIR).join("rbac_manifest.json")
        }
    }

    /// Where a generic agent persists a hot-reloaded RBAC manifest. The
    /// Suderra OS agent never persists one: the manifest is site material
    /// the root installer owns (DEC-4.12).
    #[cfg(not(feature = "suderra-os"))]
    pub fn rbac_manifest_persist_file(&self) -> PathBuf {
        self.data_root.join("rbac_manifest.json")
    }

    /// Where a generic agent persists the I/O map of `update_io_config`.
    /// On Suderra OS the I/O map is site material (DEC-4.12).
    #[cfg(not(feature = "suderra-os"))]
    pub fn io_config_file(&self) -> PathBuf {
        self.data_root.join("io_config.yaml")
    }

    /// Keystore passphrase (operator-provisioned, generic only: the Suderra
    /// OS contract provisions no keystore material before the P2 TPM
    /// keystore, DEC-21).
    #[cfg(not(feature = "suderra-os"))]
    pub fn keystore_passphrase_file(&self) -> PathBuf {
        Path::new(generic::ETC_DIR).join("keystore.passphrase")
    }

    /// Keystore Argon2id salt (generic only, see the passphrase).
    #[cfg(not(feature = "suderra-os"))]
    pub fn keystore_salt_file(&self) -> PathBuf {
        Path::new(generic::ETC_DIR).join("keystore.salt")
    }

    /// Keystore acceptance token (generic only, see the passphrase).
    #[cfg(not(feature = "suderra-os"))]
    pub fn keystore_acceptance_file(&self) -> PathBuf {
        Path::new(generic::ETC_DIR).join("keystore.acceptance.json")
    }

    // ------------------------------------------------------------------
    // Policy
    // ------------------------------------------------------------------

    /// Accept `path` as a location the agent writes, or say why not: it
    /// must be absolute, in normal form and strictly inside one of
    /// [`suderra_os::WRITABLE_DIRS`]. Anything else would be an EROFS at run
    /// time on the read-only root, or a write into a tree another writer
    /// owns (DEC-4.3). The generic profile has no such check: its unit
    /// owns the whole data root (HC-1).
    #[cfg(feature = "suderra-os")]
    pub fn check_agent_writable(&self, path: &Path) -> Result<(), PathPolicyError> {
        if !path.is_absolute() {
            return Err(PathPolicyError::NotAbsolute(path.to_path_buf()));
        }
        if path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
        {
            return Err(PathPolicyError::NotNormalized(path.to_path_buf()));
        }
        if suderra_os::WRITABLE_DIRS
            .iter()
            .any(|dir| path.starts_with(dir) && path != Path::new(dir))
        {
            Ok(())
        } else {
            Err(PathPolicyError::OutsideWritableDirs(path.to_path_buf()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "suderra-os")]
    #[test]
    fn suderra_os_paths_are_the_contract_constants() {
        let p = AgentPaths::suderra_os();
        assert_eq!(
            p.config_file(),
            Path::new("/var/lib/suderra-site/config.yaml")
        );
        assert_eq!(p.data_root(), Path::new("/var/lib/suderra"));
        assert_eq!(
            p.activation_state_file(),
            Path::new("/var/lib/suderra/state/activation.json")
        );
        assert_eq!(
            p.db_key_file(),
            Path::new("/var/lib/suderra/secrets/db.key")
        );
        assert_eq!(
            p.offline_queue_db(),
            Path::new("/var/lib/suderra/queue/offline_queue.db")
        );
        assert_eq!(p.scripts_dir(), Path::new("/var/lib/suderra/scripts"));
        assert_eq!(
            p.rbac_version_db(),
            Path::new("/var/lib/suderra/policy-cache/rbac_version.sqlite")
        );
        assert_eq!(
            p.config_integrity_floor_dir(),
            Path::new("/var/lib/suderra/policy-cache")
        );
        assert_eq!(p.audit_log_file(), Path::new("/var/log/suderra/audit.log"));
        assert_eq!(
            p.agent_health_file(),
            Path::new("/run/suderra/agent-health/health.json")
        );
        assert!(p.check_agent_writable(&p.agent_health_file()).is_ok());
        assert_eq!(AgentPaths::current(), &p);
    }

    #[cfg(feature = "suderra-os")]
    #[test]
    fn suderra_os_accepts_writes_only_below_the_writable_dirs() {
        let p = AgentPaths::suderra_os();
        assert!(
            p.check_agent_writable(Path::new("/var/lib/suderra/state/x.db"))
                .is_ok()
        );
        assert!(
            p.check_agent_writable(Path::new("/var/log/suderra/audit.log"))
                .is_ok()
        );
        for bad in [
            "/etc/suderra/x.db",
            "/var/lib/suderra/x.db",
            "/var/lib/suderra/state",
            "/var/lib/suderra-site/config.yaml",
            "/var/lib/suderra/state/../../suderra-site/x",
            "relative/x.db",
        ] {
            assert!(
                p.check_agent_writable(Path::new(bad)).is_err(),
                "{bad} must be refused"
            );
        }
    }

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn generic_defaults_are_the_legacy_layout() {
        let p = AgentPaths::generic(GenericOverrides::default());
        assert_eq!(p.config_file(), Path::new("/etc/suderra/config.yaml"));
        assert_eq!(
            p.config_integrity_sidecar(),
            Path::new("/etc/suderra/config.yaml.sig")
        );
        assert_eq!(p.data_root(), Path::new("/var/lib/suderra"));
        assert_eq!(
            p.offline_queue_db(),
            Path::new("/var/lib/suderra/offline_queue.db")
        );
        assert_eq!(p.retain_db(), Path::new("/var/lib/suderra/retain.db"));
        assert_eq!(
            p.license_cache_db(),
            Path::new("/var/lib/suderra/license_cache.sqlite")
        );
        assert_eq!(
            p.jti_dedup_db(),
            Path::new("/var/lib/suderra/jti_dedup.sqlite")
        );
        assert_eq!(
            p.rbac_version_db(),
            Path::new("/var/lib/suderra/rbac_version.sqlite")
        );
        assert_eq!(
            p.user_token_version_db(),
            Path::new("/var/lib/suderra/user_token_version.sqlite")
        );
        assert_eq!(p.scada_db(), Path::new("/var/lib/suderra/scada/scada.db"));
        #[cfg(not(feature = "os-managed-updates"))]
        assert_eq!(
            p.partition_store_file(),
            Path::new("/var/lib/suderra/partition.json")
        );
        assert_eq!(
            p.program_state_file(),
            Path::new("/var/lib/suderra/program.json")
        );
        assert_eq!(
            p.config_integrity_floor_dir(),
            Path::new("/var/lib/suderra")
        );
        assert_eq!(p.legacy_db_key_file(), Path::new("/etc/suderra/db.key"));
        assert_eq!(p.audit_log_file(), Path::new("/var/log/suderra/audit.log"));
    }

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn generic_overrides_move_every_derived_path() {
        let p = AgentPaths::generic(GenericOverrides {
            config_file: Some(PathBuf::from("/srv/agent/conf.yaml")),
            data_root: Some(PathBuf::from("/srv/agent/data")),
            db_key_file: Some(PathBuf::from("/srv/agent/key")),
        });
        assert_eq!(p.config_file(), Path::new("/srv/agent/conf.yaml"));
        assert_eq!(
            p.config_integrity_sidecar(),
            Path::new("/srv/agent/conf.yaml.sig")
        );
        assert_eq!(p.db_key_override(), Some(Path::new("/srv/agent/key")));
        for derived in [
            p.offline_queue_db(),
            p.retain_db(),
            p.license_cache_db(),
            p.jti_dedup_db(),
            p.rbac_version_db(),
            p.user_token_version_db(),
            p.scada_db(),
            p.lora_sessions_db(),
            #[cfg(not(feature = "os-managed-updates"))]
            p.partition_store_file(),
            p.activation_state_file(),
            p.db_key_file(),
            p.scripts_dir(),
            p.rbac_manifest_persist_file(),
            p.io_config_file(),
            p.config_integrity_floor_dir(),
        ] {
            assert!(
                derived.starts_with("/srv/agent/data"),
                "{} must follow SUDERRA_DATA_DIR",
                derived.display()
            );
        }
    }

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn generic_rbac_manifest_prefers_the_agent_persisted_copy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = AgentPaths::generic(GenericOverrides {
            data_root: Some(dir.path().to_path_buf()),
            ..GenericOverrides::default()
        });
        assert_eq!(
            p.rbac_manifest_file(),
            Path::new("/etc/suderra/rbac_manifest.json")
        );
        std::fs::write(p.rbac_manifest_persist_file(), b"{}").expect("seed");
        assert_eq!(p.rbac_manifest_file(), p.rbac_manifest_persist_file());
    }

    #[test]
    fn nothing_the_agent_writes_resolves_under_etc() {
        #[cfg(feature = "suderra-os")]
        let p = AgentPaths::suderra_os();
        #[cfg(not(feature = "suderra-os"))]
        let p = AgentPaths::generic(GenericOverrides::default());
        // Directories the agent writes files into are checked through a
        // child: the writable roots themselves are the OS's (DEC-4.3).
        let written = [
            p.activation_state_file(),
            p.db_key_file(),
            p.offline_queue_db(),
            p.scripts_dir().join("script.json"),
            p.retain_db(),
            p.program_state_file(),
            p.license_cache_db(),
            p.jti_dedup_db(),
            p.rbac_version_db(),
            p.user_token_version_db(),
            p.keystore_rotation_marker("keystore_rotation_marker.json"),
            p.backup_dir().join("backup.tar"),
            p.scada_dir().join("process.json"),
            p.lora_sessions_db(),
            p.opcua_own_pki_dir().join("cert.der"),
            p.opcua_trusted_certs_dir().join("client.der"),
            #[cfg(not(feature = "os-managed-updates"))]
            p.partition_store_file(),
            p.audit_log_file(),
            p.config_integrity_floor_dir().join("floor.json"),
        ];
        for path in written {
            assert!(
                !path.starts_with("/etc"),
                "{} is agent-written and must not live under /etc (DEC-4.1)",
                path.display()
            );
            #[cfg(feature = "suderra-os")]
            assert!(p.check_agent_writable(&path).is_ok(), "{}", path.display());
        }
    }
}
