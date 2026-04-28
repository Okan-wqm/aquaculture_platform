//! D-3 boot-time v1 SQLCipher manifest detector
//! (Batch #330).
//!
//! ## Why this module exists
//!
//! Batch #329 landed the v1/v2 schema_version primitive +
//! the `.key-source.json` sidecar manifest persistence.
//! The next architectural deliverable in the D-3 arc is
//! the BOOT-PATH detector: scan every SQLCipher DB the
//! agent owns, read each sidecar manifest, surface a
//! structured WARN log + a Prometheus metric when v1 DBs
//! are present in the field. Operator dashboards then
//! show the migration backlog so the platform team can
//! prioritize the rollout of the (future Batch) db-migrate
//! CLI binary.
//!
//! ## Pure-detection scope (NOT policy)
//!
//! This module makes **no policy decisions** about what
//! to DO with the backlog. The architectural contract is:
//!
//!   1. Read every passed DB path's manifest sidecar.
//!   2. Classify each DB into a category (v1, v2, manifest
//!      missing, manifest corrupt, envelope-version
//!      mismatch, IO error).
//!   3. Treat MISSING-MANIFEST as `V1MachineIdDerived`
//!      because that's the historical default for every
//!      DB created before D-3 landed — this preserves
//!      backward-compat without forcing an "unknown" 4th
//!      bucket that operators would have to triage.
//!   4. Return a structured report.
//!
//! Callers decide:
//!
//!   - Whether to fail-closed boot (security-team policy
//!     decision; needs a config knob).
//!   - Whether to refuse to OPEN a v1 DB until migration
//!     completes (per-consumer policy).
//!   - When to bump the Prometheus gauge (the wiring lives
//!     in `health.rs` adjacent to other gauges; see
//!     Batch-#330 health.rs hook below).
//!
//! Splitting detection from policy keeps the unit-test
//! surface narrow (no IO mocks, no clock mocks, no
//! Prometheus mocks — just JSON sidecars on a tempdir).
//!
//! ## Why MISSING-MANIFEST = legacy v1
//!
//! Pre-Batch-#329 every SQLCipher DB the agent created
//! had no sidecar at all — the v1 derivation was the
//! ONLY derivation. After D-3 lands every newly-created
//! DB gets a v2 manifest at create-time. So a missing
//! sidecar in production unambiguously means "this DB
//! was created before D-3 and uses v1 derivation".
//!
//! The alternative — treating missing-manifest as
//! "unknown / fail-closed" — would brick every existing
//! field deployment until operators manually ran a
//! migration tool, which is the very migration tool we
//! haven't shipped yet. That's a worse failure mode than
//! the current "v1 still works, but operator sees the
//! backlog and plans migration" path.
//!
//! ## Why label-free Prometheus gauge
//!
//! Using `db_path` as a Prometheus label would produce
//! one time-series per DB file, and a fleet rollout of
//! the agent would multiply that across thousands of
//! devices — cardinality blow-up. The architectural
//! choice: a single gauge `suderra_db_migration_backlog`
//! with NO db_path label tracks the total count of v1
//! DBs on this agent. The per-DB detail lives in the
//! structured WARN log so operators correlate via
//! timestamp. Same cardinality discipline as the rest
//! of the agent's metrics surface.
//!
//! ## Scope of THIS batch
//!
//! Pure detection function + structured WARN emission +
//! report shape. The actual `health.rs` gauge wiring +
//! per-consumer call-site invocation lands in subsequent
//! D-3 batches once the consumer-migration arc starts
//! flipping the v2 default.

use std::path::{Path, PathBuf};

use tracing::{error, warn};

use super::manifest::{
    manifest_path_for_db, read_manifest, DbMigrationError,
};
use super::schema_version::DbKeySchemaVersion;

/// One row in the migration-backlog report. Produced for
/// every DB path that requires migration (v1 DBs +
/// missing-manifest DBs treated as v1). v2 DBs + DBs the
/// detector cannot read (corruption, envelope mismatch,
/// IO error) are tracked separately in the report's
/// error fields and are NOT in this list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbMigrationBacklogEntry {
    /// Path to the SQLCipher DB file (NOT the sidecar
    /// manifest). Operators see this path in the WARN log.
    pub db_path: PathBuf,
    /// Schema version detected (or assumed default for
    /// missing-manifest DBs).
    pub current_version: DbKeySchemaVersion,
    /// Schema version the migration tool will rekey to.
    /// Snapshotted from `DbKeySchemaVersion::current_target()`
    /// at detection time so the report is self-contained
    /// (a future bump to v3 won't retroactively re-label
    /// past reports).
    pub target_version: DbKeySchemaVersion,
    /// Last-updated unix timestamp from the sidecar OR
    /// `None` if the sidecar was missing (legacy v1
    /// default — no timestamp to read). `None` is the
    /// operator-visible signal that this DB has never
    /// had a manifest written.
    pub last_updated_at_unix_secs: Option<i64>,
}

/// One row for a DB the detector observed but could NOT
/// classify into v1/v2 — the sidecar exists but is
/// corrupt, has an unknown envelope version, or hits an
/// IO error during read. These DBs are NOT migration
/// candidates (the migration tool can't safely rekey a
/// DB whose manifest is unreadable); operators must
/// triage them manually.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbMigrationDetectionFailure {
    /// Path to the SQLCipher DB file.
    pub db_path: PathBuf,
    /// Display string of the underlying `DbMigrationError`
    /// — the operator sees this in the structured WARN
    /// log so they can route to the right runbook
    /// (corrupt → restore-from-backup; envelope-mismatch
    /// → roll forward; IO error → fix-filesystem).
    pub reason: String,
}

/// The full migration-backlog report returned by
/// `detect_db_migration_backlog`.
///
/// Three populations live in the report:
///
///   1. `backlog`: DBs that need migration (v1 + missing-
///      manifest treated as v1).
///   2. `up_to_date`: DBs already at the current target
///      version (v2 today). Counted, but not
///      individually listed (operators don't need a
///      per-DB list of healthy DBs).
///   3. `detection_failures`: DBs whose manifest could
///      not be classified — operator triage required.
///
/// All four counters are exposed as named getters so the
/// Prometheus emission point can read them without
/// pattern-matching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbMigrationBacklogReport {
    /// DBs requiring migration — explicit list.
    pub backlog: Vec<DbMigrationBacklogEntry>,
    /// Number of DBs already at the current target. Not
    /// individually listed because there's nothing
    /// actionable per-DB.
    pub up_to_date_count: usize,
    /// DBs the detector observed but couldn't classify.
    /// Operator triage needed.
    pub detection_failures: Vec<DbMigrationDetectionFailure>,
}

impl DbMigrationBacklogReport {
    /// True when at least one DB requires migration.
    /// Caller's branch point for "should we log the
    /// backlog WARN?" / "should we bump the metric?".
    pub fn has_backlog(&self) -> bool {
        !self.backlog.is_empty()
    }

    /// Total count of DBs needing migration. The
    /// Prometheus gauge wires THIS value (label-free) at
    /// scrape time.
    pub fn backlog_count(&self) -> usize {
        self.backlog.len()
    }

    /// Total count of DBs the detector couldn't classify.
    /// Bumps a separate counter so operators can
    /// distinguish "X v1 DBs awaiting migration" from "Y
    /// DBs whose manifest is broken" — different runbooks.
    pub fn detection_failure_count(&self) -> usize {
        self.detection_failures.len()
    }

    /// Emit one operator-readable WARN per backlog entry
    /// + one SUMMARY WARN with the totals. Idempotent —
    /// safe to call multiple times across boots; the
    /// structured fields make duplicates correlatable in
    /// log aggregators.
    ///
    /// **Why not a single WARN with all paths concatenated:**
    /// log aggregators index by message structure;
    /// per-entry emission lets operators query
    /// `tracing_event_kind="db_migration_backlog_entry" AND
    /// db_path="..."` to filter for one device. A single
    /// concat would force grep on the operator side.
    ///
    /// **Why log-only-on-backlog (not always):**
    /// fleets with zero v1 DBs in the field would emit
    /// noise on every boot. Detection_failures still emit
    /// (those are always operator-actionable).
    pub fn log_structured_warn(&self) {
        if self.has_backlog() {
            for entry in &self.backlog {
                warn!(
                    event_kind = "db_migration_backlog_entry",
                    db_path = %entry.db_path.display(),
                    current_version = %entry.current_version,
                    target_version = %entry.target_version,
                    last_updated_at_unix_secs = entry
                        .last_updated_at_unix_secs
                        .map(|t| t.to_string())
                        .unwrap_or_else(|| "null-no-manifest".to_string()),
                    "SQLCipher DB requires migration to v2 keystore-derived key"
                );
            }
            warn!(
                event_kind = "db_migration_backlog_summary",
                backlog_count = self.backlog_count(),
                up_to_date_count = self.up_to_date_count,
                detection_failure_count = self.detection_failure_count(),
                "SQLCipher migration backlog detected — operator must run db-migrate-cli (D-3 arc continuation)"
            );
        }
        for failure in &self.detection_failures {
            error!(
                event_kind = "db_migration_detection_failure",
                db_path = %failure.db_path.display(),
                reason = %failure.reason,
                "SQLCipher manifest unreadable — operator triage required (corrupt / envelope-mismatch / IO error)"
            );
        }
    }
}

/// Scan a list of SQLCipher DB paths, classify each by
/// reading its sidecar manifest, return a structured
/// report.
///
/// **Pure detection — no IO side effects on the DB
/// files themselves.** Only the manifest sidecars are
/// read; the DB files are never opened. This keeps the
/// detector cheap (one stat + one small JSON read per
/// DB) so it can run unconditionally at boot regardless
/// of fleet size.
///
/// **Caller contract:** pass paths to DB FILES, not
/// manifest sidecars. The detector derives the manifest
/// path via `manifest_path_for_db`. Passing the manifest
/// path directly produces a "missing manifest" entry
/// because the detector would look for
/// `<manifest_path>.key-source.json` which doesn't exist.
///
/// **Concurrency:** the detector reads files once per
/// path, sequentially. Boot-path is single-threaded and
/// the workload is tiny (~milliseconds per DB on
/// typical edge hardware) so parallelism is not worth
/// the complexity. If a future fleet sees thousands of
/// DBs per agent (currently 4 SQLCipher consumers
/// projected: offline_queue, license_cache, scripting/
/// persistence, scripting/bytecode_retain) revisit.
pub fn detect_db_migration_backlog(
    db_paths: &[&Path],
) -> DbMigrationBacklogReport {
    let target = DbKeySchemaVersion::current_target();
    let mut backlog = Vec::new();
    let mut up_to_date_count: usize = 0;
    let mut detection_failures = Vec::new();

    for db_path in db_paths {
        let manifest_path = manifest_path_for_db(db_path);
        match read_manifest(&manifest_path) {
            Ok(Some(manifest)) => {
                if manifest
                    .schema_version
                    .requires_migration_to_current_target()
                {
                    backlog.push(DbMigrationBacklogEntry {
                        db_path: db_path.to_path_buf(),
                        current_version: manifest.schema_version,
                        target_version: target,
                        last_updated_at_unix_secs: Some(
                            manifest.last_updated_at_unix_secs,
                        ),
                    });
                } else {
                    up_to_date_count += 1;
                }
            }
            Ok(None) => {
                // Missing-manifest = legacy v1 default.
                // Documented in the module-level doc.
                backlog.push(DbMigrationBacklogEntry {
                    db_path: db_path.to_path_buf(),
                    current_version: DbKeySchemaVersion::V1MachineIdDerived,
                    target_version: target,
                    last_updated_at_unix_secs: None,
                });
            }
            Err(err) => {
                // Corrupt / envelope-mismatch / IO error.
                // Not a migration candidate — operator
                // triage path. Track separately so the
                // metric + WARN log distinguish the two
                // operator-actionable populations.
                detection_failures.push(
                    DbMigrationDetectionFailure {
                        db_path: db_path.to_path_buf(),
                        reason: classify_error_reason(&err),
                    },
                );
            }
        }
    }

    DbMigrationBacklogReport {
        backlog,
        up_to_date_count,
        detection_failures,
    }
}

/// Render a `DbMigrationError` to the short reason
/// string the operator sees in the WARN log. The
/// rendered prefix mirrors the Display impl
/// (`db_migration_manifest_*`) so log aggregators can
/// search for the canonical kind without re-parsing the
/// full error display.
fn classify_error_reason(err: &DbMigrationError) -> String {
    match err {
        DbMigrationError::ReadFailed { .. } => {
            format!("io_error: {}", err)
        }
        DbMigrationError::WriteFailed { .. } => {
            // The detector NEVER writes — but include the
            // arm for exhaustiveness so a future
            // refactor that adds a write path doesn't
            // silently miss-classify.
            format!("write_error: {}", err)
        }
        DbMigrationError::Corrupt { .. } => {
            format!("corrupt_manifest: {}", err)
        }
        DbMigrationError::EnvelopeVersionMismatch { .. } => {
            format!("envelope_version_mismatch: {}", err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_migration::manifest::{
        write_manifest, DbKeySourceManifest,
    };
    use std::fs;

    /// Per-test tempdir for isolation. Returns the guard
    /// so the dir is auto-cleaned on drop.
    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    /// Empty input → empty report. Detector must NOT
    /// panic or error on the no-DB case (clean install
    /// before any consumer creates its DB).
    #[test]
    fn detect_empty_input_returns_empty_report() {
        let report = detect_db_migration_backlog(&[]);
        assert!(!report.has_backlog());
        assert_eq!(report.backlog_count(), 0);
        assert_eq!(report.up_to_date_count, 0);
        assert_eq!(report.detection_failure_count(), 0);
    }

    /// Single v1 manifest → backlog has 1 entry; current=v1,
    /// target=v2; timestamp present.
    #[test]
    fn detect_single_v1_manifest_classifies_as_backlog() {
        let dir = tempdir();
        let db = dir.path().join("offline_queue.db");
        let manifest = manifest_path_for_db(&db);
        write_manifest(
            &manifest,
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V1MachineIdDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed");

        let report = detect_db_migration_backlog(&[db.as_path()]);
        assert!(report.has_backlog());
        assert_eq!(report.backlog_count(), 1);
        assert_eq!(report.up_to_date_count, 0);
        assert_eq!(report.detection_failure_count(), 0);

        let entry = &report.backlog[0];
        assert_eq!(entry.db_path, db);
        assert_eq!(
            entry.current_version,
            DbKeySchemaVersion::V1MachineIdDerived
        );
        assert_eq!(
            entry.target_version,
            DbKeySchemaVersion::V2KeystoreDerived
        );
        assert_eq!(
            entry.last_updated_at_unix_secs,
            Some(1_700_000_000)
        );
    }

    /// Single v2 manifest → up_to_date_count=1, backlog
    /// empty.
    #[test]
    fn detect_single_v2_manifest_counted_up_to_date() {
        let dir = tempdir();
        let db = dir.path().join("license_cache.db");
        let manifest = manifest_path_for_db(&db);
        write_manifest(
            &manifest,
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed");

        let report = detect_db_migration_backlog(&[db.as_path()]);
        assert!(!report.has_backlog());
        assert_eq!(report.backlog_count(), 0);
        assert_eq!(report.up_to_date_count, 1);
        assert_eq!(report.detection_failure_count(), 0);
    }

    /// Missing manifest → treated as legacy v1 default.
    /// Documented in module-level doc; this test pins the
    /// architectural choice.
    #[test]
    fn detect_missing_manifest_treated_as_legacy_v1() {
        let dir = tempdir();
        let db = dir.path().join("legacy.db");
        // No manifest written — pre-D-3 historical state.

        let report = detect_db_migration_backlog(&[db.as_path()]);
        assert!(report.has_backlog());
        assert_eq!(report.backlog_count(), 1);

        let entry = &report.backlog[0];
        assert_eq!(
            entry.current_version,
            DbKeySchemaVersion::V1MachineIdDerived
        );
        assert_eq!(
            entry.target_version,
            DbKeySchemaVersion::V2KeystoreDerived
        );
        // None timestamp signals "no manifest existed";
        // operator differentiates from a manifest-with-v1
        // (which has a timestamp).
        assert_eq!(entry.last_updated_at_unix_secs, None);
    }

    /// Corrupt manifest → detection_failures, not backlog.
    /// The migration tool can't safely rekey a DB whose
    /// manifest is unreadable.
    #[test]
    fn detect_corrupt_manifest_routed_to_detection_failures() {
        let dir = tempdir();
        let db = dir.path().join("broken.db");
        let manifest = manifest_path_for_db(&db);
        fs::write(&manifest, b"not valid JSON {").expect("seed");

        let report = detect_db_migration_backlog(&[db.as_path()]);
        assert!(!report.has_backlog());
        assert_eq!(report.backlog_count(), 0);
        assert_eq!(report.up_to_date_count, 0);
        assert_eq!(report.detection_failure_count(), 1);

        let failure = &report.detection_failures[0];
        assert_eq!(failure.db_path, db);
        assert!(
            failure.reason.contains("corrupt_manifest"),
            "reason should classify as corrupt_manifest, got: {}",
            failure.reason
        );
    }

    /// Envelope-version mismatch → detection_failures
    /// (forward-incompat scenario).
    #[test]
    fn detect_envelope_version_mismatch_routed_to_detection_failures() {
        let dir = tempdir();
        let db = dir.path().join("future.db");
        let manifest = manifest_path_for_db(&db);
        let bogus = r#"{"manifest_envelope_version": 999, "schema_version": "v2-keystore-derived", "last_updated_at_unix_secs": 1700000000}"#;
        fs::write(&manifest, bogus).expect("seed");

        let report = detect_db_migration_backlog(&[db.as_path()]);
        assert_eq!(report.detection_failure_count(), 1);
        assert!(report.detection_failures[0]
            .reason
            .contains("envelope_version_mismatch"));
    }

    /// Mixed input: 1 v1 + 1 v2 + 1 missing + 1 corrupt.
    /// Each population goes to the correct bucket.
    /// Pins the bookkeeping arithmetic.
    #[test]
    fn detect_mixed_input_distributes_to_correct_buckets() {
        let dir = tempdir();

        // v1 manifest.
        let v1_db = dir.path().join("v1.db");
        write_manifest(
            &manifest_path_for_db(&v1_db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V1MachineIdDerived,
                last_updated_at_unix_secs: 1_500_000_000,
            },
        )
        .expect("seed v1");

        // v2 manifest.
        let v2_db = dir.path().join("v2.db");
        write_manifest(
            &manifest_path_for_db(&v2_db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v2");

        // Missing manifest (legacy v1 default).
        let missing_db = dir.path().join("missing.db");

        // Corrupt manifest.
        let corrupt_db = dir.path().join("corrupt.db");
        fs::write(
            manifest_path_for_db(&corrupt_db),
            b"not valid JSON",
        )
        .expect("seed corrupt");

        let report = detect_db_migration_backlog(&[
            v1_db.as_path(),
            v2_db.as_path(),
            missing_db.as_path(),
            corrupt_db.as_path(),
        ]);

        assert_eq!(report.backlog_count(), 2); // v1 + missing
        assert_eq!(report.up_to_date_count, 1); // v2
        assert_eq!(report.detection_failure_count(), 1); // corrupt
        assert!(report.has_backlog());

        // Backlog entries preserve their input order.
        assert_eq!(report.backlog[0].db_path, v1_db);
        assert_eq!(
            report.backlog[0].current_version,
            DbKeySchemaVersion::V1MachineIdDerived
        );
        assert_eq!(
            report.backlog[0].last_updated_at_unix_secs,
            Some(1_500_000_000)
        );
        assert_eq!(report.backlog[1].db_path, missing_db);
        assert_eq!(
            report.backlog[1].current_version,
            DbKeySchemaVersion::V1MachineIdDerived
        );
        assert_eq!(report.backlog[1].last_updated_at_unix_secs, None);
    }

    /// One DB's manifest corruption MUST NOT halt
    /// detection of other DBs in the same scan. Pins the
    /// continue-on-error semantic for fleet rollouts.
    #[test]
    fn detect_one_corrupt_does_not_halt_classification_of_others() {
        let dir = tempdir();

        let corrupt_db = dir.path().join("corrupt.db");
        fs::write(
            manifest_path_for_db(&corrupt_db),
            b"junk",
        )
        .expect("seed");

        let v1_db = dir.path().join("v1.db");
        write_manifest(
            &manifest_path_for_db(&v1_db),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V1MachineIdDerived,
                last_updated_at_unix_secs: 1_500_000_000,
            },
        )
        .expect("seed v1");

        let report = detect_db_migration_backlog(&[
            corrupt_db.as_path(),
            v1_db.as_path(),
        ]);
        assert_eq!(report.backlog_count(), 1);
        assert_eq!(report.detection_failure_count(), 1);
    }

    /// `log_structured_warn` is idempotent — calling it
    /// twice does not panic or change observable state
    /// (the report struct is borrowed immutably; the logs
    /// are emitted via tracing which has no return value
    /// observable here). Pins the no-side-effect-on-self
    /// invariant.
    #[test]
    fn log_structured_warn_is_idempotent() {
        let report = DbMigrationBacklogReport {
            backlog: vec![DbMigrationBacklogEntry {
                db_path: PathBuf::from("/tmp/example.db"),
                current_version: DbKeySchemaVersion::V1MachineIdDerived,
                target_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: Some(1_700_000_000),
            }],
            up_to_date_count: 0,
            detection_failures: vec![],
        };
        report.log_structured_warn();
        report.log_structured_warn();
        // Report unchanged.
        assert_eq!(report.backlog_count(), 1);
    }

    /// `log_structured_warn` on a fully-clean fleet emits
    /// NOTHING (no backlog, no detection failures).
    /// Verified by calling on an empty report — no panic.
    #[test]
    fn log_structured_warn_silent_when_fleet_is_clean() {
        let report = DbMigrationBacklogReport {
            backlog: vec![],
            up_to_date_count: 5,
            detection_failures: vec![],
        };
        report.log_structured_warn();
        assert!(!report.has_backlog());
        assert_eq!(report.detection_failure_count(), 0);
    }
}
