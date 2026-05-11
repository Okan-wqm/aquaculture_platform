//! D-3 SQLCipher key-source manifest primitive smoke tests
//! (Batch #329 — standalone so the test binary is not the
//! full suderra-agent bin).
//!
//! ## Why a standalone test crate
//!
//! `sens-api-gateway` is a `[[bin]]`-only crate (the agent
//! is a single binary, not a multi-crate workspace; same
//! architectural choice that drove the Batch #327 fuzz
//! target's `#[path]` workaround). The full-bin test
//! compile OOMs on memory-constrained hosts. The D-3
//! primitive modules (`schema_version.rs` + `manifest.rs`)
//! have NO cross-module dependencies on suderra-agent
//! internals — they only use `serde`, `serde_json`,
//! `tracing`, `tempfile`, and `std::*`, all of which are
//! already in the integration-test dep graph. This file
//! `#[path]`-includes both modules + reproduces the
//! happy-path round-trip + corruption + version-mismatch
//! coverage from the inline `#[cfg(test)] mod tests {}`
//! blocks, so the architectural-correctness gate runs
//! WITHOUT requiring the full bin to recompile.
//!
//! ## What this file pins
//!
//!   1. Round-trip: write a manifest, read it back, every
//!      field matches.
//!   2. First-boot semantic: missing manifest returns
//!      `Ok(None)` (NOT an error).
//!   3. Corruption: invalid JSON returns Corrupt error.
//!   4. Envelope version mismatch: forward-incompat
//!      versions fail-closed.
//!   5. Suffix derivation: `manifest_path_for_db` appends
//!      the canonical `.key-source.json` suffix.
//!   6. Schema version variant lifecycle: V1 / V2 +
//!      kebab-case wire format pinned.
//!   7. Atomic write happy path: temp file is cleaned up
//!      after rename.
//!
//! ## What this file does NOT pin
//!
//! - The boot-time v1 detector (future D-3 batch — emits
//!   structured WARN log + Prometheus metric when a v1
//!   DB is observed).
//! - The migration binary (future D-3 batch —
//!   `db-migrate-cli` rekeys via `PRAGMA rekey`).
//! - The per-consumer migration (future D-3 batch —
//!   offline_queue + license_cache + scripting/persistence
//!   + scripting/bytecode_retain adopt v2 derivation).

// **Why a file-based mod (not inline):** rustc resolves
// child `#[path]` values relative to a synthetic
// directory `<parent>/<inline_mod_name>/`. Linux's path
// resolver requires every directory component along a
// relative path to physically exist before `..` traversal
// — so an inline `mod db_migration { ... }` would need a
// non-existent `tests/invariants/db_migration/` to be on
// disk before it can resolve `..` upward. Materializing
// the directory under a non-clashing name
// (`db_migration_primitive_support/`) and loading it
// file-based satisfies the resolver without colliding
// with the production `src/db_migration/`.
//
// Inside that support file the children use
// `#[path = "../../../src/db_migration/<file>.rs"]`
// (three `..` to escape
// `tests/invariants/db_migration_primitive_support/`
// up to the crate root).
// Batch #338: manifest.rs delegates to
// `crate::shared_io::atomic_json_sidecar`. Stage the
// `shared_io` mod tree so `crate::shared_io` resolves
// identically inside the integration test crate.
#[path = "db_migration_primitive_support/shared_io_mod.rs"]
mod shared_io;

#[path = "db_migration_primitive_support/mod.rs"]
mod db_migration;

use db_migration::manifest::{
    DB_KEY_SOURCE_MANIFEST_SUFFIX, DbKeySourceManifest, DbMigrationError, manifest_path_for_db,
    read_manifest, write_manifest,
};
use db_migration::schema_version::DbKeySchemaVersion;
use std::fs;
use std::path::PathBuf;

fn manifest_paths() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("offline_queue.db");
    let manifest_path = manifest_path_for_db(&db_path);
    (dir, db_path, manifest_path)
}

/// **D-3 primitive invariant 1:** the canonical suffix
/// `.key-source.json` MUST be appended by
/// `manifest_path_for_db`. Pinning the suffix locks the
/// filesystem layout consumers depend on.
#[test]
fn d3_manifest_suffix_is_canonical_kebab_case_json() {
    assert_eq!(DB_KEY_SOURCE_MANIFEST_SUFFIX, ".key-source.json");
    let db = PathBuf::from("/var/lib/suderra/offline_queue.db");
    let m = manifest_path_for_db(&db);
    assert_eq!(
        m,
        PathBuf::from("/var/lib/suderra/offline_queue.db.key-source.json")
    );
}

/// **D-3 primitive invariant 2:** the schema version enum
/// serializes to the documented kebab-case wire format.
/// Pinning the wire bytes prevents accidental refactor
/// that would brick existing on-disk manifests.
#[test]
fn d3_schema_version_serializes_to_kebab_case() {
    assert_eq!(
        serde_json::to_string(&DbKeySchemaVersion::V1MachineIdDerived).expect("ser"),
        "\"v1-machine-id-derived\""
    );
    assert_eq!(
        serde_json::to_string(&DbKeySchemaVersion::V2KeystoreDerived).expect("ser"),
        "\"v2-keystore-derived\""
    );
}

/// **D-3 primitive invariant 3:** unknown discriminators
/// fail-closed. A future v3 written by a newer agent
/// must NOT silently parse as v2 on an older reader.
#[test]
fn d3_schema_version_rejects_unknown_discriminator() {
    let r: Result<DbKeySchemaVersion, _> = serde_json::from_str("\"v99-future-format\"");
    assert!(r.is_err());
}

/// **D-3 primitive invariant 4:** `current_target` returns
/// V2 today. A future bump is a deliberate single-line
/// change visible in the diff.
#[test]
fn d3_current_target_is_v2_keystore_derived() {
    assert_eq!(
        DbKeySchemaVersion::current_target(),
        DbKeySchemaVersion::V2KeystoreDerived
    );
}

/// **D-3 primitive invariant 5:** `requires_migration`
/// fires for v1 (legacy) only. Boot-time detector relies
/// on this exact semantic.
#[test]
fn d3_requires_migration_predicate_fires_for_v1_only() {
    assert!(DbKeySchemaVersion::V1MachineIdDerived.requires_migration_to_current_target());
    assert!(!DbKeySchemaVersion::V2KeystoreDerived.requires_migration_to_current_target());
}

/// **D-3 primitive invariant 6:** write-then-read
/// round-trips every field. Pins the persistence
/// contract end-to-end.
#[test]
fn d3_write_then_read_round_trips_all_fields() {
    let (_dir, _db, manifest_path) = manifest_paths();
    let original = DbKeySourceManifest {
        schema_version: DbKeySchemaVersion::V2KeystoreDerived,
        last_updated_at_unix_secs: 1_700_000_000,
    };
    write_manifest(&manifest_path, &original).expect("write");
    let loaded = read_manifest(&manifest_path).expect("read").expect("Some");
    assert_eq!(loaded, original);
}

/// **D-3 primitive invariant 7:** missing manifest returns
/// `Ok(None)` so consumers can distinguish first-boot
/// from "manifest unreadable" (the latter fails closed).
#[test]
fn d3_read_missing_manifest_returns_ok_none() {
    let (_dir, _db, manifest_path) = manifest_paths();
    assert!(!manifest_path.exists());
    let result = read_manifest(&manifest_path).expect("Ok");
    assert!(result.is_none());
}

/// **D-3 primitive invariant 8:** corrupt JSON returns
/// Corrupt error. Migration consumer fails-closed on
/// Corrupt rather than guessing the key derivation
/// (wrong derivation bricks the DB).
#[test]
fn d3_read_corrupt_json_returns_structured_corrupt_error() {
    let (_dir, _db, manifest_path) = manifest_paths();
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(&manifest_path, b"not valid JSON {").expect("seed");
    let err = read_manifest(&manifest_path).expect_err("must error");
    match err {
        DbMigrationError::Corrupt { .. } => {}
        other => panic!("expected Corrupt, got {:?}", other),
    }
}

/// **D-3 primitive invariant 9:** envelope version
/// mismatch returns EnvelopeVersionMismatch. Forward-
/// incompat scenario where a newer agent wrote a shape
/// this older agent cannot parse — fail-closed.
#[test]
fn d3_unknown_envelope_version_rejected() {
    let (_dir, _db, manifest_path) = manifest_paths();
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    let bogus = r#"{"manifest_envelope_version": 999, "schema_version": "v2-keystore-derived", "last_updated_at_unix_secs": 1700000000}"#;
    fs::write(&manifest_path, bogus).expect("seed");
    let err = read_manifest(&manifest_path).expect_err("must error");
    match err {
        DbMigrationError::EnvelopeVersionMismatch {
            expected: 1,
            actual: 999,
            ..
        } => {}
        other => panic!("expected EnvelopeVersionMismatch, got {:?}", other),
    }
}

/// **D-3 primitive invariant 10:** atomic-write happy path
/// leaves NO `.tmp-*` leftover beside the target. The
/// rename's atomicity under crash is a kernel guarantee
/// documented in the `write_manifest` doc; this test pins
/// the happy-path no-leftover invariant.
#[test]
fn d3_write_leaves_no_temp_file_on_success() {
    let (_dir, _db, manifest_path) = manifest_paths();
    write_manifest(
        &manifest_path,
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: 1_700_000_777,
        },
    )
    .expect("write");
    assert!(manifest_path.exists());
    let parent = manifest_path.parent().unwrap();
    let leftover_tmps: Vec<_> = fs::read_dir(parent)
        .expect("readdir")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
        .collect();
    assert!(
        leftover_tmps.is_empty(),
        "leftover temps: {:?}",
        leftover_tmps
            .iter()
            .map(|e| e.file_name())
            .collect::<Vec<_>>()
    );
}

/// **D-3 primitive invariant 11:** rewrite REPLACES the
/// previous payload. After a v1→v2 migration the manifest
/// is rewritten with the new version + new timestamp;
/// the previous payload must NOT linger.
#[test]
fn d3_rewrite_replaces_previous_contents() {
    let (_dir, _db, manifest_path) = manifest_paths();
    write_manifest(
        &manifest_path,
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V1MachineIdDerived,
            last_updated_at_unix_secs: 1_500_000_000,
        },
    )
    .expect("write v1");
    write_manifest(
        &manifest_path,
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: 1_700_000_000,
        },
    )
    .expect("write v2");
    let loaded = read_manifest(&manifest_path).expect("read").expect("Some");
    assert_eq!(loaded.schema_version, DbKeySchemaVersion::V2KeystoreDerived);
    assert_eq!(loaded.last_updated_at_unix_secs, 1_700_000_000);
}

/// **D-3 primitive invariant 12:** raw JSON contains the
/// kebab-case wire string for the schema version field
/// — operator can `cat` the file + see the version
/// immediately. This protects the operator-ergonomics
/// contract.
#[test]
fn d3_raw_json_contains_kebab_case_wire_form() {
    let (_dir, _db, manifest_path) = manifest_paths();
    write_manifest(
        &manifest_path,
        &DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V1MachineIdDerived,
            last_updated_at_unix_secs: 1_700_000_500,
        },
    )
    .expect("write");
    let raw = fs::read_to_string(&manifest_path).expect("read");
    assert!(
        raw.contains("\"v1-machine-id-derived\""),
        "raw JSON missing kebab-case wire form, got:\n{}",
        raw
    );
}
