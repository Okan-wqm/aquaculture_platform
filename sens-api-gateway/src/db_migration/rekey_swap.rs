//! D-3 SQLCipher rekey + manifest atomic swap
//! orchestration (PR-195 Batch #3 — second installment
//! of the D-3 closure arc).
//!
//! ## Why this module exists
//!
//! Batch #1 landed the `pragma_rekey` kernel (atomic at
//! the SQLCipher page-cache level). Batch #338 from
//! PR-194 landed the atomic JSON sidecar write
//! (`shared_io::atomic_json_sidecar` — temp + fsync +
//! rename + parent-dir-fsync). Each is atomic IN
//! ISOLATION, but the v1→v2 migration ceremony needs
//! BOTH to land together: the SQLCipher DB rekeyed to
//! v2 AND the manifest sidecar updated to declare v2.
//!
//! No observable inconsistent state can be allowed.
//! Specifically:
//!
//!   - **DB rekeyed but manifest still says v1:** next
//!     boot reads the manifest, derives the v1 key,
//!     DB-open fails with `database is encrypted or is
//!     not a database`. Operator confusion: looks like
//!     a corrupt DB, not a half-finished migration.
//!   - **Manifest says v2 but DB still under v1:**
//!     next boot derives the v2 key, DB-open fails
//!     same way. Same operator confusion.
//!
//! The OS does not give us a single atomic operation
//! that brackets both the SQLCipher PRAGMA rekey and
//! the JSON sidecar rename. The architectural primitive
//! is therefore a TRANSACTIONAL ORCHESTRATION:
//!
//!   1. Attempt the rekey.
//!   2. If rekey succeeds, attempt the manifest write.
//!   3. If manifest write succeeds, return Ok.
//!   4. If manifest write FAILS after a successful
//!      rekey: attempt to ROLL BACK the rekey (PRAGMA
//!      rekey back to the old key). Two outcomes:
//!      - Rollback succeeds → the DB is back to its
//!        pre-call state (openable with old key,
//!        manifest unchanged). Caller sees
//!        `ManifestWriteFailed { reason }`.
//!      - Rollback fails → the DB is in an in-doubt
//!        state. Caller sees
//!        `ManifestWriteFailedAndRollbackFailed { ... }`.
//!        Operator escalation required.
//!
//! ## Why rollback (not write-manifest-first)
//!
//! An alternative architectural shape is to write the
//! manifest BEFORE the rekey. If manifest succeeds +
//! rekey fails, the manifest's recorded schema_version
//! disagrees with the DB's actual encryption state —
//! same observable-inconsistency problem.
//!
//! A third option is a 3-state schema_version (v1,
//! v1→v2-in-progress, v2) with a write-intent-then-
//! rekey-then-update-final-state pattern. That's the
//! textbook 2-phase commit. But it requires extending
//! `DbKeySchemaVersion` with a transitional variant +
//! every reader's match arm + an audit chain that the
//! migration tool re-runs on crash recovery. Substantial
//! scope creep for the Tier-1 fix this PR-195 needs.
//!
//! Rollback-on-manifest-fail is the simplest shape that
//! preserves the ARCHITECTURAL PROPERTY ("no observable
//! inconsistent state under the happy path or under any
//! single failure"). The double-failure case (rollback
//! also fails) is documented + reported with structured
//! diagnostics; operator escalation is the safe path.
//!
//! ## Why DI on the manifest-write function
//!
//! The orchestration takes a `write_manifest_fn` closure
//! parameter. Tests inject failure modes (e.g.,
//! `|| Err(...)`) to exercise the rollback path
//! deterministically without depending on filesystem
//! permissions or process-uid quirks. Production
//! callers wrap `db_migration::manifest::write_manifest`
//! with the appropriate path + manifest payload closed
//! over.

use rusqlite::Connection;
use std::path::PathBuf;

use super::manifest::{DbKeySourceManifest, write_manifest};
use super::rekey::{RekeyError, pragma_rekey};

/// Errors returned by `rekey_with_manifest_swap`.
#[derive(Debug)]
pub enum RekeyManifestError {
    /// Initial rekey to the new key failed; the DB is
    /// still under the old key (no state change).
    /// Operator action: investigate the rekey error +
    /// retry the migration tool.
    RekeyFailed { reason: String },
    /// Rekey succeeded but the manifest write failed;
    /// the rekey was successfully ROLLED BACK to the
    /// old key. The DB is back to its pre-call state.
    /// Operator action: investigate the manifest write
    /// error (filesystem, permissions, disk full) +
    /// retry the migration tool.
    ManifestWriteFailed { reason: String },
    /// Rekey succeeded, manifest write failed, AND the
    /// rollback rekey ALSO failed. The DB is in an
    /// in-doubt state — neither the old nor the new
    /// key may open it cleanly. Operator escalation:
    /// restore from backup; do NOT retry the migration
    /// tool against this DB.
    ManifestWriteFailedAndRollbackFailed {
        manifest_reason: String,
        rollback_reason: String,
    },
}

impl std::fmt::Display for RekeyManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RekeyFailed { reason } => {
                write!(f, "rekey_swap_rekey_failed: {reason}")
            }
            Self::ManifestWriteFailed { reason } => write!(
                f,
                "rekey_swap_manifest_write_failed_rollback_succeeded: {reason}"
            ),
            Self::ManifestWriteFailedAndRollbackFailed {
                manifest_reason,
                rollback_reason,
            } => write!(
                f,
                "rekey_swap_manifest_write_failed_and_rollback_failed: \
                 manifest=({manifest_reason}) rollback=({rollback_reason})"
            ),
        }
    }
}

impl std::error::Error for RekeyManifestError {}

impl From<RekeyError> for RekeyManifestError {
    fn from(e: RekeyError) -> Self {
        Self::RekeyFailed {
            reason: format!("{e}"),
        }
    }
}

/// Production entry point — performs the rekey + atomic
/// manifest swap with rollback-on-manifest-fail.
///
/// **Caller contract:**
///   - `conn` is open under `current_hex` (caller has
///     issued `PRAGMA key`).
///   - `current_hex` and `new_hex` are 64 lower-hex
///     chars (use `format_sqlcipher_pragma_key_hex`).
///   - `manifest_path` is the canonical sidecar location
///     for the DB; future readers will look here.
///   - `new_manifest` carries the post-migration shape
///     (schema_version + last_updated_at_unix_secs).
///
/// **Effects:**
///   1. Issue `PRAGMA rekey = "x'<new_hex>'"` (Batch #1
///      kernel).
///   2. Atomic-write the new manifest via the SSoT
///      shared_io helper (Batch #338).
///   3. On manifest failure: rollback rekey to
///      `current_hex`. Report unified failure mode.
///
/// **Returns:** `Ok(())` iff both rekey + manifest
/// landed. Otherwise structured `RekeyManifestError`.
pub fn rekey_with_manifest_swap(
    conn: &Connection,
    manifest_path: PathBuf,
    current_hex: &str,
    new_hex: &str,
    new_manifest: DbKeySourceManifest,
) -> Result<(), RekeyManifestError> {
    rekey_with_manifest_swap_inner(conn, current_hex, new_hex, || {
        write_manifest(&manifest_path, &new_manifest).map_err(|e| format!("{e}"))
    })
}

/// Pure-orchestration kernel — takes a manifest-write
/// CLOSURE for dependency-injection so tests can
/// exercise the rollback path deterministically. The
/// production wrapper closes over the path + manifest
/// payload.
///
/// **Why a closure (not a generic trait):** the
/// orchestration only needs a single side-effecting
/// function call (`write the manifest`); a closure is
/// the lightest-weight DI shape that doesn't pull in a
/// trait surface. Tests pass `|| Err(...)` to exercise
/// the rollback path.
pub fn rekey_with_manifest_swap_inner<F>(
    conn: &Connection,
    current_hex: &str,
    new_hex: &str,
    write_manifest_fn: F,
) -> Result<(), RekeyManifestError>
where
    F: FnOnce() -> Result<(), String>,
{
    // Step 1: rekey to the NEW key. On failure the DB
    // is unchanged (PRAGMA rekey is atomic at the
    // page-cache level — failure means the rekey didn't
    // commit).
    pragma_rekey(conn, new_hex)?;

    // Step 2: write the manifest. Happy path → return.
    match write_manifest_fn() {
        Ok(()) => Ok(()),
        Err(manifest_reason) => {
            // Step 3: rollback the rekey. The DB is
            // currently keyed under new_hex; we need to
            // rekey BACK to current_hex.
            match pragma_rekey(conn, current_hex) {
                Ok(()) => Err(RekeyManifestError::ManifestWriteFailed {
                    reason: manifest_reason,
                }),
                Err(rollback_err) => {
                    Err(RekeyManifestError::ManifestWriteFailedAndRollbackFailed {
                        manifest_reason,
                        rollback_reason: format!("{rollback_err}"),
                    })
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_migration::schema_version::DbKeySchemaVersion;
    use crate::db_migration::v1_legacy_key::{
        derive_v1_legacy_key, format_sqlcipher_pragma_key_hex,
    };

    fn open_keyed_db_with_seed_data() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        String,
        String,
        Connection,
    ) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("rekey_swap_test.db");
        let v1_bytes = derive_v1_legacy_key(b"swap-test", b"v1-secret-key-32-bytes!");
        let v1_hex = format_sqlcipher_pragma_key_hex(&v1_bytes);
        let v2_bytes = derive_v1_legacy_key(b"swap-test-NEW", b"v2-secret-key-32-bytes!");
        let v2_hex = format_sqlcipher_pragma_key_hex(&v2_bytes);

        let conn = Connection::open(&db_path).expect("open");
        conn.execute_batch(&format!("PRAGMA key = \"x'{v1_hex}'\";"))
            .expect("apply v1 key");
        conn.execute_batch(
            "CREATE TABLE swap_test (id INTEGER PRIMARY KEY, val TEXT); \
             INSERT INTO swap_test (val) VALUES ('seeded');",
        )
        .expect("seed");
        (dir, db_path, v1_hex, v2_hex, conn)
    }

    /// Happy path: rekey succeeds + manifest write
    /// succeeds → Ok. The closure simulates a successful
    /// manifest write.
    #[test]
    fn swap_happy_path_returns_ok() {
        let (_dir, _db, v1_hex, v2_hex, conn) = open_keyed_db_with_seed_data();
        let result = rekey_with_manifest_swap_inner(&conn, &v1_hex, &v2_hex, || Ok(()));
        assert!(result.is_ok(), "happy path failed: {:?}", result);
    }

    /// Initial rekey fails (e.g., malformed new_hex) →
    /// RekeyFailed error class. DB unchanged (PRAGMA
    /// rekey atomicity at page-cache level).
    #[test]
    fn swap_rekey_failure_returns_rekey_failed_classification() {
        let (_dir, _db, v1_hex, _v2_hex, conn) = open_keyed_db_with_seed_data();
        let bad_hex = "bad-hex"; // length != 64 → HexFormat
        let result = rekey_with_manifest_swap_inner(&conn, &v1_hex, bad_hex, || Ok(()));
        match result {
            Err(RekeyManifestError::RekeyFailed { reason }) => {
                assert!(reason.contains("hex_format_invalid"));
            }
            other => panic!("expected RekeyFailed, got {:?}", other),
        }

        // DB still readable under v1 (rekey didn't take).
        let count: i64 = conn
            .query_row("SELECT count(*) FROM swap_test", [], |r| r.get(0))
            .expect("read still works");
        assert_eq!(count, 1);
    }

    /// Manifest write fails after successful rekey →
    /// rollback path exercises → ManifestWriteFailed
    /// classification + DB rolled back to v1.
    #[test]
    fn swap_manifest_failure_rolls_back_to_old_key() {
        let (dir, db_path, v1_hex, v2_hex, conn) = open_keyed_db_with_seed_data();

        // Closure simulates manifest write failure.
        let result = rekey_with_manifest_swap_inner(&conn, &v1_hex, &v2_hex, || {
            Err("simulated disk-full".to_string())
        });
        match &result {
            Err(RekeyManifestError::ManifestWriteFailed { reason }) => {
                assert!(reason.contains("simulated disk-full"));
            }
            other => panic!(
                "expected ManifestWriteFailed (rollback ok), got {:?}",
                other
            ),
        }

        // Drop the conn so disk state is committed.
        drop(conn);

        // Reopen with v1 — must succeed (rollback worked).
        let conn_v1 = Connection::open(&db_path).expect("reopen");
        conn_v1
            .execute_batch(&format!("PRAGMA key = \"x'{v1_hex}'\";"))
            .expect("apply v1 key");
        let count: i64 = conn_v1
            .query_row("SELECT count(*) FROM swap_test", [], |r| r.get(0))
            .expect("read after rollback");
        assert_eq!(
            count, 1,
            "rollback failed: DB should still be openable under v1"
        );

        // Reopen with v2 — must FAIL (rollback worked).
        let conn_v2 = Connection::open(&db_path).expect("reopen");
        conn_v2
            .execute_batch(&format!("PRAGMA key = \"x'{v2_hex}'\";"))
            .expect("parser allows; runtime fails on read");
        let v2_read: rusqlite::Result<i64> =
            conn_v2.query_row("SELECT count(*) FROM swap_test", [], |r| r.get(0));
        assert!(
            v2_read.is_err(),
            "v2 key should NOT open the DB after rollback"
        );

        drop(dir);
    }

    /// Display strings carry the canonical
    /// `rekey_swap_*` prefix family for log aggregator
    /// search.
    #[test]
    fn rekey_manifest_error_display_strings_pinned() {
        let cases: Vec<(RekeyManifestError, &str)> = vec![
            (
                RekeyManifestError::RekeyFailed { reason: "x".into() },
                "rekey_swap_rekey_failed",
            ),
            (
                RekeyManifestError::ManifestWriteFailed { reason: "y".into() },
                "rekey_swap_manifest_write_failed_rollback_succeeded",
            ),
            (
                RekeyManifestError::ManifestWriteFailedAndRollbackFailed {
                    manifest_reason: "m".into(),
                    rollback_reason: "r".into(),
                },
                "rekey_swap_manifest_write_failed_and_rollback_failed",
            ),
        ];
        for (err, expected_prefix) in cases {
            let s = format!("{err}");
            assert!(
                s.contains(expected_prefix),
                "missing canonical prefix `{expected_prefix}` in: {s}"
            );
        }
    }

    /// `From<RekeyError>` impl — caller `?`-propagation
    /// through pragma_rekey at the orchestration entry.
    #[test]
    fn from_rekey_error_classifies_as_rekey_failed() {
        let inner = RekeyError::HexFormat {
            reason: "test".to_string(),
        };
        let outer: RekeyManifestError = inner.into();
        assert!(matches!(outer, RekeyManifestError::RekeyFailed { .. }));
    }

    /// Production wrapper integration — uses the real
    /// `write_manifest` (Batch #338 atomic JSON sidecar
    /// helper). Verified via tempdir manifest path.
    #[test]
    fn production_wrapper_writes_manifest_on_happy_path() {
        let (_dir, _db, v1_hex, v2_hex, conn) = open_keyed_db_with_seed_data();
        let manifest_dir = tempfile::tempdir().expect("manifest dir");
        let manifest_path = manifest_dir.path().join("test.db.key-source.json");

        let new_manifest = DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: 1_700_000_777,
        };

        rekey_with_manifest_swap(&conn, manifest_path.clone(), &v1_hex, &v2_hex, new_manifest)
            .expect("happy-path swap");

        // Verify manifest file exists + contains v2.
        assert!(manifest_path.exists());
        let raw = std::fs::read_to_string(&manifest_path).expect("read");
        assert!(
            raw.contains("\"v2-keystore-derived\""),
            "manifest missing v2 schema_version: {raw}"
        );

        drop(manifest_dir);
    }

    #[test]
    fn rekey_manifest_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<RekeyManifestError>();
    }
}
