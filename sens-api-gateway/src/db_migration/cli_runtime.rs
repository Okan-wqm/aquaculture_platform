//! Production `CeremonyRuntime` impl (PR-195 Batch #10
//! — fills in the dependency-injection seam from
//! Batch #9 with the agent's real runtime IO sources).
//!
//! ## Why this module exists
//!
//! Batch #9 landed `CeremonyRuntime` as a trait
//! abstracting the SIX runtime inputs the migration
//! orchestrator needs. The trait's only impl was the
//! test-facing `StubRuntime`. This batch lands the
//! production impl: `BootstrappedCeremonyRuntime` —
//! a struct holding pre-fetched runtime inputs that
//! satisfy the trait's accessor contract.
//!
//! ## Why pre-fetched (not lazy IO inside the trait)
//!
//! The trait's accessor methods are `async fn`
//! deliberately — they accept impls that do live IO
//! per-call (TPM unseal, file read, network probe).
//! For production, however, ALL six runtime inputs are
//! known at process startup: the CLI subcommand reads
//! the agent config, derives `data_dir`, reads
//! `/etc/machine-id`, reads `/etc/suderra/db.key`,
//! takes `device_id` from config, optionally takes
//! `program_artifact_sha256` from the bytecode loader,
//! and constructs the keystore — all BEFORE the
//! orchestrator loop starts.
//!
//! Pre-fetching the inputs into the struct turns each
//! accessor call into a clone-and-return; no
//! per-consumer IO surprises. The architectural
//! discipline mirrors `AppState` in `main.rs`: load
//! once at startup, hand a read-only handle to every
//! downstream consumer.
//!
//! ## Constructor seam
//!
//! `BootstrappedCeremonyRuntime::from_runtime_sources`
//! takes the agent's already-built keystore + already-
//! parsed `device_id` + already-loaded program SHA (or
//! `None`) + already-resolved `data_dir`, then
//! performs the TWO remaining IO reads INSIDE the
//! constructor:
//!
//!   - `machine_id` via `crate::machine_id::read()`
//!     (Batch #344 env-override-aware reader).
//!   - `secret_key` via the env-override-aware reader
//!     defined below — fail-closed read of
//!     `SUDERRA_DB_KEY_PATH || /etc/suderra/db.key`.
//!     Distinct from `offline_queue::
//!     load_or_create_db_secret` which CREATES on
//!     missing — the migration ceremony MUST NOT create
//!     a fresh secret because that would silently
//!     produce a different v1 key than what the
//!     consumer DBs were originally encrypted under.
//!     A missing secret means "this host has no v1
//!     state to migrate" → constructor returns
//!     `BootstrapError::SecretKeyMissing` → the CLI
//!     refuses to proceed.
//!
//! ## Test ergonomics
//!
//! Two test surfaces:
//!
//!   - `BootstrappedCeremonyRuntime::from_parts` —
//!     bypass-the-IO constructor for unit tests that
//!     just want a runtime impl with canned values.
//!     Used by orchestrator tests that don't care
//!     about the IO read paths.
//!   - `from_runtime_sources` with the
//!     `SUDERRA_MACHINE_ID_PATH` + `SUDERRA_DB_KEY_PATH`
//!     env-overrides — exercises the real IO logic
//!     under hermetic CI.
//!
//! Tests use a per-module `Mutex` to serialize the
//! env-mutating cases per the `machine_id` module's
//! existing pattern (env vars are process-wide global
//! state, parallel tests must not race).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::cli::{KNOWN_SQLCIPHER_CONSUMERS, MigrationArgs};
use super::cli_executor::{
    CeremonyRuntime, ExecutionError, MigrationOutcome, RuntimeError, execute_migration,
};
use crate::keystore::Keystore;
use crate::keystore::purpose::KeyPurpose;

/// Errors returned by `from_runtime_sources` when one
/// of the IO reads fails. Distinct from the trait's
/// `RuntimeError` because constructor failures abort
/// the whole CLI invocation BEFORE any orchestrator
/// loop starts; per-accessor `RuntimeError` only fires
/// during orchestrator execution. Keeping the two
/// shapes separate makes the failure boundary
/// architecturally explicit.
#[derive(Debug)]
pub enum BootstrapError {
    /// `crate::machine_id::read()` returned an error.
    /// Operator must fix `/etc/machine-id` access OR
    /// set `SUDERRA_MACHINE_ID_PATH`.
    MachineIdUnreadable { reason: String },
    /// `/etc/suderra/db.key` (or the `SUDERRA_DB_KEY_PATH`
    /// override) does not exist. The migration ceremony
    /// CANNOT proceed because the v1 DBs' encryption
    /// keys were derived from a now-missing secret.
    /// Operator must restore the secret-key file from
    /// backup OR confirm there's nothing to migrate.
    SecretKeyMissing { path: PathBuf },
    /// Secret-key file exists but is unreadable
    /// (permissions / disk error).
    SecretKeyUnreadable { path: PathBuf, reason: String },
    /// Secret-key file exists but is shorter than the
    /// minimum acceptable length (16 bytes — same as
    /// `offline_queue::load_or_create_db_secret`'s
    /// validation).
    SecretKeyTooShort { path: PathBuf, len: usize },
    /// `device_id` (passed in by the caller from
    /// `AgentConfig.device_id`) is empty. Empty
    /// device_id means the device is unprovisioned —
    /// migration ceremony is a no-op because the v2
    /// device-bound consumers can't derive a context.
    DeviceIdEmpty,
}

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MachineIdUnreadable { reason } => {
                write!(f, "ceremony_bootstrap_machine_id_unreadable: {reason}")
            }
            Self::SecretKeyMissing { path } => write!(
                f,
                "ceremony_bootstrap_secret_key_missing: {}",
                path.display()
            ),
            Self::SecretKeyUnreadable { path, reason } => write!(
                f,
                "ceremony_bootstrap_secret_key_unreadable: {}: {reason}",
                path.display()
            ),
            Self::SecretKeyTooShort { path, len } => write!(
                f,
                "ceremony_bootstrap_secret_key_too_short: {}: {len} bytes",
                path.display()
            ),
            Self::DeviceIdEmpty => write!(f, "ceremony_bootstrap_device_id_empty"),
        }
    }
}

impl std::error::Error for BootstrapError {}

/// Production `CeremonyRuntime` impl — pre-fetched
/// runtime inputs + keystore handle, accessors are
/// pure reads of stored fields.
pub struct BootstrappedCeremonyRuntime {
    machine_id: Vec<u8>,
    secret_key: Vec<u8>,
    deployment_uuid: Vec<u8>,
    program_artifact_sha256: Option<Vec<u8>>,
    keystore: Arc<dyn Keystore>,
    data_dir: PathBuf,
}

/// Manual `Debug` impl that does NOT leak sensitive
/// byte payloads (machine_id + secret_key + device
/// uuid) to log surfaces. Required because the test
/// harness `Result::expect_err` requires `Debug` on
/// the Ok type, but the trivial derive would
/// accidentally make `format!("{:?}", runtime)` print
/// the raw secret-key bytes.
impl std::fmt::Debug for BootstrappedCeremonyRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BootstrappedCeremonyRuntime")
            .field("machine_id_len", &self.machine_id.len())
            .field("secret_key_len", &self.secret_key.len())
            .field("deployment_uuid_len", &self.deployment_uuid.len())
            .field(
                "program_artifact_sha256_present",
                &self.program_artifact_sha256.is_some(),
            )
            .field("keystore_backend", &self.keystore.backend())
            .field("data_dir", &self.data_dir)
            .finish()
    }
}

impl BootstrappedCeremonyRuntime {
    /// Production constructor. Performs the TWO IO
    /// reads (machine-id + secret-key) internally;
    /// other fields are caller-provided because they
    /// originate from already-loaded subsystems
    /// (config, bytecode loader, keystore).
    ///
    /// **Errors:** `BootstrapError` discriminating the
    /// failure source for operator post-mortem.
    pub fn from_runtime_sources(
        device_id: String,
        program_artifact_sha256: Option<Vec<u8>>,
        keystore: Arc<dyn Keystore>,
        data_dir: PathBuf,
    ) -> Result<Self, BootstrapError> {
        if device_id.is_empty() {
            return Err(BootstrapError::DeviceIdEmpty);
        }

        let machine_id =
            crate::machine_id::read().map_err(|e| BootstrapError::MachineIdUnreadable {
                reason: format!("{e}"),
            })?;

        let secret_key = read_secret_key_for_migration()?;

        Ok(Self {
            machine_id: machine_id.into_bytes(),
            secret_key,
            deployment_uuid: device_id.into_bytes(),
            program_artifact_sha256,
            keystore,
            data_dir,
        })
    }

    /// Bypass-the-IO constructor for unit tests that
    /// just need a runtime impl with canned values.
    /// Production code path goes through
    /// `from_runtime_sources`.
    #[cfg(test)]
    pub(crate) fn from_parts(
        machine_id: Vec<u8>,
        secret_key: Vec<u8>,
        deployment_uuid: Vec<u8>,
        program_artifact_sha256: Option<Vec<u8>>,
        keystore: Arc<dyn Keystore>,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            machine_id,
            secret_key,
            deployment_uuid,
            program_artifact_sha256,
            keystore,
            data_dir,
        }
    }
}

#[async_trait]
impl CeremonyRuntime for BootstrappedCeremonyRuntime {
    async fn machine_id(&self) -> Result<Vec<u8>, RuntimeError> {
        Ok(self.machine_id.clone())
    }

    async fn secret_key(&self) -> Result<Vec<u8>, RuntimeError> {
        Ok(self.secret_key.clone())
    }

    async fn deployment_uuid(&self) -> Result<Vec<u8>, RuntimeError> {
        Ok(self.deployment_uuid.clone())
    }

    async fn program_artifact_sha256(&self) -> Result<Option<Vec<u8>>, RuntimeError> {
        Ok(self.program_artifact_sha256.clone())
    }

    fn keystore(&self) -> &dyn Keystore {
        self.keystore.as_ref()
    }

    fn db_path_for(&self, purpose: KeyPurpose) -> PathBuf {
        // Look up the canonical filename for this
        // KeyPurpose from the SSoT consumer mapping.
        // Falls through to a sentinel for non-SqlCipher
        // purposes (which the orchestrator filters out
        // via the resolver's WrongPurpose error before
        // ever reaching this path — defense in depth).
        for (filename, p) in KNOWN_SQLCIPHER_CONSUMERS {
            if *p == purpose {
                return self.data_dir.join(filename);
            }
        }
        self.data_dir.join("__unknown_consumer.db")
    }
}

/// Env-override-aware secret-key reader for the
/// migration ceremony. Distinct from
/// `offline_queue::load_or_create_db_secret` which
/// CREATES on missing — see module doc for why the
/// migration path MUST be read-only.
fn read_secret_key_for_migration() -> Result<Vec<u8>, BootstrapError> {
    // Path resolution is `db_secret`'s, not ours: the ceremony must read the
    // SAME file the consumers encrypted under, so a second copy of the
    // env-override + default pair here could only ever drift from it. What
    // stays local is the READ-ONLY semantics below — the ceremony fail-closes
    // on a missing file instead of creating a fresh secret.
    let path: PathBuf = crate::db_secret::secret_key_path();

    if !path.exists() {
        return Err(BootstrapError::SecretKeyMissing { path });
    }

    let bytes = std::fs::read(&path).map_err(|e| BootstrapError::SecretKeyUnreadable {
        path: path.clone(),
        reason: format!("{e}"),
    })?;

    if bytes.len() < crate::db_secret::MIN_SECRET_KEY_LEN {
        return Err(BootstrapError::SecretKeyTooShort {
            path,
            len: bytes.len(),
        });
    }

    Ok(bytes)
}

/// Unified ceremony error — wraps both bootstrap-stage
/// failures (constructor IO) and orchestrator-stage
/// failures (per-loop bootstrap or whole-ceremony
/// abort). The CLI dispatch site (`main.rs`'s
/// `--migrate-db` arm) returns this to its caller for
/// uniform exit-code mapping.
///
/// **Why two stages, one error type:** the dispatch
/// site doesn't care whether failure came from the
/// constructor IO read or the orchestrator's pre-loop
/// fetch — both are pre-DB-touch and both yield
/// `ExitCode::FAILURE`. A unified taxonomy keeps the
/// dispatch arm short. Per-stage discrimination is
/// preserved INSIDE this enum for operator post-mortem
/// (Display strings carry the source).
#[derive(Debug)]
pub enum CeremonyError {
    /// `BootstrappedCeremonyRuntime::from_runtime_sources`
    /// failed (machine-id unreadable, secret-key
    /// missing/short/unreadable, device-id empty).
    Bootstrap(BootstrapError),
    /// `execute_migration` aborted before the per-
    /// consumer loop could begin (one of the runtime
    /// trait's pre-loop accessors failed).
    Execution(ExecutionError),
}

impl std::fmt::Display for CeremonyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bootstrap(e) => {
                write!(f, "ceremony_failed_at_bootstrap: {e}")
            }
            Self::Execution(e) => {
                write!(f, "ceremony_failed_at_execution: {e}")
            }
        }
    }
}

impl std::error::Error for CeremonyError {}

impl From<BootstrapError> for CeremonyError {
    fn from(e: BootstrapError) -> Self {
        Self::Bootstrap(e)
    }
}

impl From<ExecutionError> for CeremonyError {
    fn from(e: ExecutionError) -> Self {
        Self::Execution(e)
    }
}

/// Top-level ceremony entry point — one call from the
/// CLI dispatch site to "do the migration". Composes
/// the production runtime constructor (Batch #10) with
/// the orchestrator (Batch #9) into a single async
/// function whose error space is the unified
/// `CeremonyError`.
///
/// **Caller contract:**
///
///   - `args` — already-parsed CLI args (from Batch #6
///     `parse_args`). The orchestrator reads
///     `data_dir` from these.
///   - `device_id` — device's provisioning UUID
///     (caller plumbs from the agent's loaded config).
///   - `program_artifact_sha256` — currently-loaded
///     program's bytecode SHA-256, or `None` if no
///     program is loaded. Caller plumbs from the
///     bytecode loader.
///   - `keystore` — agent's already-built keystore
///     handle. Caller plumbs from the keystore
///     subsystem boot path.
///   - `now_unix` — current Unix timestamp seconds for
///     manifest's `last_updated_at_unix_secs`. Caller
///     passes `chrono::Utc::now().timestamp()` or
///     equivalent.
///
/// **Effects:** for each enabled consumer in
/// `KNOWN_SQLCIPHER_CONSUMERS`, atomic PRAGMA rekey +
/// manifest swap from v1 to v2 if the DB exists and is
/// currently at v1; idempotent skip otherwise.
///
/// **Returns:** `MigrationOutcome` carrying one
/// per-consumer outcome (Migrated / Skipped / Failed).
/// The CLI dispatch site formats this as JSONL stdout
/// per the runbook + maps `is_clean()` to the process
/// exit code.
pub async fn execute_migration_ceremony(
    args: &MigrationArgs,
    device_id: String,
    program_artifact_sha256: Option<Vec<u8>>,
    keystore: Arc<dyn Keystore>,
    now_unix: i64,
) -> Result<MigrationOutcome, CeremonyError> {
    let runtime = BootstrappedCeremonyRuntime::from_runtime_sources(
        device_id,
        program_artifact_sha256,
        keystore,
        args.data_dir.clone(),
    )?;

    let outcome = execute_migration(args, &runtime, now_unix).await?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::error::{KeyDerivationError, KeystoreError, KeystoreErrorKind};
    use crate::keystore::purpose::DerivedKeyId;
    use crate::keystore::secret::KeyMaterial;
    use crate::keystore::{KeyBackend, RotationSource};
    use std::sync::Mutex;

    /// Per-module env-mutation serializer. Mirrors
    /// `machine_id::tests::ENV_MUTEX` since the
    /// constructor reads two process-wide env vars
    /// (`SUDERRA_MACHINE_ID_PATH` + `SUDERRA_DB_KEY_PATH`).
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    struct StubKeystore;

    #[async_trait]
    impl Keystore for StubKeystore {
        fn backend(&self) -> KeyBackend {
            KeyBackend::FileBacked
        }

        async fn derive_key(
            &self,
            purpose: KeyPurpose,
            _context: &[u8],
        ) -> Result<KeyMaterial, KeyDerivationError> {
            Ok(KeyMaterial::from_derived_bytes(purpose, [0u8; 32]))
        }

        fn derived_key_id(&self, _purpose: KeyPurpose, _context: &[u8]) -> DerivedKeyId {
            DerivedKeyId([0u8; 16])
        }

        async fn rotate_master(&self) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }

        async fn rotate_master_with_source(
            &self,
            _source: RotationSource<'_>,
        ) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }
    }

    #[tokio::test]
    async fn from_parts_returns_canned_values_via_trait_accessors() {
        let dir = tempfile::tempdir().expect("tempdir");
        let rt = BootstrappedCeremonyRuntime::from_parts(
            b"mid".to_vec(),
            b"secret-key-32-bytes-of-data!".to_vec(),
            b"device-uuid".to_vec(),
            Some(vec![0xAA; 32]),
            Arc::new(StubKeystore),
            dir.path().to_path_buf(),
        );
        assert_eq!(rt.machine_id().await.expect("ok"), b"mid".to_vec());
        assert_eq!(
            rt.secret_key().await.expect("ok"),
            b"secret-key-32-bytes-of-data!".to_vec()
        );
        assert_eq!(
            rt.deployment_uuid().await.expect("ok"),
            b"device-uuid".to_vec()
        );
        assert_eq!(
            rt.program_artifact_sha256().await.expect("ok"),
            Some(vec![0xAA; 32])
        );
    }

    #[test]
    fn db_path_for_returns_canonical_filename_per_purpose() {
        let dir = tempfile::tempdir().expect("tempdir");
        let rt = BootstrappedCeremonyRuntime::from_parts(
            b"mid".to_vec(),
            b"secret-key-32-bytes-of-data!".to_vec(),
            b"device-uuid".to_vec(),
            None,
            Arc::new(StubKeystore),
            dir.path().to_path_buf(),
        );
        assert_eq!(
            rt.db_path_for(KeyPurpose::SqlCipherOfflineQueue),
            dir.path().join("offline_queue.db")
        );
        assert_eq!(
            rt.db_path_for(KeyPurpose::SqlCipherRetainPersistence),
            dir.path().join("retain_persistence.db")
        );
        assert_eq!(
            rt.db_path_for(KeyPurpose::SqlCipherLicenseCache),
            dir.path().join("license_cache.db")
        );
        assert_eq!(
            rt.db_path_for(KeyPurpose::SqlCipherBytecodeRetain),
            dir.path().join("bytecode_retain.db")
        );
    }

    #[test]
    fn db_path_for_non_sqlcipher_purpose_returns_sentinel() {
        let dir = tempfile::tempdir().expect("tempdir");
        let rt = BootstrappedCeremonyRuntime::from_parts(
            b"mid".to_vec(),
            b"secret-key-32-bytes-of-data!".to_vec(),
            b"device-uuid".to_vec(),
            None,
            Arc::new(StubKeystore),
            dir.path().to_path_buf(),
        );
        // AuditHmacChain is not in KNOWN_SQLCIPHER_CONSUMERS.
        // The fallthrough sentinel returns a defense-in-
        // depth path that the orchestrator would never
        // visit (the resolver fails earlier).
        assert_eq!(
            rt.db_path_for(KeyPurpose::AuditHmacChain),
            dir.path().join("__unknown_consumer.db")
        );
    }

    #[test]
    fn from_runtime_sources_empty_device_id_returns_device_id_empty() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let err = BootstrappedCeremonyRuntime::from_runtime_sources(
            String::new(),
            None,
            Arc::new(StubKeystore),
            dir.path().to_path_buf(),
        )
        .expect_err("must error");
        assert!(matches!(err, BootstrapError::DeviceIdEmpty));
    }

    #[test]
    fn from_runtime_sources_missing_secret_returns_secret_key_missing() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let mid = dir.path().join("mid");
        std::fs::write(&mid, "abc123\n").expect("seed mid");
        let no_secret = dir.path().join("nope.key");

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_MACHINE_ID_PATH", &mid);
            std::env::set_var("SUDERRA_DB_KEY_PATH", &no_secret);
        }
        let result = BootstrappedCeremonyRuntime::from_runtime_sources(
            "device-uuid".into(),
            None,
            Arc::new(StubKeystore),
            dir.path().to_path_buf(),
        );
        unsafe {
            std::env::remove_var("SUDERRA_MACHINE_ID_PATH");
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let err = result.expect_err("must error");
        match err {
            BootstrapError::SecretKeyMissing { path } => {
                assert_eq!(path, no_secret);
            }
            other => panic!("expected SecretKeyMissing, got {other:?}"),
        }
    }

    #[test]
    fn from_runtime_sources_too_short_secret_returns_too_short() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let mid = dir.path().join("mid");
        std::fs::write(&mid, "abc123\n").expect("seed mid");
        let short_secret = dir.path().join("short.key");
        std::fs::write(&short_secret, b"123").expect("seed short");

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_MACHINE_ID_PATH", &mid);
            std::env::set_var("SUDERRA_DB_KEY_PATH", &short_secret);
        }
        let result = BootstrappedCeremonyRuntime::from_runtime_sources(
            "device-uuid".into(),
            None,
            Arc::new(StubKeystore),
            dir.path().to_path_buf(),
        );
        unsafe {
            std::env::remove_var("SUDERRA_MACHINE_ID_PATH");
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let err = result.expect_err("must error");
        match err {
            BootstrapError::SecretKeyTooShort { len, .. } => {
                assert_eq!(len, 3);
            }
            other => panic!("expected SecretKeyTooShort, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn from_runtime_sources_happy_path_constructs_runtime() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let mid = dir.path().join("mid");
        std::fs::write(&mid, "machine-id-from-file\n").expect("seed mid");
        let secret = dir.path().join("db.key");
        std::fs::write(&secret, vec![0xCDu8; 32]).expect("seed secret");

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_MACHINE_ID_PATH", &mid);
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let rt = BootstrappedCeremonyRuntime::from_runtime_sources(
            "device-uuid-12345".into(),
            Some(vec![0xEE; 32]),
            Arc::new(StubKeystore),
            dir.path().to_path_buf(),
        );
        unsafe {
            std::env::remove_var("SUDERRA_MACHINE_ID_PATH");
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let rt = rt.expect("happy path constructs");
        assert_eq!(
            rt.machine_id().await.expect("ok"),
            b"machine-id-from-file".to_vec()
        );
        assert_eq!(rt.secret_key().await.expect("ok"), vec![0xCD; 32]);
        assert_eq!(
            rt.deployment_uuid().await.expect("ok"),
            b"device-uuid-12345".to_vec()
        );
        assert_eq!(
            rt.program_artifact_sha256().await.expect("ok"),
            Some(vec![0xEE; 32])
        );
    }

    #[test]
    fn bootstrap_error_display_strings_pinned() {
        let cases: Vec<(BootstrapError, &str)> = vec![
            (
                BootstrapError::MachineIdUnreadable { reason: "x".into() },
                "ceremony_bootstrap_machine_id_unreadable",
            ),
            (
                BootstrapError::SecretKeyMissing {
                    path: PathBuf::from("/x"),
                },
                "ceremony_bootstrap_secret_key_missing",
            ),
            (
                BootstrapError::SecretKeyUnreadable {
                    path: PathBuf::from("/x"),
                    reason: "y".into(),
                },
                "ceremony_bootstrap_secret_key_unreadable",
            ),
            (
                BootstrapError::SecretKeyTooShort {
                    path: PathBuf::from("/x"),
                    len: 3,
                },
                "ceremony_bootstrap_secret_key_too_short",
            ),
            (
                BootstrapError::DeviceIdEmpty,
                "ceremony_bootstrap_device_id_empty",
            ),
        ];
        for (err, prefix) in cases {
            let s = format!("{err}");
            assert!(s.contains(prefix), "missing `{prefix}` in: {s}");
        }
    }

    #[test]
    fn bootstrap_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<BootstrapError>();
    }

    // -------- execute_migration_ceremony integration tests --------
    //
    // These exercise the full bootstrap → orchestrator
    // path: env-var-sandboxed IO read + per-consumer
    // ceremony loop. The v1-seed helper mirrors the
    // existing rekey test pattern (Connection::open +
    // PRAGMA key apply + create dummy table).

    use crate::db_migration::cli::OutputFormat;
    use crate::db_migration::manifest::manifest_path_for_db;
    use crate::db_migration::schema_version::DbKeySchemaVersion;
    use crate::db_migration::v1_legacy_key::{
        derive_v1_legacy_key, format_sqlcipher_pragma_key_hex,
    };
    use crate::keystore::secret::KeyMaterial as RealKeyMaterial;
    use rusqlite::Connection;

    /// Stub keystore that returns a deterministic v2
    /// key so the ceremony can produce a verifiable
    /// PRAGMA key string.
    struct DeterministicKeystore;

    #[async_trait]
    impl Keystore for DeterministicKeystore {
        fn backend(&self) -> KeyBackend {
            KeyBackend::FileBacked
        }

        async fn derive_key(
            &self,
            purpose: KeyPurpose,
            _context: &[u8],
        ) -> Result<RealKeyMaterial, KeyDerivationError> {
            let mut bytes = [0u8; 32];
            bytes[0] = match purpose {
                KeyPurpose::SqlCipherOfflineQueue => 0xb1,
                KeyPurpose::SqlCipherRetainPersistence => 0xb2,
                KeyPurpose::SqlCipherLicenseCache => 0xb3,
                KeyPurpose::SqlCipherBytecodeRetain => 0xb4,
                _ => 0xff,
            };
            Ok(RealKeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(&self, _purpose: KeyPurpose, _context: &[u8]) -> DerivedKeyId {
            DerivedKeyId([0u8; 16])
        }

        async fn rotate_master(&self) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }

        async fn rotate_master_with_source(
            &self,
            _source: RotationSource<'_>,
        ) -> Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }
    }

    fn seed_v1_db_for_ceremony(path: &std::path::Path, machine_id: &[u8], secret_key: &[u8]) {
        let v1_bytes = derive_v1_legacy_key(machine_id, secret_key);
        let v1_hex = format_sqlcipher_pragma_key_hex(&v1_bytes);
        let conn = Connection::open(path).expect("open db");
        conn.execute_batch(&format!("PRAGMA key = \"x'{v1_hex}'\";"))
            .expect("apply v1 key");
        conn.execute_batch(
            "CREATE TABLE seed (id INTEGER PRIMARY KEY); \
             INSERT INTO seed VALUES (1);",
        )
        .expect("seed");
    }

    #[tokio::test]
    async fn execute_migration_ceremony_happy_path_migrates_v1_db_to_v2() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");

        // Seed env-overrides (machine-id + secret-key
        // sandboxed for hermetic IO).
        let mid = dir.path().join("mid");
        std::fs::write(&mid, "ceremony-machine-id-aa\n").expect("seed mid");
        let secret = dir.path().join("db.key");
        let secret_bytes = vec![0xDDu8; 32];
        std::fs::write(&secret, &secret_bytes).expect("seed secret");

        // Seed a v1 OfflineQueue DB with the SAME bytes
        // the ceremony will compute internally.
        let db = dir.path().join("offline_queue.db");
        seed_v1_db_for_ceremony(&db, b"ceremony-machine-id-aa", &secret_bytes);

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_MACHINE_ID_PATH", &mid);
            std::env::set_var("SUDERRA_DB_KEY_PATH", &secret);
        }
        let args = MigrationArgs {
            data_dir: dir.path().to_path_buf(),
            schema_target: DbKeySchemaVersion::V2KeystoreDerived,
            output_format: OutputFormat::Jsonl,
            dry_run: false,
        };
        let result = execute_migration_ceremony(
            &args,
            "ceremony-device-uuid".into(),
            Some(vec![0xEE; 32]),
            Arc::new(DeterministicKeystore),
            1_700_000_000,
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_MACHINE_ID_PATH");
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let outcome = result.expect("ceremony succeeds");
        assert!(outcome.is_clean());
        assert_eq!(outcome.per_consumer.len(), 4);

        // OfflineQueue is index 0 in KNOWN_SQLCIPHER_CONSUMERS.
        match &outcome.per_consumer[0] {
            super::super::cli_executor::ConsumerOutcome::Migrated { purpose, from, to } => {
                assert_eq!(*purpose, KeyPurpose::SqlCipherOfflineQueue);
                assert_eq!(*from, DbKeySchemaVersion::V1MachineIdDerived);
                assert_eq!(*to, DbKeySchemaVersion::V2KeystoreDerived);
            }
            other => panic!("expected Migrated, got {other:?}"),
        }

        // Manifest sidecar now declares v2.
        let sidecar = manifest_path_for_db(&db);
        let manifest_str = std::fs::read_to_string(&sidecar).expect("read sidecar");
        assert!(
            manifest_str.contains("v2-keystore-derived"),
            "expected v2 manifest, got: {manifest_str}"
        );
    }

    #[tokio::test]
    async fn execute_migration_ceremony_bootstrap_failure_surfaces_as_bootstrap_error() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let no_secret = dir.path().join("nope.key");

        // SAFETY: env-mutation serialized via ENV_MUTEX.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", &no_secret);
        }
        let args = MigrationArgs {
            data_dir: dir.path().to_path_buf(),
            schema_target: DbKeySchemaVersion::V2KeystoreDerived,
            output_format: OutputFormat::Jsonl,
            dry_run: false,
        };
        let result = execute_migration_ceremony(
            &args,
            "device-uuid".into(),
            None,
            Arc::new(DeterministicKeystore),
            1_700_000_000,
        )
        .await;
        unsafe {
            std::env::remove_var("SUDERRA_DB_KEY_PATH");
        }

        let err = result.expect_err("must fail");
        match err {
            CeremonyError::Bootstrap(BootstrapError::SecretKeyMissing { .. }) => {}
            other => panic!("expected Bootstrap::SecretKeyMissing, got {other:?}"),
        }
    }

    #[test]
    fn ceremony_error_display_strings_pinned() {
        let cases: Vec<(CeremonyError, &str)> = vec![
            (
                CeremonyError::Bootstrap(BootstrapError::DeviceIdEmpty),
                "ceremony_failed_at_bootstrap",
            ),
            (
                CeremonyError::Execution(ExecutionError::Bootstrap(RuntimeError {
                    source: "machine_id".into(),
                    reason: "test".into(),
                })),
                "ceremony_failed_at_execution",
            ),
        ];
        for (err, prefix) in cases {
            let s = format!("{err}");
            assert!(s.contains(prefix), "missing `{prefix}` in: {s}");
        }
    }

    #[test]
    fn ceremony_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<CeremonyError>();
    }
}
