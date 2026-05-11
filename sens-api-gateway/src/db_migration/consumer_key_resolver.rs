//! D-3 SQLCipher consumer key-resolution unified entry
//! point (PR-195 Batch #8 — composes the prior D-3
//! primitives into a single SSoT for "compute the
//! SQLCipher PRAGMA key for a given consumer at boot").
//!
//! ## Why this module exists
//!
//! Two callsites need to compute the SAME PRAGMA-key
//! string for the SAME consumer at the SAME manifest
//! state:
//!
//!   1. **The migration tool** (PR-195 Batch #6
//!      `--migrate-db`) — reads the manifest, derives
//!      the CURRENT key (v1 or v2) so it can open the
//!      DB before issuing PRAGMA rekey to the new key.
//!   2. **Each consumer's constructor** (subsequent
//!      PR-195 batches: offline_queue + license_cache +
//!      retain_persistence + bytecode_retain) — reads
//!      the manifest at agent boot, derives the key
//!      that opens its own DB.
//!
//! Without a single SSoT resolver, each callsite
//! would inline:
//!
//!   - Read manifest via `db_migration::manifest::read_manifest`.
//!   - Branch on schema_version (or missing-manifest =
//!     legacy v1 default per Batch #330).
//!   - For v1: derive via `v1_legacy_key` + format hex.
//!   - For v2: resolve context bytes via
//!     `consumer_context` (Batch #7) + derive via
//!     `v2_keystore_key` + format hex.
//!
//! Two inline implementations would drift silently
//! across releases; the migration tool would compute
//! one byte string, the consumer's boot path would
//! compute another, and the result is "database is
//! encrypted or is not a database" at next consumer
//! open.
//!
//! Architectural fix: ONE async function,
//! `resolve_consumer_pragma_key`, that composes
//! every prior D-3 primitive into a single
//! manifest-aware key-resolution path.
//!
//! ## Composition graph
//!
//! ```text
//! resolve_consumer_pragma_key(db_path, purpose, ctx, keystore, v1_inputs)
//!   ├─ manifest::read_manifest(sidecar_path)              [Batch #329 + #338]
//!   │    ├─ Some(v2 manifest) → v2 path:
//!   │    │    └─ consumer_context::context_bytes_for_purpose [Batch #7]
//!   │    │       └─ v2_keystore_key::derive_v2_sqlcipher_pragma_key_hex [Batch #332/#336]
//!   │    │           └─ Zeroizing<String> ✓
//!   │    ├─ Some(v1 manifest) | None → v1 path (legacy default):
//!   │    │    ├─ v1_legacy_key::derive_v1_legacy_key  [Batch #331/#335]
//!   │    │    └─ v1_legacy_key::format_sqlcipher_pragma_key_hex
//!   │    │       └─ wrap in Zeroizing<String>          [Batch #336 harness]
//!   │    └─ Err → propagate as ResolverError::Manifest
//!   ```
//!
//! ## Why `Zeroizing<String>` return
//!
//! Mirrors the v2 shim's harness (Batch #336 SEC-MEDIUM-001
//! closure). The PRAGMA-key hex string is sensitive
//! (it's the cipher key in textual form); returning a
//! plain `String` would leak via heap-alloc residue.
//! The wrapper scrubs on Drop.
//!
//! For the v1 path, `format_sqlcipher_pragma_key_hex`
//! returns a plain `String`; we wrap it via
//! `Zeroizing::new(...)` immediately. Brief unwrapped
//! lifetime documented + acceptable per the v2-shim
//! precedent.
//!
//! ## Why async
//!
//! `Keystore::derive_key` is async (TPM-backed needs
//! to await TPM responses; file-backed is async too
//! for trait-object uniformity). The resolver must
//! match. The v1 path is sync but wrapped in async
//! for shape uniformity at the call site — both
//! callsites get a single `await` regardless of the
//! current schema_version.
//!
//! ## Caller contract
//!
//! - `db_path` — the SQLCipher DB file path; manifest
//!   sidecar derived via `manifest::manifest_path_for_db`.
//! - `purpose` — the SqlCipher* `KeyPurpose` for this
//!   consumer (caller picks per
//!   `KNOWN_SQLCIPHER_CONSUMERS` from Batch #6).
//! - `ctx` — pre-computed consumer-context inputs
//!   (Batch #7) for the v2 path.
//! - `keystore` — agent's runtime keystore for the
//!   v2 derivation.
//! - `v1_inputs` — caller-provided machine_id +
//!   secret_key bytes for the v1 fallback path. The
//!   resolver does NOT do IO to read these; the
//!   caller (migration tool OR consumer constructor)
//!   plumbs them via `crate::machine_id::read()` +
//!   the consumer's existing secret-key reader.

use std::path::Path;

use zeroize::Zeroizing;

use super::consumer_context::{ConsumerContext, ConsumerContextError, context_bytes_for_purpose};
use super::manifest::{DbMigrationError, manifest_path_for_db, read_manifest};
use super::schema_version::DbKeySchemaVersion;
use super::v1_legacy_key::{derive_v1_legacy_key, format_sqlcipher_pragma_key_hex};
use super::v2_keystore_key::{V2DerivationError, derive_v2_sqlcipher_pragma_key_hex};
use crate::keystore::Keystore;
use crate::keystore::purpose::KeyPurpose;

/// V1-path inputs that the resolver needs in addition
/// to the v2 path's keystore + context. Caller plumbs
/// these from the agent's runtime sources (machine-id
/// reader + secret-key file reader).
#[derive(Debug, Clone)]
pub struct V1Inputs {
    pub machine_id: Vec<u8>,
    pub secret_key: Vec<u8>,
}

/// Errors returned by the unified resolver.
#[derive(Debug)]
pub enum ResolverError {
    /// Manifest read failed (corrupt JSON, envelope
    /// version mismatch, IO error). Caller should
    /// route operator triage per the `db-migration-
    /// detection-failure.md` runbook.
    Manifest(DbMigrationError),
    /// Consumer context resolution failed (caller
    /// passed a non-SqlCipher purpose, OR a program-
    /// bound purpose without program_artifact_sha256,
    /// OR a device-bound purpose with empty
    /// deployment_uuid).
    Context(ConsumerContextError),
    /// v2 derivation via the keystore failed.
    V2Derivation(V2DerivationError),
}

impl std::fmt::Display for ResolverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Manifest(e) => {
                write!(f, "consumer_key_resolver_manifest_failed: {e}")
            }
            Self::Context(e) => {
                write!(f, "consumer_key_resolver_context_failed: {e}")
            }
            Self::V2Derivation(e) => {
                write!(f, "consumer_key_resolver_v2_derivation_failed: {e}")
            }
        }
    }
}

impl std::error::Error for ResolverError {}

impl From<DbMigrationError> for ResolverError {
    fn from(e: DbMigrationError) -> Self {
        Self::Manifest(e)
    }
}

impl From<ConsumerContextError> for ResolverError {
    fn from(e: ConsumerContextError) -> Self {
        Self::Context(e)
    }
}

impl From<V2DerivationError> for ResolverError {
    fn from(e: V2DerivationError) -> Self {
        Self::V2Derivation(e)
    }
}

/// Resolved key shape — carries both the PRAGMA-key
/// hex string AND the schema_version it was derived
/// under so the caller can route post-derivation
/// behavior (e.g., the migration tool's "if v1, schedule
/// rekey" path; consumer constructor's "if v1, log
/// migration-backlog WARN").
#[derive(Debug)]
pub struct ResolvedConsumerKey {
    pub pragma_key_hex: Zeroizing<String>,
    pub current_version: DbKeySchemaVersion,
}

/// Resolve the SQLCipher PRAGMA key for the given
/// consumer at the current manifest state. Branches
/// on the manifest's schema_version (or treats
/// missing-manifest as legacy v1 default per Batch
/// #330) + composes every prior D-3 primitive into
/// a single async path.
///
/// **Returns:** `ResolvedConsumerKey` with the
/// `Zeroizing<String>` PRAGMA-key hex + the
/// schema_version the key was derived under.
///
/// **Errors:** structured `ResolverError` per the
/// failure mode (manifest unreadable, context
/// missing, v2 derivation failed).
pub async fn resolve_consumer_pragma_key(
    db_path: &Path,
    purpose: KeyPurpose,
    ctx: &ConsumerContext,
    keystore: &dyn Keystore,
    v1_inputs: &V1Inputs,
) -> Result<ResolvedConsumerKey, ResolverError> {
    let sidecar = manifest_path_for_db(db_path);
    let manifest = read_manifest(&sidecar)?;

    // Determine the current schema_version. Missing
    // manifest = legacy v1 default per Batch #330's
    // boot detector architectural decision (pre-D-3
    // historical state).
    let current_version = match &manifest {
        Some(m) => m.schema_version,
        None => DbKeySchemaVersion::V1MachineIdDerived,
    };

    let pragma_key_hex = match current_version {
        DbKeySchemaVersion::V1MachineIdDerived => {
            // v1 fallback — caller-provided machine_id +
            // secret_key bytes through the pure HMAC
            // kernel (Batch #331/#335).
            let key_bytes = derive_v1_legacy_key(&v1_inputs.machine_id, &v1_inputs.secret_key);
            // Wrap in Zeroizing immediately. The
            // intermediate plain String exists for one
            // statement before being moved into
            // Zeroizing::new — brief unwrapped lifetime
            // acceptable per the v2-shim precedent
            // (Batch #336 module doc).
            Zeroizing::new(format_sqlcipher_pragma_key_hex(&key_bytes))
        }
        DbKeySchemaVersion::V2KeystoreDerived => {
            // v2 path — context-bytes resolver (Batch
            // #7) + v2 shim (Batch #332/#336).
            let ctx_bytes = context_bytes_for_purpose(purpose, ctx)?;
            derive_v2_sqlcipher_pragma_key_hex(keystore, purpose, ctx_bytes).await?
        }
    };

    Ok(ResolvedConsumerKey {
        pragma_key_hex,
        current_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_migration::manifest::{DbKeySourceManifest, write_manifest};
    use crate::keystore::error::{KeyDerivationError, KeystoreError, KeystoreErrorKind};
    use crate::keystore::purpose::DerivedKeyId;
    use crate::keystore::secret::KeyMaterial;
    use crate::keystore::{KeyBackend, RotationSource};
    use async_trait::async_trait;

    /// Stub keystore mirroring the v2 shim test pattern
    /// (Batch #332). Returns deterministic 0xa1+
    /// prefixed bytes for SqlCipherOfflineQueue so the
    /// resolver's hex output is predictable.
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

    fn v1_inputs_canonical() -> V1Inputs {
        V1Inputs {
            machine_id: b"machine-resolver".to_vec(),
            secret_key: b"secret-resolver-32bytes-key!!".to_vec(),
        }
    }

    fn ctx_canonical() -> ConsumerContext {
        ConsumerContext {
            deployment_uuid: b"deployment-resolver".to_vec(),
            program_artifact_sha256: Some(vec![0xBB; 32]),
        }
    }

    #[tokio::test]
    async fn resolve_missing_manifest_treats_as_v1_legacy_default() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("offline_queue.db");
        // No manifest written — pre-D-3 historical state.

        let resolved = resolve_consumer_pragma_key(
            &db,
            KeyPurpose::SqlCipherOfflineQueue,
            &ctx_canonical(),
            &StubKeystore,
            &v1_inputs_canonical(),
        )
        .await
        .expect("resolve ok");
        assert_eq!(
            resolved.current_version,
            DbKeySchemaVersion::V1MachineIdDerived
        );
        // 64-char lower-hex.
        assert_eq!(resolved.pragma_key_hex.len(), 64);
        assert!(
            resolved
                .pragma_key_hex
                .chars()
                .all(|c| matches!(c, '0'..='9' | 'a'..='f'))
        );
    }

    #[tokio::test]
    async fn resolve_v1_manifest_derives_via_legacy_kernel() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("offline_queue.db");
        write_manifest(
            &manifest_path_for_db(&db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V1MachineIdDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v1 manifest");

        let resolved = resolve_consumer_pragma_key(
            &db,
            KeyPurpose::SqlCipherOfflineQueue,
            &ctx_canonical(),
            &StubKeystore,
            &v1_inputs_canonical(),
        )
        .await
        .expect("resolve ok");
        assert_eq!(
            resolved.current_version,
            DbKeySchemaVersion::V1MachineIdDerived
        );
        // v1 legacy kernel output is deterministic for
        // these inputs; pin the first byte (full hex
        // would be a brittle KAT — the v1 kernel's
        // own RFC 4231 KAT is the algorithm pin).
        let v1_bytes = derive_v1_legacy_key(b"machine-resolver", b"secret-resolver-32bytes-key!!");
        let expected = format_sqlcipher_pragma_key_hex(&v1_bytes);
        assert_eq!(*resolved.pragma_key_hex, expected);
    }

    #[tokio::test]
    async fn resolve_v2_manifest_derives_via_keystore() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("offline_queue.db");
        write_manifest(
            &manifest_path_for_db(&db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v2 manifest");

        let resolved = resolve_consumer_pragma_key(
            &db,
            KeyPurpose::SqlCipherOfflineQueue,
            &ctx_canonical(),
            &StubKeystore,
            &v1_inputs_canonical(),
        )
        .await
        .expect("resolve ok");
        assert_eq!(
            resolved.current_version,
            DbKeySchemaVersion::V2KeystoreDerived
        );
        // Stub keystore returns 0xa1 prefix for
        // SqlCipherOfflineQueue → hex starts with "a1".
        assert!(resolved.pragma_key_hex.starts_with("a1"));
    }

    #[tokio::test]
    async fn resolve_corrupt_manifest_returns_manifest_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("offline_queue.db");
        std::fs::write(manifest_path_for_db(&db), b"not valid JSON").expect("seed corrupt");

        let err = resolve_consumer_pragma_key(
            &db,
            KeyPurpose::SqlCipherOfflineQueue,
            &ctx_canonical(),
            &StubKeystore,
            &v1_inputs_canonical(),
        )
        .await
        .expect_err("must error");
        assert!(matches!(err, ResolverError::Manifest(_)));
    }

    #[tokio::test]
    async fn resolve_v2_with_missing_context_bytes_returns_context_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("retain_persistence.db");
        write_manifest(
            &manifest_path_for_db(&db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v2 manifest");

        // Program-bound consumer with NO program_sha256.
        let ctx = ConsumerContext {
            deployment_uuid: b"x".to_vec(),
            program_artifact_sha256: None,
        };

        let err = resolve_consumer_pragma_key(
            &db,
            KeyPurpose::SqlCipherRetainPersistence,
            &ctx,
            &StubKeystore,
            &v1_inputs_canonical(),
        )
        .await
        .expect_err("must error");
        match err {
            ResolverError::Context(ConsumerContextError::ProgramSha256Required { purpose }) => {
                assert_eq!(purpose, KeyPurpose::SqlCipherRetainPersistence);
            }
            other => {
                panic!("expected Context::ProgramSha256Required, got {other:?}")
            }
        }
    }

    #[tokio::test]
    async fn resolve_v2_with_non_sqlcipher_purpose_returns_v2_wrong_purpose() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("misuse.db");
        write_manifest(
            &manifest_path_for_db(&db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed");

        // AuditHmacChain — non-SqlCipher purpose. The
        // context resolver fires first (returns
        // WrongPurpose) before the v2 shim's own guard.
        // Either error class is acceptable architectural
        // failure — both are operator-visible
        // fail-closed. Pin that ONE of the two fires.
        let err = resolve_consumer_pragma_key(
            &db,
            KeyPurpose::AuditHmacChain,
            &ctx_canonical(),
            &StubKeystore,
            &v1_inputs_canonical(),
        )
        .await
        .expect_err("must error");
        assert!(
            matches!(
                err,
                ResolverError::Context(ConsumerContextError::WrongPurpose { .. })
                    | ResolverError::V2Derivation(V2DerivationError::WrongPurpose { .. })
            ),
            "expected WrongPurpose from either Context or V2Derivation, got {err:?}"
        );
    }

    #[test]
    fn resolver_error_display_strings_pinned() {
        let cases: Vec<(ResolverError, &str)> = vec![
            (
                ResolverError::Manifest(DbMigrationError::Corrupt {
                    path: std::path::PathBuf::from("/x"),
                    reason: "y".to_string(),
                }),
                "consumer_key_resolver_manifest_failed",
            ),
            (
                ResolverError::Context(ConsumerContextError::WrongPurpose {
                    got: KeyPurpose::AuditHmacChain,
                }),
                "consumer_key_resolver_context_failed",
            ),
            (
                ResolverError::V2Derivation(V2DerivationError::WrongPurpose {
                    got: KeyPurpose::AuditHmacChain,
                }),
                "consumer_key_resolver_v2_derivation_failed",
            ),
        ];
        for (err, prefix) in cases {
            let s = format!("{err}");
            assert!(s.contains(prefix), "missing `{prefix}` in: {s}");
        }
    }

    #[test]
    fn resolver_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<ResolverError>();
    }
}
