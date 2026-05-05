//! D-3 SQLCipher migration ceremony executor (PR-195
//! Batch #9 — composes the CLI dry-run plan with
//! Batch #8's `consumer_key_resolver` + Batch #1-#3
//! rekey kernel into the actual per-consumer migration
//! orchestrator).
//!
//! ## Why this module exists
//!
//! Batch #6 landed the CLI scaffold with `--dry-run`
//! support and a deliberate execution refusal. Batch #8
//! landed the `consumer_key_resolver` SSoT. This batch
//! composes both into a single async orchestrator:
//! `execute_migration(args, runtime, now_unix) ->
//! MigrationOutcome` that loops over
//! `KNOWN_SQLCIPHER_CONSUMERS` and migrates each from
//! v1 to v2 via the existing primitives.
//!
//! The CLI scaffold's execution refusal stays in place
//! at this batch boundary — wiring the CLI to call
//! `execute_migration` requires a
//! `ProductionCeremonyRuntime` impl that plumbs
//! `/etc/machine-id`, `/etc/suderra/db.key`, provisioning
//! state, the bytecode loader, and the agent's keystore.
//! That production wire-up is a separate PR-195 batch —
//! this batch lands the orchestrator + runtime trait +
//! structured outcome shape so the production wiring
//! becomes a "fill in the trait impl" exercise.
//!
//! ## Why a `CeremonyRuntime` trait
//!
//! The orchestrator needs SIX runtime inputs that come
//! from disparate agent sources:
//!
//!   - `machine_id` — `/etc/machine-id` reader.
//!   - `secret_key` — `/etc/suderra/db.key` reader.
//!   - `deployment_uuid` — provisioning state JSON.
//!   - `program_artifact_sha256` — bytecode loader (or
//!     `None` if no program is loaded).
//!   - `keystore` — agent's runtime keystore handle.
//!   - per-consumer `db_path` — data-dir + filename map
//!     from `KNOWN_SQLCIPHER_CONSUMERS`.
//!
//! Inlining all six readers into the orchestrator would
//! couple the executor to every runtime IO path. The
//! trait is the architectural dependency-injection
//! seam: the orchestrator depends on shape, not source.
//! Tests pass a `StubCeremonyRuntime`; production wires
//! a `ProductionCeremonyRuntime` (subsequent batch).
//!
//! ## Per-consumer migration flow
//!
//! For each `(filename, KeyPurpose)` in
//! `KNOWN_SQLCIPHER_CONSUMERS`:
//!
//!   1. `db_path = runtime.db_path_for(purpose)`.
//!   2. If `!db_path.exists()`: record
//!      `ConsumerOutcome::Skipped { reason: NoDb }`.
//!   3. `resolved = resolve_consumer_pragma_key(...)`
//!      yields current key + schema_version (Batch #8).
//!   4. If `resolved.current_version == V2`: record
//!      `ConsumerOutcome::Skipped { reason: AlreadyV2 }`.
//!   5. `v2_hex = derive_v2_sqlcipher_pragma_key_hex(...)`
//!      yields the target key under v2 derivation.
//!   6. `conn = Connection::open(db_path)` + `PRAGMA key
//!      = "x'<current_hex>'"` (open existing v1 DB).
//!   7. `rekey_with_manifest_swap(conn, manifest_path,
//!      current_hex, v2_hex, new_manifest)` — atomic
//!      rekey + manifest update with rollback (Batch #3).
//!   8. Record `ConsumerOutcome::Migrated { from: V1,
//!      to: V2 }`.
//!
//! Errors at any step surface as
//! `ConsumerOutcome::Failed { reason }` — the
//! orchestrator continues to the next consumer rather
//! than aborting, so a single corrupted manifest
//! doesn't block migration of the other 3 DBs. The
//! migration is per-consumer atomic (PRAGMA rekey +
//! manifest swap is one transaction at the rekey-swap
//! kernel level); cross-consumer is intentionally NOT
//! atomic because the 4 consumers' DBs are independent
//! state stores with no shared invariants.
//!
//! ## Why blocking SQLCipher work inside `async fn`
//!
//! `Keystore::derive_key` is async (TPM-backed needs
//! to await TPM responses). The rekey kernel +
//! `Connection::open` are sync (rusqlite is sync).
//! Mixing both in one async function blocks the tokio
//! worker for the duration of each `PRAGMA rekey`.
//! Acceptable here because:
//!
//!   - The migration ceremony is a one-shot operator
//!     tool, not a hot-path service.
//!   - The CLI runs on a multi-thread tokio runtime;
//!     blocking one worker for a few seconds is a
//!     non-issue for a single-purpose binary.
//!   - Wrapping in `spawn_blocking` would require
//!     moving `&Connection` across thread boundaries,
//!     which rusqlite forbids (`Connection` is `!Sync`).
//!
//! Documented here so a future "make it non-blocking"
//! refactor sees the architectural reasoning rather
//! than treating the inline blocking call as an
//! oversight.

use std::path::PathBuf;

use async_trait::async_trait;
use rusqlite::Connection;

use super::cli::{MigrationArgs, KNOWN_SQLCIPHER_CONSUMERS};
use super::consumer_context::{ConsumerContext, ConsumerContextError};
use super::consumer_key_resolver::{
    resolve_consumer_pragma_key, ResolverError, V1Inputs,
};
use super::manifest::{manifest_path_for_db, DbKeySourceManifest};
use super::rekey_swap::{rekey_with_manifest_swap, RekeyManifestError};
use super::schema_version::DbKeySchemaVersion;
use super::v2_keystore_key::{
    derive_v2_sqlcipher_pragma_key_hex, V2DerivationError,
};
use crate::keystore::purpose::KeyPurpose;
use crate::keystore::Keystore;

/// Errors returned by `CeremonyRuntime` accessors when
/// the underlying agent IO fails (machine-id missing,
/// secret-key file unreadable, provisioning state not
/// initialised, bytecode loader failure, etc.).
///
/// **Why a single shape (not per-source variants):**
/// the orchestrator only needs to know "the runtime
/// could not provide input X". The structured `source`
/// + `reason` carries the operator-readable diagnosis;
/// the production trait impl picks the right values.
/// A flat shape keeps the trait signature uniform.
#[derive(Debug)]
pub struct RuntimeError {
    pub source: String,
    pub reason: String,
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "ceremony_runtime_failed: {}: {}",
            self.source, self.reason
        )
    }
}

impl std::error::Error for RuntimeError {}

/// Dependency-injection seam between the migration
/// orchestrator and the agent's runtime IO sources.
/// Production trait impl reads from the real sources;
/// tests pass a stub.
///
/// **Trait bounds:** `Send + Sync` so the trait object
/// can flow across the tokio runtime's worker pool;
/// production impls hold `Arc`-shared state internally.
///
/// **Why async on every method:** every accessor
/// touches IO of some shape (machine-id file read,
/// keystore TPM unseal, provisioning state load).
/// Uniform async lets the orchestrator `await` each
/// without per-method shape divergence.
#[async_trait]
pub trait CeremonyRuntime: Send + Sync {
    /// Read the host's machine-id bytes (first kernel
    /// of v1 legacy key derivation per Batch #331).
    async fn machine_id(&self) -> Result<Vec<u8>, RuntimeError>;

    /// Read the v1 secret-key file bytes (second kernel
    /// of v1 legacy key derivation).
    async fn secret_key(&self) -> Result<Vec<u8>, RuntimeError>;

    /// Read the deployment-instance UUID bytes (v2
    /// context for device-bound consumers per ADR-031).
    async fn deployment_uuid(&self) -> Result<Vec<u8>, RuntimeError>;

    /// Read the loaded program's artifact SHA-256 bytes
    /// (v2 context for program-bound consumers per
    /// ADR-031). `None` is acceptable when no program
    /// is currently loaded — the orchestrator skips
    /// program-bound consumers in that case rather
    /// than failing the whole ceremony.
    async fn program_artifact_sha256(
        &self,
    ) -> Result<Option<Vec<u8>>, RuntimeError>;

    /// Hand the agent's keystore handle to the
    /// orchestrator for v2 key derivation.
    fn keystore(&self) -> &dyn Keystore;

    /// Map a consumer's `KeyPurpose` to its on-disk DB
    /// path. Production impl joins `args.data_dir` with
    /// the filename from `KNOWN_SQLCIPHER_CONSUMERS`.
    fn db_path_for(&self, purpose: KeyPurpose) -> PathBuf;
}

/// Per-consumer migration outcome — structured for
/// JSONL stdout emission + operator post-mortem.
#[derive(Debug, PartialEq, Eq)]
pub enum ConsumerOutcome {
    /// DB was migrated from `from` → `to`.
    Migrated {
        purpose: KeyPurpose,
        from: DbKeySchemaVersion,
        to: DbKeySchemaVersion,
    },
    /// Migration was skipped — the DB is either absent
    /// or already at the target schema_version.
    Skipped {
        purpose: KeyPurpose,
        reason: SkipReason,
    },
    /// Migration failed at one of the per-consumer
    /// steps. Other consumers continued.
    Failed {
        purpose: KeyPurpose,
        reason: FailReason,
    },
}

/// Why a consumer was skipped (operator-readable
/// taxonomy, NOT a free-form string — keeps stdout
/// machine-parseable per the runbook).
#[derive(Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// `db_path_for(purpose)` does not exist on disk.
    /// The consumer hasn't run yet on this host so
    /// there's nothing to migrate.
    NoDb,
    /// Manifest already declares
    /// `V2KeystoreDerived` — migration was already
    /// applied (re-running the ceremony is idempotent).
    AlreadyV2,
}

/// Why a consumer's migration failed. Wraps the
/// underlying primitive error so operator post-mortem
/// retains the failure source.
#[derive(Debug)]
pub enum FailReason {
    /// `consumer_key_resolver` failed (manifest
    /// corrupt, context bytes missing for v2 path,
    /// keystore derivation failed).
    Resolver(ResolverError),
    /// Context-bytes resolution for the v2 target key
    /// failed (program-bound consumer with no program
    /// SHA, or device-bound consumer with empty UUID).
    Context(ConsumerContextError),
    /// v2 target-key derivation via the keystore failed.
    V2Derivation(V2DerivationError),
    /// Opening the existing v1-encrypted DB or applying
    /// `PRAGMA key` failed before rekey could begin.
    DbOpen { reason: String },
    /// `rekey_with_manifest_swap` failed; rollback was
    /// attempted per the kernel's contract.
    RekeySwap(RekeyManifestError),
}

impl PartialEq for FailReason {
    /// Equality for tests: compare on the discriminant
    /// only. Underlying primitive errors don't all
    /// implement `PartialEq` (e.g., `RekeyManifestError`
    /// wraps rusqlite errors which lack PartialEq), so
    /// per-variant equality on the inner state is not
    /// available — discriminant-equality is sufficient
    /// for the orchestrator's test assertions which
    /// only check "did the right error class fire".
    fn eq(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }
}

impl Eq for FailReason {}

/// Aggregate outcome across all four consumers — what
/// `execute_migration` returns to its caller (the CLI).
#[derive(Debug, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub per_consumer: Vec<ConsumerOutcome>,
}

impl MigrationOutcome {
    /// True iff every consumer either migrated cleanly
    /// or was skipped for a benign reason. Operator's
    /// "should I exit 0 or 1" decision rule.
    pub fn is_clean(&self) -> bool {
        self.per_consumer.iter().all(|o| !matches!(o, ConsumerOutcome::Failed { .. }))
    }
}

/// Top-level error from `execute_migration` — fires
/// when the orchestrator can't even START the loop
/// (e.g., machine-id missing, secret-key unreadable).
/// Per-consumer failures DO NOT escape as this error;
/// they're recorded as `ConsumerOutcome::Failed` so the
/// orchestrator can continue.
#[derive(Debug)]
pub enum ExecutionError {
    /// Pre-loop runtime input fetch failed (machine_id
    /// / secret_key / deployment_uuid). Without these
    /// the orchestrator cannot derive ANY consumer's
    /// key, so the whole ceremony aborts.
    Bootstrap(RuntimeError),
}

impl std::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bootstrap(e) => write!(
                f,
                "execute_migration_bootstrap_failed: {e}"
            ),
        }
    }
}

impl std::error::Error for ExecutionError {}

impl From<RuntimeError> for ExecutionError {
    fn from(e: RuntimeError) -> Self {
        Self::Bootstrap(e)
    }
}

/// Migration ceremony orchestrator. Composes Batch #8's
/// `resolve_consumer_pragma_key` + Batch #3's
/// `rekey_with_manifest_swap` + the `CeremonyRuntime`
/// trait's IO accessors into a single async function
/// that walks `KNOWN_SQLCIPHER_CONSUMERS` and migrates
/// each v1 DB to v2.
///
/// **Atomicity:** per-consumer rekey + manifest swap
/// is atomic at the kernel level (Batch #3 transactional
/// rollback). Cross-consumer is NOT atomic — the 4
/// DBs are independent state stores with no shared
/// invariants, so a mid-loop crash leaves a partial
/// migration that re-running the ceremony resumes.
///
/// **Returns:** `MigrationOutcome` carrying one
/// `ConsumerOutcome` per `KNOWN_SQLCIPHER_CONSUMERS`
/// entry. `ExecutionError` only fires when pre-loop
/// runtime inputs are unavailable; per-consumer
/// failures stay scoped to their `ConsumerOutcome`.
pub async fn execute_migration(
    _args: &MigrationArgs,
    rt: &dyn CeremonyRuntime,
    now_unix: i64,
) -> Result<MigrationOutcome, ExecutionError> {
    // Pre-loop bootstrap — fetch every runtime input
    // we'll need across the per-consumer loop. If any
    // fails the whole ceremony aborts (we can't migrate
    // any DB without these).
    let machine_id = rt.machine_id().await?;
    let secret_key = rt.secret_key().await?;
    let deployment_uuid = rt.deployment_uuid().await?;
    let program_sha = rt.program_artifact_sha256().await?;

    let v1_inputs = V1Inputs {
        machine_id,
        secret_key,
    };
    let ctx = ConsumerContext {
        deployment_uuid,
        program_artifact_sha256: program_sha,
    };

    let mut per_consumer = Vec::with_capacity(KNOWN_SQLCIPHER_CONSUMERS.len());
    for (_filename, purpose) in KNOWN_SQLCIPHER_CONSUMERS {
        let outcome = migrate_one(*purpose, rt, &ctx, &v1_inputs, now_unix).await;
        per_consumer.push(outcome);
    }

    Ok(MigrationOutcome { per_consumer })
}

/// Per-consumer ceremony — extracted so the orchestrator
/// loop body stays small + tests can pin individual
/// consumer outcomes without dispatching the whole loop.
async fn migrate_one(
    purpose: KeyPurpose,
    rt: &dyn CeremonyRuntime,
    ctx: &ConsumerContext,
    v1_inputs: &V1Inputs,
    now_unix: i64,
) -> ConsumerOutcome {
    let db_path = rt.db_path_for(purpose);

    // Step 1: nothing to migrate if the DB doesn't exist.
    if !db_path.exists() {
        return ConsumerOutcome::Skipped {
            purpose,
            reason: SkipReason::NoDb,
        };
    }

    // Step 2: resolve the current key (manifest-aware).
    let resolved = match resolve_consumer_pragma_key(
        &db_path,
        purpose,
        ctx,
        rt.keystore(),
        v1_inputs,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return ConsumerOutcome::Failed {
                purpose,
                reason: FailReason::Resolver(e),
            };
        }
    };

    // Step 3: idempotent skip if already v2.
    if matches!(
        resolved.current_version,
        DbKeySchemaVersion::V2KeystoreDerived
    ) {
        return ConsumerOutcome::Skipped {
            purpose,
            reason: SkipReason::AlreadyV2,
        };
    }

    // Step 4: derive the target v2 key.
    let ctx_bytes = match super::consumer_context::context_bytes_for_purpose(
        purpose, ctx,
    ) {
        Ok(b) => b,
        Err(e) => {
            return ConsumerOutcome::Failed {
                purpose,
                reason: FailReason::Context(e),
            };
        }
    };
    let v2_hex = match derive_v2_sqlcipher_pragma_key_hex(
        rt.keystore(),
        purpose,
        ctx_bytes,
    )
    .await
    {
        Ok(h) => h,
        Err(e) => {
            return ConsumerOutcome::Failed {
                purpose,
                reason: FailReason::V2Derivation(e),
            };
        }
    };

    // Step 5: open existing v1 DB with the resolved
    // current key. The PRAGMA key statement applies the
    // current cipher key so subsequent statements
    // (including PRAGMA rekey) succeed.
    let conn = match Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            return ConsumerOutcome::Failed {
                purpose,
                reason: FailReason::DbOpen {
                    reason: format!("open: {e}"),
                },
            };
        }
    };
    let key_stmt = format!(
        "PRAGMA key = \"x'{}'\";",
        resolved.pragma_key_hex.as_str()
    );
    if let Err(e) = conn.execute_batch(&key_stmt) {
        return ConsumerOutcome::Failed {
            purpose,
            reason: FailReason::DbOpen {
                reason: format!("apply_key: {e}"),
            },
        };
    }

    // Step 6: atomic rekey + manifest swap with
    // transactional rollback on manifest failure.
    let new_manifest = DbKeySourceManifest {
        schema_version: DbKeySchemaVersion::V2KeystoreDerived,
        last_updated_at_unix_secs: now_unix,
    };
    match rekey_with_manifest_swap(
        &conn,
        manifest_path_for_db(&db_path),
        resolved.pragma_key_hex.as_str(),
        v2_hex.as_str(),
        new_manifest,
    ) {
        Ok(()) => ConsumerOutcome::Migrated {
            purpose,
            from: resolved.current_version,
            to: DbKeySchemaVersion::V2KeystoreDerived,
        },
        Err(e) => ConsumerOutcome::Failed {
            purpose,
            reason: FailReason::RekeySwap(e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_migration::cli::{MigrationArgs, OutputFormat};
    use crate::db_migration::manifest::{
        write_manifest, DbKeySourceManifest,
    };
    use crate::keystore::error::{
        KeyDerivationError, KeystoreError, KeystoreErrorKind,
    };
    use crate::keystore::purpose::DerivedKeyId;
    use crate::keystore::secret::KeyMaterial;
    use crate::keystore::{KeyBackend, RotationSource};
    use crate::db_migration::v1_legacy_key::{
        derive_v1_legacy_key, format_sqlcipher_pragma_key_hex,
    };
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Stub keystore mirroring Batch #8's pattern —
    /// returns deterministic 0xa1+ prefixed bytes
    /// per SqlCipher KeyPurpose.
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
            let mut bytes = [0u8; 32];
            bytes[0] = match purpose {
                KeyPurpose::SqlCipherOfflineQueue => 0xa1,
                KeyPurpose::SqlCipherRetainPersistence => 0xa2,
                KeyPurpose::SqlCipherLicenseCache => 0xa3,
                KeyPurpose::SqlCipherBytecodeRetain => 0xa4,
                _ => 0xff,
            };
            Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(
            &self,
            _purpose: KeyPurpose,
            _context: &[u8],
        ) -> DerivedKeyId {
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

    /// Stub runtime — deterministic inputs + tempdir-
    /// based DB paths for hermetic tests.
    struct StubRuntime {
        tempdir: PathBuf,
        keystore: Arc<StubKeystore>,
        program_sha: Option<Vec<u8>>,
        machine_id_override: Option<RuntimeError>,
    }

    impl StubRuntime {
        fn new(tempdir: PathBuf) -> Self {
            Self {
                tempdir,
                keystore: Arc::new(StubKeystore),
                program_sha: Some(vec![0xCC; 32]),
                machine_id_override: None,
            }
        }

        fn with_bootstrap_failure(mut self) -> Self {
            self.machine_id_override = Some(RuntimeError {
                source: "machine_id".into(),
                reason: "test_simulated_failure".into(),
            });
            self
        }

        fn with_no_program(mut self) -> Self {
            self.program_sha = None;
            self
        }
    }

    #[async_trait]
    impl CeremonyRuntime for StubRuntime {
        async fn machine_id(&self) -> Result<Vec<u8>, RuntimeError> {
            if let Some(ref e) = self.machine_id_override {
                return Err(RuntimeError {
                    source: e.source.clone(),
                    reason: e.reason.clone(),
                });
            }
            Ok(b"machine-stub".to_vec())
        }

        async fn secret_key(&self) -> Result<Vec<u8>, RuntimeError> {
            Ok(b"secret-stub-32-bytes-of-key-aa!".to_vec())
        }

        async fn deployment_uuid(&self) -> Result<Vec<u8>, RuntimeError> {
            Ok(b"deployment-stub".to_vec())
        }

        async fn program_artifact_sha256(
            &self,
        ) -> Result<Option<Vec<u8>>, RuntimeError> {
            Ok(self.program_sha.clone())
        }

        fn keystore(&self) -> &dyn Keystore {
            self.keystore.as_ref()
        }

        fn db_path_for(&self, purpose: KeyPurpose) -> PathBuf {
            let filename = match purpose {
                KeyPurpose::SqlCipherOfflineQueue => "offline_queue.db",
                KeyPurpose::SqlCipherRetainPersistence => "retain_persistence.db",
                KeyPurpose::SqlCipherLicenseCache => "license_cache.db",
                KeyPurpose::SqlCipherBytecodeRetain => "bytecode_retain.db",
                _ => "unknown.db",
            };
            self.tempdir.join(filename)
        }
    }

    fn canonical_args(data_dir: PathBuf) -> MigrationArgs {
        MigrationArgs {
            data_dir,
            schema_target: DbKeySchemaVersion::V2KeystoreDerived,
            output_format: OutputFormat::Jsonl,
            dry_run: false,
        }
    }

    /// Seed a v1-keyed SQLCipher DB at `path` using
    /// the same v1 inputs the StubRuntime returns.
    /// Mirrors the Batch #1 rekey test pattern.
    fn seed_v1_db(path: &std::path::Path) {
        let v1_bytes = derive_v1_legacy_key(
            b"machine-stub",
            b"secret-stub-32-bytes-of-key-aa!",
        );
        let v1_hex = format_sqlcipher_pragma_key_hex(&v1_bytes);
        let conn = Connection::open(path).expect("open db");
        conn.execute_batch(&format!("PRAGMA key = \"x'{v1_hex}'\";"))
            .expect("apply v1 key");
        conn.execute_batch(
            "CREATE TABLE seed (id INTEGER PRIMARY KEY); \
             INSERT INTO seed VALUES (1);",
        )
        .expect("seed table");
    }

    #[tokio::test]
    async fn execute_migration_with_no_dbs_skips_all_consumers() {
        let dir = TempDir::new().expect("tempdir");
        let rt = StubRuntime::new(dir.path().to_path_buf());
        let args = canonical_args(dir.path().to_path_buf());

        let outcome = execute_migration(&args, &rt, 1_700_000_000)
            .await
            .expect("execute ok");

        assert_eq!(outcome.per_consumer.len(), 4);
        for o in &outcome.per_consumer {
            match o {
                ConsumerOutcome::Skipped { reason, .. } => {
                    assert_eq!(*reason, SkipReason::NoDb);
                }
                other => panic!("expected Skipped(NoDb), got {other:?}"),
            }
        }
        assert!(outcome.is_clean());
    }

    #[tokio::test]
    async fn execute_migration_with_one_v1_db_migrates_that_consumer() {
        let dir = TempDir::new().expect("tempdir");
        seed_v1_db(&dir.path().join("offline_queue.db"));

        let rt = StubRuntime::new(dir.path().to_path_buf());
        let args = canonical_args(dir.path().to_path_buf());

        let outcome = execute_migration(&args, &rt, 1_700_000_000)
            .await
            .expect("execute ok");

        assert_eq!(outcome.per_consumer.len(), 4);
        // First consumer in KNOWN_SQLCIPHER_CONSUMERS is
        // OfflineQueue → must be Migrated.
        match &outcome.per_consumer[0] {
            ConsumerOutcome::Migrated { purpose, from, to } => {
                assert_eq!(*purpose, KeyPurpose::SqlCipherOfflineQueue);
                assert_eq!(*from, DbKeySchemaVersion::V1MachineIdDerived);
                assert_eq!(*to, DbKeySchemaVersion::V2KeystoreDerived);
            }
            other => panic!("expected Migrated, got {other:?}"),
        }
        // Other 3 consumers' DBs don't exist → NoDb.
        for o in &outcome.per_consumer[1..] {
            assert!(matches!(
                o,
                ConsumerOutcome::Skipped {
                    reason: SkipReason::NoDb,
                    ..
                }
            ));
        }
        assert!(outcome.is_clean());

        // Post-condition: the manifest sidecar now
        // declares V2 schema_version.
        let sidecar = manifest_path_for_db(&dir.path().join("offline_queue.db"));
        let manifest_bytes = std::fs::read(&sidecar).expect("read sidecar");
        let manifest_str = String::from_utf8(manifest_bytes).expect("utf8");
        assert!(
            manifest_str.contains("v2-keystore-derived"),
            "expected v2 manifest, got: {manifest_str}"
        );
    }

    #[tokio::test]
    async fn execute_migration_skips_already_v2_consumer() {
        let dir = TempDir::new().expect("tempdir");
        let db = dir.path().join("offline_queue.db");
        seed_v1_db(&db);

        // Pre-write a v2 manifest — the resolver will
        // see V2 and the orchestrator must skip with
        // AlreadyV2 (idempotency).
        write_manifest(
            &manifest_path_for_db(&db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v2 manifest");

        let rt = StubRuntime::new(dir.path().to_path_buf());
        let args = canonical_args(dir.path().to_path_buf());

        let outcome = execute_migration(&args, &rt, 1_700_000_000)
            .await
            .expect("execute ok");

        match &outcome.per_consumer[0] {
            ConsumerOutcome::Skipped { purpose, reason } => {
                assert_eq!(*purpose, KeyPurpose::SqlCipherOfflineQueue);
                assert_eq!(*reason, SkipReason::AlreadyV2);
            }
            other => panic!("expected Skipped(AlreadyV2), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn execute_migration_corrupt_manifest_records_consumer_failed() {
        let dir = TempDir::new().expect("tempdir");
        let db = dir.path().join("offline_queue.db");
        seed_v1_db(&db);

        // Pre-write a CORRUPT manifest — resolver will
        // return Manifest error → orchestrator records
        // ConsumerOutcome::Failed for THIS consumer +
        // continues to the next 3 (which have no DB).
        std::fs::write(manifest_path_for_db(&db), b"not valid json")
            .expect("seed corrupt");

        let rt = StubRuntime::new(dir.path().to_path_buf());
        let args = canonical_args(dir.path().to_path_buf());

        let outcome = execute_migration(&args, &rt, 1_700_000_000)
            .await
            .expect("execute ok (per-consumer failure does not abort)");

        match &outcome.per_consumer[0] {
            ConsumerOutcome::Failed { purpose, reason } => {
                assert_eq!(*purpose, KeyPurpose::SqlCipherOfflineQueue);
                assert!(matches!(reason, FailReason::Resolver(_)));
            }
            other => panic!("expected Failed(Resolver), got {other:?}"),
        }
        // Remaining 3 still skipped (no DB).
        for o in &outcome.per_consumer[1..] {
            assert!(matches!(
                o,
                ConsumerOutcome::Skipped {
                    reason: SkipReason::NoDb,
                    ..
                }
            ));
        }
        // Aggregate is NOT clean (one failure).
        assert!(!outcome.is_clean());
    }

    #[tokio::test]
    async fn execute_migration_program_bound_consumer_with_no_program_sha_fails() {
        let dir = TempDir::new().expect("tempdir");
        // Seed retain_persistence (program-bound per
        // ADR-031) — runtime returns None for program
        // SHA → context resolver fires
        // ProgramSha256Required.
        let db = dir.path().join("retain_persistence.db");
        seed_v1_db(&db);

        let rt = StubRuntime::new(dir.path().to_path_buf()).with_no_program();
        let args = canonical_args(dir.path().to_path_buf());

        let outcome = execute_migration(&args, &rt, 1_700_000_000)
            .await
            .expect("execute ok");

        // retain_persistence is index 1 in KNOWN_*.
        match &outcome.per_consumer[1] {
            ConsumerOutcome::Failed { purpose, reason } => {
                assert_eq!(*purpose, KeyPurpose::SqlCipherRetainPersistence);
                assert!(matches!(reason, FailReason::Context(_)));
            }
            other => panic!("expected Failed(Context), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn execute_migration_runtime_bootstrap_failure_aborts() {
        let dir = TempDir::new().expect("tempdir");
        let rt = StubRuntime::new(dir.path().to_path_buf())
            .with_bootstrap_failure();
        let args = canonical_args(dir.path().to_path_buf());

        let err = execute_migration(&args, &rt, 1_700_000_000)
            .await
            .expect_err("must abort");
        match err {
            ExecutionError::Bootstrap(e) => {
                assert_eq!(e.source, "machine_id");
                assert_eq!(e.reason, "test_simulated_failure");
            }
        }
    }

    #[test]
    fn migration_outcome_is_clean_returns_true_when_no_failures() {
        let outcome = MigrationOutcome {
            per_consumer: vec![
                ConsumerOutcome::Migrated {
                    purpose: KeyPurpose::SqlCipherOfflineQueue,
                    from: DbKeySchemaVersion::V1MachineIdDerived,
                    to: DbKeySchemaVersion::V2KeystoreDerived,
                },
                ConsumerOutcome::Skipped {
                    purpose: KeyPurpose::SqlCipherLicenseCache,
                    reason: SkipReason::AlreadyV2,
                },
            ],
        };
        assert!(outcome.is_clean());
    }

    #[test]
    fn migration_outcome_is_clean_returns_false_when_any_failure() {
        let outcome = MigrationOutcome {
            per_consumer: vec![
                ConsumerOutcome::Migrated {
                    purpose: KeyPurpose::SqlCipherOfflineQueue,
                    from: DbKeySchemaVersion::V1MachineIdDerived,
                    to: DbKeySchemaVersion::V2KeystoreDerived,
                },
                ConsumerOutcome::Failed {
                    purpose: KeyPurpose::SqlCipherLicenseCache,
                    reason: FailReason::DbOpen {
                        reason: "test".into(),
                    },
                },
            ],
        };
        assert!(!outcome.is_clean());
    }

    #[test]
    fn execution_error_display_pinned() {
        let err = ExecutionError::Bootstrap(RuntimeError {
            source: "machine_id".into(),
            reason: "missing".into(),
        });
        let s = format!("{err}");
        assert!(s.starts_with("execute_migration_bootstrap_failed"));
    }

    #[test]
    fn runtime_error_display_pinned() {
        let err = RuntimeError {
            source: "secret_key".into(),
            reason: "unreadable".into(),
        };
        let s = format!("{err}");
        assert!(s.starts_with("ceremony_runtime_failed: secret_key"));
    }

    #[test]
    fn execution_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<ExecutionError>();
        assert_err::<RuntimeError>();
    }
}
