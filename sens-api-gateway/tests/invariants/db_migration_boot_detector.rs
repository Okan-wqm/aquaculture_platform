#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

//! D-3 SQLCipher boot-time v1 detector wire-status
//! invariants (Batch #330).
//!
//! ## Why this file
//!
//! Batch #330 lands the `detect_db_migration_backlog`
//! pure function + `DbMigrationBacklogReport` shape +
//! `log_structured_warn` emission. The architectural
//! contract is:
//!
//!   1. v1 manifest → backlog entry.
//!   2. v2 manifest → up_to_date_count++.
//!   3. Missing manifest → treated as legacy v1 default
//!      (the historical pre-D-3 state).
//!   4. Corrupt / envelope-mismatch / IO error →
//!      detection_failures (operator triage path).
//!   5. One DB's manifest corruption MUST NOT halt
//!      classification of others.
//!   6. Empty input → empty report (clean install).
//!
//! These invariants run as a standalone integration test
//! (no full-bin compile) using the same `#[path]`
//! support-directory pattern as Batch #329.

// Batch #338: manifest.rs delegates to
// `crate::shared_io::atomic_json_sidecar`. Stage the
// helper at the test crate root.
#[path = "db_migration_boot_detector_support/shared_io_mod.rs"]
mod shared_io;

#[path = "db_migration_boot_detector_support/mod.rs"]
mod db_migration;

use db_migration::boot_detector::{
    DbMigrationBacklogEntry, DbMigrationBacklogReport, detect_db_migration_backlog,
};
use db_migration::manifest::{DbKeySourceManifest, manifest_path_for_db, write_manifest};
use db_migration::schema_version::DbKeySchemaVersion;
use std::fs;
use std::path::PathBuf;

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// Create an empty DB file at the given path so the
/// detector's (db_exists, sidecar_exists) classification
/// (PR-195 Batch #5) treats this entry as "real DB
/// present". Tests that want the orphan-sidecar arm
/// (sidecar exists, DB missing) skip this helper.
fn touch_db(path: &std::path::Path) {
    fs::write(path, b"").expect("touch db file");
}

/// **D-3 boot-detector invariant 1:** empty input
/// produces an empty report (no panic, no false
/// positives). Pins the clean-install no-DB case.
#[test]
fn d3_boot_empty_input_returns_empty_report() {
    let report = detect_db_migration_backlog(&[]);
    assert!(!report.has_backlog());
    assert_eq!(report.backlog_count(), 0);
    assert_eq!(report.up_to_date_count, 0);
    assert_eq!(report.detection_failure_count(), 0);
}

/// **D-3 boot-detector invariant 2:** a v1 manifest is
/// classified into `backlog` with current=v1, target=v2,
/// timestamp preserved. Pins the manifest-derived
/// happy path.
#[test]
fn d3_boot_v1_manifest_classified_as_backlog_with_timestamp() {
    let dir = tempdir();
    let db = dir.path().join("offline_queue.db");
    touch_db(&db);
    write_manifest(
        &manifest_path_for_db(&db),
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V1MachineIdDerived,
            last_updated_at_unix_secs: 1_700_000_000,
        },
    )
    .expect("seed");

    let report = detect_db_migration_backlog(&[db.as_path()]);
    assert!(report.has_backlog());
    assert_eq!(report.backlog_count(), 1);

    let entry = &report.backlog[0];
    assert_eq!(entry.db_path, db);
    assert_eq!(
        entry.current_version,
        DbKeySchemaVersion::V1MachineIdDerived
    );
    assert_eq!(entry.target_version, DbKeySchemaVersion::V2KeystoreDerived);
    assert_eq!(entry.last_updated_at_unix_secs, Some(1_700_000_000));
}

/// **D-3 boot-detector invariant 3:** a v2 manifest is
/// counted as up-to-date — NOT in the backlog list.
/// Pins the no-false-positive guarantee for migrated DBs.
#[test]
fn d3_boot_v2_manifest_counted_up_to_date() {
    let dir = tempdir();
    let db = dir.path().join("license_cache.db");
    touch_db(&db);
    write_manifest(
        &manifest_path_for_db(&db),
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: 1_700_000_000,
        },
    )
    .expect("seed");

    let report = detect_db_migration_backlog(&[db.as_path()]);
    assert!(!report.has_backlog());
    assert_eq!(report.up_to_date_count, 1);
    assert_eq!(report.detection_failure_count(), 0);
}

/// **D-3 boot-detector invariant 4:** missing manifest
/// is treated as legacy v1 default with `None` timestamp
/// — the operator-visible signal that this DB has
/// never had a manifest. Pins the architectural choice
/// documented in the boot_detector.rs module-level doc.
#[test]
fn d3_boot_missing_manifest_treated_as_legacy_v1_with_none_timestamp() {
    let dir = tempdir();
    let db = dir.path().join("legacy.db");
    touch_db(&db); // DB present, no sidecar = legacy v1 default.
    // No manifest written — pre-D-3 historical state.

    let report = detect_db_migration_backlog(&[db.as_path()]);
    assert!(report.has_backlog());
    assert_eq!(report.backlog_count(), 1);

    let entry = &report.backlog[0];
    assert_eq!(
        entry.current_version,
        DbKeySchemaVersion::V1MachineIdDerived
    );
    // None timestamp distinguishes "no manifest existed"
    // from "manifest exists with v1 + a written timestamp".
    assert_eq!(entry.last_updated_at_unix_secs, None);
}

/// **D-3 boot-detector invariant 5:** corrupt manifest
/// routes to `detection_failures`, NOT `backlog`. The
/// migration tool can't safely rekey a DB whose manifest
/// is unreadable.
#[test]
fn d3_boot_corrupt_manifest_routed_to_detection_failures() {
    let dir = tempdir();
    let db = dir.path().join("broken.db");
    touch_db(&db);
    fs::write(manifest_path_for_db(&db), b"not valid JSON {").expect("seed");

    let report = detect_db_migration_backlog(&[db.as_path()]);
    assert!(!report.has_backlog());
    assert_eq!(report.detection_failure_count(), 1);
    assert!(
        report.detection_failures[0]
            .reason
            .contains("corrupt_manifest")
    );
}

/// **D-3 boot-detector invariant 6:** envelope-version
/// mismatch routes to `detection_failures` (forward-
/// incompat scenario where a newer agent wrote an
/// envelope version this older agent cannot parse).
#[test]
fn d3_boot_envelope_version_mismatch_routed_to_detection_failures() {
    let dir = tempdir();
    let db = dir.path().join("future.db");
    touch_db(&db);
    let bogus = r#"{"manifest_envelope_version": 999, "schema_version": "v2-keystore-derived", "last_updated_at_unix_secs": 1700000000}"#;
    fs::write(manifest_path_for_db(&db), bogus).expect("seed");

    let report = detect_db_migration_backlog(&[db.as_path()]);
    assert_eq!(report.detection_failure_count(), 1);
    assert!(
        report.detection_failures[0]
            .reason
            .contains("envelope_version_mismatch")
    );
}

/// **D-3 boot-detector invariant 7:** mixed input
/// (v1 + v2 + missing + corrupt) distributes into the
/// correct buckets. Pins the bookkeeping arithmetic
/// across all four populations.
#[test]
fn d3_boot_mixed_input_distributes_to_correct_buckets() {
    let dir = tempdir();

    // v1 manifest.
    let v1_db = dir.path().join("v1.db");
    touch_db(&v1_db);
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
    touch_db(&v2_db);
    write_manifest(
        &manifest_path_for_db(&v2_db),
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: 1_700_000_000,
        },
    )
    .expect("seed v2");

    // Missing manifest.
    let missing_db = dir.path().join("missing.db");
    touch_db(&missing_db);

    // Corrupt manifest.
    let corrupt_db = dir.path().join("corrupt.db");
    touch_db(&corrupt_db);
    fs::write(manifest_path_for_db(&corrupt_db), b"not valid JSON").expect("seed corrupt");

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

    // Backlog entries preserve input order.
    assert_eq!(report.backlog[0].db_path, v1_db);
    assert_eq!(report.backlog[1].db_path, missing_db);
}

/// **D-3 boot-detector invariant 8:** one DB's
/// corruption does NOT halt classification of other
/// DBs in the same scan. Pins the continue-on-error
/// semantic — a single rotted manifest must not block
/// the operator from seeing the rest of the fleet's
/// state.
#[test]
fn d3_boot_one_corrupt_does_not_halt_classification() {
    let dir = tempdir();

    let corrupt_db = dir.path().join("corrupt.db");
    touch_db(&corrupt_db);
    fs::write(manifest_path_for_db(&corrupt_db), b"junk").expect("seed");

    let v1_db = dir.path().join("v1.db");
    touch_db(&v1_db);
    write_manifest(
        &manifest_path_for_db(&v1_db),
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V1MachineIdDerived,
            last_updated_at_unix_secs: 1_500_000_000,
        },
    )
    .expect("seed v1");

    let report = detect_db_migration_backlog(&[corrupt_db.as_path(), v1_db.as_path()]);
    // Both populations are populated — the corrupt DB
    // didn't short-circuit the v1 classification.
    assert_eq!(report.backlog_count(), 1);
    assert_eq!(report.detection_failure_count(), 1);
}

/// **D-3 boot-detector invariant 9:** `log_structured_warn`
/// is idempotent — calling it twice does not panic or
/// mutate the report. Pins the no-side-effect-on-self
/// invariant so the boot-path can call it freely.
#[test]
fn d3_boot_log_structured_warn_is_idempotent() {
    let report = DbMigrationBacklogReport {
        backlog: vec![DbMigrationBacklogEntry {
            db_path: PathBuf::from("/tmp/example.db"),
            current_version: DbKeySchemaVersion::V1MachineIdDerived,
            target_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: Some(1_700_000_000),
        }],
        up_to_date_count: 0,
        detection_failures: vec![],
        nonexistent_dbs_count: 0,
    };
    report.log_structured_warn();
    report.log_structured_warn();
    assert_eq!(report.backlog_count(), 1);
}

/// **D-3 boot-detector invariant 10:** target_version
/// snapshotted on each entry equals
/// `DbKeySchemaVersion::current_target()` at detection
/// time. Pins the self-contained-report property — a
/// future v2→v3 bump won't retroactively re-label past
/// reports because each entry carries its own snapshot.
#[test]
fn d3_boot_target_version_is_snapshotted_per_entry() {
    let dir = tempdir();
    let db = dir.path().join("v1.db");
    touch_db(&db);
    write_manifest(
        &manifest_path_for_db(&db),
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V1MachineIdDerived,
            last_updated_at_unix_secs: 1_500_000_000,
        },
    )
    .expect("seed");

    let report = detect_db_migration_backlog(&[db.as_path()]);
    let entry = &report.backlog[0];
    assert_eq!(entry.target_version, DbKeySchemaVersion::current_target());
}
