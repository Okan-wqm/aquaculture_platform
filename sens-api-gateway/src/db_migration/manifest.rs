//! `DbKeySourceManifest` sidecar JSON + atomic write/read
//! (Batch #329 D-3 primitive-first).
//!
//! ## Why a sidecar manifest (not a DB column)
//!
//! A `schema_version` column inside the SQLCipher DB
//! itself would create a chicken-and-egg problem at boot:
//! the agent needs to know which key to derive BEFORE it
//! can open the DB to read the column. The sidecar JSON
//! lives next to the DB file (e.g., `offline_queue.db` +
//! `offline_queue.db.key-source.json`) so the agent reads
//! the manifest pre-open + selects the correct key
//! derivation path.
//!
//! ## Why atomic temp+rename (not direct write)
//!
//! Mirrors Batch #316 RotationMarkerStore. The manifest
//! is the only source of truth for which key derivation
//! works for a given DB. A torn write that leaves the
//! manifest pointing to the WRONG schema version would
//! brick the DB permanently — the agent would derive the
//! wrong key + every subsequent open would fail with
//! `database is encrypted or is not a database`. Atomic
//! rename ensures either the OLD manifest stays intact
//! OR the NEW manifest is fully written; never a partial.
//!
//! ## Why JSON (not bincode / SQLCipher / TOML)
//!
//! Operator-readable: incident-response engineers can
//! `cat offline_queue.db.key-source.json` over SSH and
//! immediately see the schema version + last-migration
//! timestamp. No secret material is in the manifest, so
//! SQLCipher would add dependency cost without security
//! gain. JSON over TOML because we already use serde-JSON
//! for the keystore_rotation_marker.json sidecar — keeping
//! ONE JSON convention across all sidecar manifests
//! reduces operator cognitive load.
//!
//! ## Filename convention
//!
//! `<db_path>.key-source.json` — i.e., the manifest sits
//! next to the DB with a stable suffix. Examples:
//!
//! - `/var/lib/suderra/offline_queue.db` →
//!   `/var/lib/suderra/offline_queue.db.key-source.json`
//! - `/var/lib/suderra/license_cache.db` →
//!   `/var/lib/suderra/license_cache.db.key-source.json`
//!
//! The suffix is exported as
//! [`DB_KEY_SOURCE_MANIFEST_SUFFIX`] so consumers don't
//! hard-code it. A central constant means a future rename
//! (e.g., to `.key-manifest.json`) is a single-line
//! change.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::info;

use super::schema_version::DbKeySchemaVersion;
use crate::shared_io::atomic_json_sidecar::{
    write_atomic_json, AtomicJsonWriteError,
};

/// Suffix appended to the SQLCipher DB filename to form
/// the manifest sidecar path. Every consumer derives the
/// manifest path via this constant rather than hard-coding
/// the literal — a future rename ripples through the
/// codebase via the constant.
pub const DB_KEY_SOURCE_MANIFEST_SUFFIX: &str = ".key-source.json";

/// Manifest schema version of the JSON wire format
/// itself. This is DIFFERENT from
/// `DbKeySchemaVersion`: the latter describes the key
/// derivation algorithm; the former describes the JSON
/// envelope shape. Bumping the JSON envelope is a
/// coordinated migration; current readers reject unknown
/// envelope versions to fail-closed.
const MANIFEST_ENVELOPE_VERSION: u32 = 1;

/// Sanity floor for `last_updated_at_unix_secs` field.
/// Equals `2017-07-14 02:40:00 UTC` (Unix 1_500_000_000).
/// Manifests with timestamps before this floor are
/// suspicious — the agent's first release predates this
/// date by several years; any timestamp earlier than
/// this almost certainly indicates a corrupt or
/// hand-edited manifest (e.g., `last_updated_at_unix_secs:
/// -1` or a 1970 epoch zero).
///
/// **Why a floor (Batch #339 — closes audit MEDIUM-005):**
/// the original `i64` field accepts negative timestamps
/// silently. Operator log aggregators may treat negative
/// epoch as "never" or as a 1969 date — misleading
/// either way. Rejecting at parse time with a structured
/// `Corrupt` error gives the operator a precise signal
/// (the runbook §1 corrupt-manifest path) instead of a
/// confusing "manifest from 1969" entry in the migration
/// backlog log.
///
/// **Why this specific value:** mid-2017 is well before
/// the agent's first deployment (the keystore ADR-018
/// rotation marker references late-2024 onwards). Using
/// a floor that's a few years pre-deployment leaves
/// headroom for time-skew + clock-rollback scenarios
/// without degrading the corruption signal.
const TIMESTAMP_SANITY_FLOOR_UNIX_SECS: i64 = 1_500_000_000;

/// Errors specific to the manifest store. Distinct from
/// keystore / clock errors so I/O faults stay typed at
/// the caller boundary.
#[derive(Debug)]
pub enum DbMigrationError {
    /// Read failed (file exists but unreadable: permission
    /// denied, disk error). Operator must fix the
    /// filesystem-level problem; the agent boots
    /// fail-closed (refuses to open the DB).
    ReadFailed { path: PathBuf, reason: String },
    /// Write failed during atomic-rename sequence. Caller
    /// MUST treat the manifest as not-updated so the
    /// previous schema version is still authoritative —
    /// no false-fresh state.
    WriteFailed { path: PathBuf, reason: String },
    /// JSON deserialize failed — file is corrupt or
    /// hand-edited to invalid shape. Caller fails-closed:
    /// refuses to open the DB rather than guess the key
    /// derivation. (Unlike the rotation marker, where
    /// regenerating loses one signal but is recoverable,
    /// guessing the SQLCipher key derivation is NOT
    /// recoverable — wrong derivation bricks the DB.)
    Corrupt { path: PathBuf, reason: String },
    /// Envelope `manifest_envelope_version` field in the
    /// file does not match the reader's expected version.
    /// Forward-incompat scenario: a newer agent wrote a
    /// shape this older agent cannot parse. Fail-closed.
    EnvelopeVersionMismatch {
        path: PathBuf,
        expected: u32,
        actual: u32,
    },
}

impl std::fmt::Display for DbMigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadFailed { path, reason } => write!(
                f,
                "db_migration_manifest_read_failed: {}: {}",
                path.display(),
                reason
            ),
            Self::WriteFailed { path, reason } => write!(
                f,
                "db_migration_manifest_write_failed: {}: {}",
                path.display(),
                reason
            ),
            Self::Corrupt { path, reason } => write!(
                f,
                "db_migration_manifest_corrupt: {}: {}",
                path.display(),
                reason
            ),
            Self::EnvelopeVersionMismatch {
                path,
                expected,
                actual,
            } => write!(
                f,
                "db_migration_manifest_envelope_version_mismatch: {}: expected={} actual={}",
                path.display(),
                expected,
                actual
            ),
        }
    }
}

impl std::error::Error for DbMigrationError {}

/// Map the shared atomic-JSON-sidecar helper's error
/// taxonomy into this consumer's domain error. All five
/// helper-side variants collapse into our single
/// `WriteFailed { path, reason }` variant — operators
/// see the canonical `db_migration_manifest_write_failed`
/// prefix + the helper-side reason for diagnostic
/// drill-down (Batch #338).
impl From<AtomicJsonWriteError> for DbMigrationError {
    fn from(e: AtomicJsonWriteError) -> Self {
        // Pull the path + the helper-Display reason. The
        // helper's Display already includes a canonical
        // prefix; we keep it in the reason so the
        // operator log carries BOTH our consumer-side
        // prefix and the helper-side prefix for precise
        // diagnostic routing.
        let path = match &e {
            AtomicJsonWriteError::ParentCreate { path, .. } => path.clone(),
            AtomicJsonWriteError::Serialize { path, .. } => path.clone(),
            AtomicJsonWriteError::TempIo { temp_path, .. } => {
                temp_path.clone()
            }
            AtomicJsonWriteError::Rename { path, .. } => path.clone(),
            AtomicJsonWriteError::ParentFsync { parent, .. } => {
                parent.clone()
            }
        };
        Self::WriteFailed {
            path,
            reason: format!("{e}"),
        }
    }
}

/// Public manifest shape returned to consumers. Carries
/// the schema version + the unix timestamp the manifest
/// was last written. The timestamp is operator-visible
/// (when did this DB get migrated?) but is NOT used as a
/// security primitive — it's metadata for incident-
/// response logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbKeySourceManifest {
    /// Which key derivation algorithm produced the key
    /// currently in use for this DB. Boot-time consumer
    /// matches on this to dispatch to the correct
    /// derivation function.
    pub schema_version: DbKeySchemaVersion,
    /// Unix-seconds when this manifest was last written.
    /// Set by `write_manifest` to `now_unix_secs`. For
    /// freshly-created DBs this equals the DB-creation
    /// time; for migrated DBs this equals the migration
    /// completion time.
    pub last_updated_at_unix_secs: i64,
}

/// Internal wire shape — separated from the public
/// `DbKeySourceManifest` so the JSON envelope version
/// field is not part of the public API. Public consumers
/// see only the schema_version + last-updated timestamp;
/// the envelope version is a serialization detail.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestFileSchemaV1 {
    /// Envelope version of the JSON wire format. MUST
    /// equal `MANIFEST_ENVELOPE_VERSION` at read time.
    manifest_envelope_version: u32,
    /// Which key derivation is in effect. Wire form is
    /// the kebab-case discriminator from
    /// `DbKeySchemaVersion`.
    schema_version: DbKeySchemaVersion,
    /// When the manifest was last written (unix seconds).
    last_updated_at_unix_secs: i64,
}

/// Compute the manifest sidecar path for a given DB path.
///
/// Single-source-of-truth helper so consumers don't
/// re-derive the suffix logic at every callsite. Future
/// suffix rename (e.g., `.key-source.json` →
/// `.key-manifest.json`) is a one-line change inside the
/// suffix constant.
pub fn manifest_path_for_db(db_path: &Path) -> PathBuf {
    let mut buf = db_path.as_os_str().to_os_string();
    buf.push(DB_KEY_SOURCE_MANIFEST_SUFFIX);
    PathBuf::from(buf)
}

/// Read the manifest sidecar at `path`. Returns the
/// reconstructed `DbKeySourceManifest` on success, or a
/// structured error.
///
/// **First-boot semantic:** the caller decides what to
/// do when the file does NOT exist. This function returns
/// `Ok(None)` for the not-found case so the consumer can
/// treat it as "no migration history yet" (e.g., a
/// freshly-installed agent with no DB yet). Other I/O
/// errors propagate as `Err(ReadFailed)` so the boot path
/// can fail-closed.
pub fn read_manifest(
    path: &Path,
) -> Result<Option<DbKeySourceManifest>, DbMigrationError> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(e) => {
            return Err(DbMigrationError::ReadFailed {
                path: path.to_path_buf(),
                reason: e.to_string(),
            });
        }
    };

    let parsed: ManifestFileSchemaV1 = serde_json::from_slice(&bytes)
        .map_err(|e| DbMigrationError::Corrupt {
            path: path.to_path_buf(),
            reason: format!("json parse: {}", e),
        })?;

    if parsed.manifest_envelope_version != MANIFEST_ENVELOPE_VERSION {
        return Err(DbMigrationError::EnvelopeVersionMismatch {
            path: path.to_path_buf(),
            expected: MANIFEST_ENVELOPE_VERSION,
            actual: parsed.manifest_envelope_version,
        });
    }

    // Batch #339 — closes audit MEDIUM-005. Reject
    // timestamps earlier than the sanity floor as
    // Corrupt. See `TIMESTAMP_SANITY_FLOOR_UNIX_SECS`
    // doc for the rationale + the chosen floor value.
    if parsed.last_updated_at_unix_secs < TIMESTAMP_SANITY_FLOOR_UNIX_SECS
    {
        return Err(DbMigrationError::Corrupt {
            path: path.to_path_buf(),
            reason: format!(
                "last_updated_at_unix_secs={} predates sanity floor \
                 {} (mid-2017) — corrupt or hand-edited manifest",
                parsed.last_updated_at_unix_secs,
                TIMESTAMP_SANITY_FLOOR_UNIX_SECS,
            ),
        });
    }

    Ok(Some(DbKeySourceManifest {
        schema_version: parsed.schema_version,
        last_updated_at_unix_secs: parsed.last_updated_at_unix_secs,
    }))
}

/// Atomic write: serialize the manifest to JSON, hand
/// off to the shared atomic-JSON-sidecar helper for the
/// full 6-step crash-safe dance (temp + fsync + rename +
/// parent-dir fsync).
///
/// **Failure semantic:** caller MUST treat WriteFailed as
/// "manifest not updated" — the calling migration logic
/// should NOT advance any in-memory state if the
/// persistence failed, otherwise a subsequent boot reads
/// the OLD manifest + the DB-key derivation goes out of
/// sync with what the migration thought it persisted.
///
/// **Why delegate (Batch #338 — closes audit MEDIUM-004):**
/// the 6-step dance is shared with
/// `keystore::rotation_marker_store::write_marker`. Both
/// previously implemented steps 1-5 inline + omitted step
/// 6 (parent-dir fsync). Extracting the SSoT helper
/// removes the duplication + fixes both consumers in one
/// place. The helper's `AtomicJsonWriteError` is mapped
/// into our `DbMigrationError::WriteFailed` via the
/// `From` impl above so consumer-side log prefixes stay
/// canonical.
pub fn write_manifest(
    path: &Path,
    manifest: &DbKeySourceManifest,
) -> Result<(), DbMigrationError> {
    let payload = ManifestFileSchemaV1 {
        manifest_envelope_version: MANIFEST_ENVELOPE_VERSION,
        schema_version: manifest.schema_version,
        last_updated_at_unix_secs: manifest.last_updated_at_unix_secs,
    };

    write_atomic_json(path, &payload)?;

    info!(
        "DB key-source manifest written: {} (schema_version={} last_updated={})",
        path.display(),
        manifest.schema_version,
        manifest.last_updated_at_unix_secs,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Per-test tempdir + DB path + manifest path. Returns
    /// the TempDir guard so the caller holds it for the
    /// lifetime of the test (drop = auto-cleanup).
    fn manifest_paths() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("offline_queue.db");
        let manifest_path = manifest_path_for_db(&db_path);
        (dir, db_path, manifest_path)
    }

    /// `manifest_path_for_db` appends the canonical
    /// suffix exactly. Pins the suffix-derivation contract
    /// against accidental refactors.
    #[test]
    fn manifest_path_appends_canonical_suffix() {
        let db = PathBuf::from("/var/lib/suderra/offline_queue.db");
        let manifest = manifest_path_for_db(&db);
        assert_eq!(
            manifest,
            PathBuf::from(
                "/var/lib/suderra/offline_queue.db.key-source.json"
            )
        );
    }

    /// `manifest_path_for_db` works for paths without
    /// extensions too (some consumers may use plain
    /// filenames).
    #[test]
    fn manifest_path_handles_extensionless_db_name() {
        let db = PathBuf::from("/tmp/some-db");
        let manifest = manifest_path_for_db(&db);
        assert_eq!(
            manifest,
            PathBuf::from("/tmp/some-db.key-source.json")
        );
    }

    /// Round-trip: write a known manifest, read it back,
    /// every field matches.
    #[test]
    fn write_then_read_round_trips_all_fields() {
        let (_dir, _db, manifest_path) = manifest_paths();
        let original = DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: 1_700_000_000,
        };
        write_manifest(&manifest_path, &original).expect("write");

        let loaded = read_manifest(&manifest_path)
            .expect("read")
            .expect("Some");
        assert_eq!(loaded, original);
    }

    /// Read on a non-existent file returns Ok(None) —
    /// caller's first-boot signal. NOT an error. This
    /// lets the consumer distinguish "no manifest yet"
    /// from "manifest unreadable" (the latter is
    /// fail-closed).
    #[test]
    fn read_manifest_missing_file_returns_ok_none() {
        let (_dir, _db, manifest_path) = manifest_paths();
        assert!(!manifest_path.exists());
        let result = read_manifest(&manifest_path).expect("Ok");
        assert!(result.is_none());
    }

    /// Corrupt JSON returns Corrupt error with the file
    /// path + parse-error reason for operator diagnostics.
    /// The migration consumer fails-closed on Corrupt
    /// rather than guessing the key derivation.
    #[test]
    fn read_manifest_corrupt_json_returns_structured_error() {
        let (_dir, _db, manifest_path) = manifest_paths();
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        fs::write(&manifest_path, b"not valid JSON {").expect("seed");
        let err =
            read_manifest(&manifest_path).expect_err("must error");
        match err {
            DbMigrationError::Corrupt { path, reason } => {
                assert_eq!(path, manifest_path);
                assert!(
                    reason.contains("json parse"),
                    "reason should mention json parse, got: {}",
                    reason
                );
            }
            other => panic!("expected Corrupt, got {:?}", other),
        }
    }

    /// Envelope version mismatch returns
    /// EnvelopeVersionMismatch — the forward-incompat
    /// scenario where a newer agent wrote a shape this
    /// older agent cannot parse. Fail-closed.
    #[test]
    fn read_manifest_unknown_envelope_version_rejected() {
        let (_dir, _db, manifest_path) = manifest_paths();
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        let bogus = r#"{"manifest_envelope_version": 999, "schema_version": "v2-keystore-derived", "last_updated_at_unix_secs": 1700000000}"#;
        fs::write(&manifest_path, bogus).expect("seed");
        let err =
            read_manifest(&manifest_path).expect_err("must error");
        match err {
            DbMigrationError::EnvelopeVersionMismatch {
                expected,
                actual,
                ..
            } => {
                assert_eq!(expected, MANIFEST_ENVELOPE_VERSION);
                assert_eq!(actual, 999);
            }
            other => panic!(
                "expected EnvelopeVersionMismatch, got {:?}",
                other
            ),
        }
    }

    /// Unknown schema_version discriminator inside a
    /// well-formed envelope returns Corrupt (the
    /// `DbKeySchemaVersion` deserializer rejects unknown
    /// kebab-case strings; the failure surfaces here as a
    /// JSON parse error).
    #[test]
    fn read_manifest_unknown_schema_version_rejected() {
        let (_dir, _db, manifest_path) = manifest_paths();
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        let bogus = r#"{"manifest_envelope_version": 1, "schema_version": "v99-future-format", "last_updated_at_unix_secs": 1700000000}"#;
        fs::write(&manifest_path, bogus).expect("seed");
        let err =
            read_manifest(&manifest_path).expect_err("must error");
        match err {
            DbMigrationError::Corrupt { .. } => {}
            other => panic!(
                "expected Corrupt for unknown schema_version, got {:?}",
                other
            ),
        }
    }

    /// `write_manifest` persists the documented JSON
    /// envelope shape — pinning the wire format against
    /// accidental field rename or reorder refactors.
    #[test]
    fn write_manifest_persists_expected_json_shape() {
        let (_dir, _db, manifest_path) = manifest_paths();
        let manifest = DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V1MachineIdDerived,
            last_updated_at_unix_secs: 1_700_000_500,
        };
        write_manifest(&manifest_path, &manifest).expect("write");

        let bytes = fs::read(&manifest_path).expect("read");
        let parsed: ManifestFileSchemaV1 =
            serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(parsed.manifest_envelope_version, 1);
        assert_eq!(
            parsed.schema_version,
            DbKeySchemaVersion::V1MachineIdDerived
        );
        assert_eq!(parsed.last_updated_at_unix_secs, 1_700_000_500);

        // Also check the raw JSON contains the kebab-case
        // wire string for schema_version (operator
        // ergonomics: cat the file + see the version
        // immediately).
        let raw = String::from_utf8(bytes).expect("utf8");
        assert!(
            raw.contains("\"v1-machine-id-derived\""),
            "raw JSON should contain kebab-case wire form, got:\n{}",
            raw
        );
    }

    /// Atomic-write happy path: after `write_manifest` the
    /// target file exists + the temp file does NOT.
    /// (The rename's atomicity under crash is a kernel
    /// guarantee documented in the `write_manifest` doc;
    /// this test pins the happy-path leftover-file
    /// invariant.)
    #[test]
    fn write_manifest_leaves_no_temp_file_on_success() {
        let (_dir, _db, manifest_path) = manifest_paths();
        let manifest = DbKeySourceManifest {
            schema_version: DbKeySchemaVersion::V2KeystoreDerived,
            last_updated_at_unix_secs: 1_700_000_777,
        };
        write_manifest(&manifest_path, &manifest).expect("write");

        // Target exists.
        assert!(manifest_path.exists(), "manifest must exist post-write");

        // No `.<filename>.tmp-*` left behind in the parent
        // directory.
        let parent = manifest_path.parent().unwrap();
        let leftover_tmps: Vec<_> = fs::read_dir(parent)
            .expect("readdir")
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(".tmp-")
            })
            .collect();
        assert!(
            leftover_tmps.is_empty(),
            "expected no leftover temp files, found: {:?}",
            leftover_tmps
                .iter()
                .map(|e| e.file_name())
                .collect::<Vec<_>>()
        );
    }

    /// Re-write semantic: a second `write_manifest`
    /// REPLACES the previous payload (e.g., after a v1→v2
    /// migration the manifest is rewritten with the new
    /// version + new timestamp).
    #[test]
    fn write_manifest_replaces_previous_contents() {
        let (_dir, _db, manifest_path) = manifest_paths();

        // Write v1 first.
        write_manifest(
            &manifest_path,
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V1MachineIdDerived,
                last_updated_at_unix_secs: 1_500_000_000,
            },
        )
        .expect("write v1");

        // Migration completes; rewrite as v2 with new
        // timestamp.
        write_manifest(
            &manifest_path,
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("write v2");

        let loaded = read_manifest(&manifest_path)
            .expect("read")
            .expect("Some");
        assert_eq!(
            loaded.schema_version,
            DbKeySchemaVersion::V2KeystoreDerived
        );
        assert_eq!(loaded.last_updated_at_unix_secs, 1_700_000_000);
    }

    /// `DbMigrationError` Display strings pinned for
    /// audit-stable emission (operator log lines + log
    /// ingest pipelines depend on these prefixes).
    #[test]
    fn db_migration_error_display_strings_pinned() {
        let path = PathBuf::from("/x/y");
        assert!(format!(
            "{}",
            DbMigrationError::ReadFailed {
                path: path.clone(),
                reason: "perm".into()
            }
        )
        .contains("db_migration_manifest_read_failed"));
        assert!(format!(
            "{}",
            DbMigrationError::WriteFailed {
                path: path.clone(),
                reason: "disk".into()
            }
        )
        .contains("db_migration_manifest_write_failed"));
        assert!(format!(
            "{}",
            DbMigrationError::Corrupt {
                path: path.clone(),
                reason: "json".into()
            }
        )
        .contains("db_migration_manifest_corrupt"));
        assert!(format!(
            "{}",
            DbMigrationError::EnvelopeVersionMismatch {
                path,
                expected: 1,
                actual: 999
            }
        )
        .contains("envelope_version_mismatch"));
    }

    /// `DbMigrationError` implements `std::error::Error`
    /// so consumers can box it through the standard
    /// error-trait pipelines.
    #[test]
    fn db_migration_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<DbMigrationError>();
    }

    /// Timestamp floor: a manifest with
    /// `last_updated_at_unix_secs = -1` parses cleanly
    /// at the JSON layer but MUST be rejected by the
    /// reader as Corrupt (Batch #339 — closes audit
    /// MEDIUM-005). Pinning this catches a
    /// hand-edited / corrupt manifest at the manifest
    /// boundary instead of letting it flow into
    /// downstream WARN logs as a 1969-epoch entry.
    #[test]
    fn read_manifest_negative_timestamp_rejected_as_corrupt() {
        let (_dir, _db, manifest_path) = manifest_paths();
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        let bogus = r#"{"manifest_envelope_version": 1, "schema_version": "v2-keystore-derived", "last_updated_at_unix_secs": -1}"#;
        fs::write(&manifest_path, bogus).expect("seed");
        let err =
            read_manifest(&manifest_path).expect_err("must error");
        match err {
            DbMigrationError::Corrupt { reason, .. } => {
                assert!(
                    reason.contains("predates sanity floor"),
                    "expected sanity-floor reason, got: {reason}"
                );
            }
            other => panic!(
                "expected Corrupt for negative timestamp, got {:?}",
                other
            ),
        }
    }

    /// Timestamp at the floor (mid-2017) is rejected
    /// because the floor is INCLUSIVE-of-floor =
    /// rejected ("less than" check). Pinning this gives
    /// a precise boundary signal — adjustments to the
    /// floor value land as a deliberate single-line
    /// change here.
    #[test]
    fn read_manifest_pre_floor_timestamp_rejected() {
        let (_dir, _db, manifest_path) = manifest_paths();
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        // 1_499_999_999 = floor minus 1 second.
        let bogus = r#"{"manifest_envelope_version": 1, "schema_version": "v2-keystore-derived", "last_updated_at_unix_secs": 1499999999}"#;
        fs::write(&manifest_path, bogus).expect("seed");
        let err =
            read_manifest(&manifest_path).expect_err("must error");
        assert!(matches!(err, DbMigrationError::Corrupt { .. }));
    }

    /// Timestamp exactly at the floor is ACCEPTED — the
    /// check is strictly less-than. Pinning this gives
    /// the precise boundary semantic.
    #[test]
    fn read_manifest_at_floor_timestamp_accepted() {
        let (_dir, _db, manifest_path) = manifest_paths();
        write_manifest(
            &manifest_path,
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs:
                    TIMESTAMP_SANITY_FLOOR_UNIX_SECS,
            },
        )
        .expect("seed");
        let loaded = read_manifest(&manifest_path)
            .expect("read")
            .expect("Some");
        assert_eq!(
            loaded.last_updated_at_unix_secs,
            TIMESTAMP_SANITY_FLOOR_UNIX_SECS
        );
    }
}
