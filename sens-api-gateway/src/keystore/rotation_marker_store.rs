//! Rotation marker store (Batch #316 D-1b persistence).
//!
//! ## Why
//!
//! Batch #315 introduced `KeystoreRotationDeadline` —
//! the in-memory primitive that tracks "how many days
//! since the last keystore rotation, alarm if approaching
//! or past the 180-day cadence". For the alarm to be
//! meaningful across process restarts the
//! `last_rotation_at_unix_secs` MUST be persisted: a
//! deadline that resets to "now" on every reboot would
//! never fire (operators rebooting weekly would never
//! see an Overdue alarm regardless of the actual
//! rotation history).
//!
//! ## Architectural shape
//!
//! `RotationMarkerStore` owns one tiny JSON file under
//! `$SUDERRA_DATA_DIR/keystore_rotation_marker.json`:
//!
//! ```json
//! {
//!   "schema_version": 1,
//!   "last_rotation_at_unix_secs": 1700000000
//! }
//! ```
//!
//! Operations:
//!
//! - `read_or_init(path, clock)` — at boot. Returns the
//!   persisted deadline OR mints a fresh one anchored at
//!   the current trustworthy wallclock if the file is
//!   missing (first-boot path).
//! - `record_rotation_now(path, &mut deadline, clock)` —
//!   after a successful rotate_master_from_files. Updates
//!   the deadline AND atomically rewrites the marker
//!   file.
//!
//! Atomic write = temp file + rename. The rename is the
//! filesystem-level commit point: a crash mid-write
//! either leaves the OLD marker intact OR sees the NEW
//! marker complete; never a partial write.
//!
//! ## Why a separate module (not folded into rotation_deadline.rs)
//!
//! `rotation_deadline.rs` is the PURE-DOMAIN type: no
//! I/O, no FS dependency, fully unit-testable without
//! tempdirs. Persistence belongs in a SIDECAR module so
//! the type-test boundary stays narrow. Same architectural
//! pattern as the keystore::secret (pure types) +
//! keystore::file_backed (I/O + ctor) split from Batch
//! 4b/82.
//!
//! ## Why JSON (not bincode / SQLCipher)
//!
//! The marker is operator-readable: when an incident-
//! response engineer SSHs into a stuck device, they want
//! to `cat keystore_rotation_marker.json` and see a
//! plain timestamp. JSON wins on operator ergonomics +
//! schema evolvability (the `schema_version` field gates
//! future format extensions).
//!
//! The marker is NOT a secret: it carries a single
//! Unix-seconds integer with no key material. SQLCipher
//! would add a dependency cost without security gain.
//!
//! ## Scope of THIS batch
//!
//! Pure persistence module + tests. The
//! FileBackedKeystore integration (rotate_master_from_files
//! calls record_rotation_now; FileBackedKeystore::open
//! reads the marker at boot) lands in the D-1b arc
//! continuation toward UH ULTRA-MEDIUM-007 closure.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::rotation_deadline::{KeystoreRotationDeadline, RotationDeadlineError};
use crate::runtime_safety::clock::ClockAuthority;
use crate::shared_io::atomic_json_sidecar::{AtomicJsonWriteError, write_atomic_json};

/// Canonical filename inside `$SUDERRA_DATA_DIR`.
pub const ROTATION_MARKER_FILENAME: &str = "keystore_rotation_marker.json";

/// Schema version of the JSON marker. Bumping this
/// requires a coordinated migration; current readers
/// reject unknown versions to fail-closed against
/// forward-incompatible changes.
const ROTATION_MARKER_SCHEMA_VERSION: u32 = 1;

/// Errors specific to the marker store. Distinct from
/// `RotationDeadlineError` so I/O faults don't leak
/// into the pure-domain error class.
#[derive(Debug)]
pub enum MarkerStoreError {
    /// Read failed (file exists but unreadable: permission
    /// denied, disk error). Operator must fix the
    /// filesystem-level problem; the agent boots
    /// fail-closed.
    ReadFailed { path: PathBuf, reason: String },
    /// Write failed during atomic-rename sequence. Caller
    /// MUST treat the rotation as not-recorded so a
    /// subsequent boot still alarms on the OLD deadline
    /// (no false-fresh state).
    WriteFailed { path: PathBuf, reason: String },
    /// JSON deserialize failed — file is corrupt or
    /// hand-edited to invalid shape. Caller decides
    /// recovery: regenerate from current clock OR halt
    /// (regenerate is the default — losing one rotation
    /// signal is preferable to halting on a corrupted
    /// marker).
    Corrupt { path: PathBuf, reason: String },
    /// schema_version field in the file does not match
    /// the reader's expected version. Forward-incompat
    /// scenario.
    SchemaVersionMismatch {
        path: PathBuf,
        expected: u32,
        actual: u32,
    },
    /// Underlying rotation_deadline ctor rejected the
    /// loaded values (e.g., LeadTimeExceedsPeriod if
    /// operator hand-edited config).
    Deadline(RotationDeadlineError),
}

impl std::fmt::Display for MarkerStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReadFailed { path, reason } => write!(
                f,
                "marker_store_read_failed: {}: {}",
                path.display(),
                reason
            ),
            Self::WriteFailed { path, reason } => write!(
                f,
                "marker_store_write_failed: {}: {}",
                path.display(),
                reason
            ),
            Self::Corrupt { path, reason } => {
                write!(f, "marker_store_corrupt: {}: {}", path.display(), reason)
            }
            Self::SchemaVersionMismatch {
                path,
                expected,
                actual,
            } => write!(
                f,
                "marker_store_schema_version_mismatch: {}: expected={} actual={}",
                path.display(),
                expected,
                actual
            ),
            Self::Deadline(e) => {
                write!(f, "marker_store_deadline_error: {}", e)
            }
        }
    }
}

impl std::error::Error for MarkerStoreError {}

impl From<RotationDeadlineError> for MarkerStoreError {
    fn from(e: RotationDeadlineError) -> Self {
        Self::Deadline(e)
    }
}

/// Map the shared atomic-JSON-sidecar helper's error
/// taxonomy into this consumer's domain error
/// (Batch #338 — closes audit MEDIUM-004 finding).
impl From<AtomicJsonWriteError> for MarkerStoreError {
    fn from(e: AtomicJsonWriteError) -> Self {
        let path = match &e {
            AtomicJsonWriteError::ParentCreate { path, .. } => path.clone(),
            AtomicJsonWriteError::Serialize { path, .. } => path.clone(),
            AtomicJsonWriteError::TempIo { temp_path, .. } => temp_path.clone(),
            AtomicJsonWriteError::Rename { path, .. } => path.clone(),
            AtomicJsonWriteError::ParentFsync { parent, .. } => parent.clone(),
        };
        Self::WriteFailed {
            path,
            reason: format!("{e}"),
        }
    }
}

/// Wire-shape of the JSON file. Versioned so future
/// schema extensions can land without breaking older
/// readers (they reject with SchemaVersionMismatch +
/// operator runs the migration tool).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct MarkerFileSchemaV1 {
    schema_version: u32,
    last_rotation_at_unix_secs: i64,
}

/// Read the persisted marker at `path`. Returns the
/// reconstructed `KeystoreRotationDeadline` on success,
/// or a structured error for the caller to route.
///
/// **First-boot semantic:** the caller decides what to
/// do when the file does NOT exist. This function returns
/// `Ok(None)` for the not-found case so the caller
/// (`read_or_init`) can mint a fresh deadline. Other I/O
/// errors propagate as `Err(ReadFailed)`.
pub fn read_marker(path: &Path) -> Result<Option<KeystoreRotationDeadline>, MarkerStoreError> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(e) => {
            return Err(MarkerStoreError::ReadFailed {
                path: path.to_path_buf(),
                reason: e.to_string(),
            });
        }
    };

    let parsed: MarkerFileSchemaV1 =
        serde_json::from_slice(&bytes).map_err(|e| MarkerStoreError::Corrupt {
            path: path.to_path_buf(),
            reason: format!("json parse: {}", e),
        })?;

    if parsed.schema_version != ROTATION_MARKER_SCHEMA_VERSION {
        return Err(MarkerStoreError::SchemaVersionMismatch {
            path: path.to_path_buf(),
            expected: ROTATION_MARKER_SCHEMA_VERSION,
            actual: parsed.schema_version,
        });
    }

    let deadline = KeystoreRotationDeadline::new_with_defaults(parsed.last_rotation_at_unix_secs)?;
    Ok(Some(deadline))
}

/// Atomic write: serialize the deadline to JSON + hand
/// off to the shared atomic-JSON-sidecar helper for the
/// full 6-step crash-safe dance (Batch #338 — closes
/// audit MEDIUM-004).
///
/// Failure semantics: caller MUST treat WriteFailed as
/// "rotation not recorded" — the in-memory deadline
/// should NOT be advanced if the persistence failed,
/// otherwise a subsequent boot reads the OLD marker +
/// the alarm misses the rotation.
///
/// **Why delegate (Batch #338):** the 6-step dance is
/// shared with `db_migration::manifest::write_manifest`.
/// Both previously implemented steps 1-5 inline +
/// omitted step 6 (parent-directory fsync — required for
/// full POSIX rename durability under power loss).
/// Extracting the SSoT helper at
/// `crate::shared_io::atomic_json_sidecar` removes the
/// duplication + adds step 6 to BOTH consumers in one
/// place. The helper's `AtomicJsonWriteError` is mapped
/// into `MarkerStoreError::WriteFailed` via the `From`
/// impl above so consumer-side log prefixes stay
/// canonical.
pub fn write_marker(
    path: &Path,
    deadline: &KeystoreRotationDeadline,
) -> Result<(), MarkerStoreError> {
    let payload = MarkerFileSchemaV1 {
        schema_version: ROTATION_MARKER_SCHEMA_VERSION,
        last_rotation_at_unix_secs: deadline.last_rotation_at_unix_secs(),
    };

    write_atomic_json(path, &payload)?;

    info!(
        "Keystore rotation marker written: {} (last_rotation={})",
        path.display(),
        deadline.last_rotation_at_unix_secs(),
    );
    Ok(())
}

/// Boot-path entry: read the persisted marker; if absent,
/// mint a fresh deadline anchored at the current
/// trustworthy wallclock + persist it. Returns the
/// runtime-ready `KeystoreRotationDeadline`.
///
/// Used by the future FileBackedKeystore::open consumer
/// (D-1b arc continuation): on first boot the file
/// doesn't exist; on subsequent boots the file is read.
///
/// **Why the closure injection (`init_deadline_factory`):**
/// the caller may want to pass a custom rotation period
/// or alarm lead time (operator config). The factory
/// closure receives the freshly-read trustworthy
/// wallclock + returns the constructed deadline. This
/// keeps the marker-store module decoupled from the
/// rotation-period config knob.
pub async fn read_or_init<F>(
    path: &Path,
    clock: &dyn ClockAuthority,
    init_deadline_factory: F,
) -> Result<KeystoreRotationDeadline, MarkerStoreError>
where
    F: FnOnce(i64) -> Result<KeystoreRotationDeadline, RotationDeadlineError>,
{
    if let Some(deadline) = read_marker(path)? {
        info!(
            "Keystore rotation marker loaded from {}: last_rotation={}",
            path.display(),
            deadline.last_rotation_at_unix_secs(),
        );
        return Ok(deadline);
    }

    // First-boot path: no marker exists; mint a fresh
    // deadline using the current trustworthy wallclock.
    let now_reading = clock
        .trustworthy_wall_clock()
        .await
        .map_err(|e| MarkerStoreError::Deadline(RotationDeadlineError::Clock(e)))?;
    let now_unix_secs = now_reading
        .system_time
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| {
            MarkerStoreError::Deadline(RotationDeadlineError::Clock(
                crate::runtime_safety::clock::ClockError::PreEpochWallClock,
            ))
        })?
        .as_secs() as i64;

    let deadline = init_deadline_factory(now_unix_secs)?;
    write_marker(path, &deadline)?;
    info!(
        "Keystore rotation marker initialized at first boot: last_rotation={} ({})",
        deadline.last_rotation_at_unix_secs(),
        path.display(),
    );
    Ok(deadline)
}

/// Update the deadline to the current trustworthy
/// wallclock AND persist atomically. Called by the
/// future FileBackedKeystore::rotate_master_from_files
/// after a successful rotation. If the persistence
/// fails, the in-memory deadline is NOT advanced (caller
/// receives the structured error and decides how to
/// route).
pub async fn record_rotation_now(
    path: &Path,
    deadline: &mut KeystoreRotationDeadline,
    clock: &dyn ClockAuthority,
) -> Result<(), MarkerStoreError> {
    deadline.record_rotation_now(clock).await?;
    write_marker(path, deadline)?;
    info!(
        "Keystore rotation recorded: marker updated at {}",
        path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_safety::SystemClockAuthority;

    /// Per-test tempdir + marker path. Returns the TempDir
    /// guard so the caller holds it for the lifetime of
    /// the test (drop = auto-cleanup of the directory).
    fn marker_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(ROTATION_MARKER_FILENAME);
        (dir, path)
    }

    /// Round-trip: write a known deadline, read it back,
    /// fields match.
    #[tokio::test]
    async fn write_then_read_round_trips_last_rotation_timestamp() {
        let (_dir, path) = marker_path();
        let deadline = KeystoreRotationDeadline::new_with_defaults(1_700_000_000).expect("ctor");
        write_marker(&path, &deadline).expect("write");

        let loaded = read_marker(&path).expect("read").expect("Some");
        assert_eq!(loaded.last_rotation_at_unix_secs(), 1_700_000_000);
        assert_eq!(loaded.rotation_period(), deadline.rotation_period());
        assert_eq!(loaded.alarm_lead_time(), deadline.alarm_lead_time());
    }

    /// Read on a non-existent file returns Ok(None) —
    /// caller's first-boot signal. NOT an error.
    #[test]
    fn read_marker_missing_file_returns_ok_none() {
        let (_dir, path) = marker_path();
        assert!(!path.exists());
        let result = read_marker(&path).expect("Ok");
        assert!(result.is_none());
    }

    /// Corrupt JSON returns Corrupt error with file path
    /// + parse-error reason for operator diagnostics.
    #[test]
    fn read_marker_corrupt_json_returns_structured_error() {
        let (_dir, path) = marker_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not valid JSON {").expect("seed");
        let err = read_marker(&path).expect_err("must error");
        match err {
            MarkerStoreError::Corrupt { path: p, reason } => {
                assert_eq!(p, path);
                assert!(reason.contains("json parse"));
            }
            other => panic!("expected Corrupt, got {:?}", other),
        }
    }

    /// schema_version=999 returns SchemaVersionMismatch
    /// (forward-incompat scenario).
    #[test]
    fn read_marker_unknown_schema_version_rejected() {
        let (_dir, path) = marker_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bogus = r#"{"schema_version": 999, "last_rotation_at_unix_secs": 1700000000}"#;
        fs::write(&path, bogus).expect("seed");
        let err = read_marker(&path).expect_err("must error");
        match err {
            MarkerStoreError::SchemaVersionMismatch {
                expected, actual, ..
            } => {
                assert_eq!(expected, ROTATION_MARKER_SCHEMA_VERSION);
                assert_eq!(actual, 999);
            }
            other => panic!("expected SchemaVersionMismatch, got {:?}", other),
        }
    }

    /// Atomic write semantic: write succeeds; the file
    /// contents on disk match the serialized payload.
    /// (We don't simulate a crash mid-write because the
    /// rename's atomicity is a kernel guarantee — the
    /// architectural property is documented in the
    /// `write_marker` doc; this test pins that the
    /// HAPPY PATH leaves the file with the right bytes.)
    #[test]
    fn write_marker_persists_expected_json_shape() {
        let (_dir, path) = marker_path();
        let deadline = KeystoreRotationDeadline::new_with_defaults(1_700_000_500).expect("ctor");
        write_marker(&path, &deadline).expect("write");

        let bytes = fs::read(&path).expect("read");
        let parsed: MarkerFileSchemaV1 = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.last_rotation_at_unix_secs, 1_700_000_500);
    }

    /// `read_or_init` on a fresh path mints a new
    /// deadline + persists it; the file then exists.
    #[tokio::test]
    async fn read_or_init_initializes_on_first_boot() {
        let (_dir, path) = marker_path();
        assert!(!path.exists());
        let clock = SystemClockAuthority::new();
        let deadline = read_or_init(&path, &clock, |now| {
            KeystoreRotationDeadline::new_with_defaults(now)
        })
        .await
        .expect("init");

        // File now exists.
        assert!(path.exists());

        // Round-trip via raw read.
        let loaded = read_marker(&path).expect("read").expect("Some");
        assert_eq!(
            loaded.last_rotation_at_unix_secs(),
            deadline.last_rotation_at_unix_secs()
        );
    }

    /// `read_or_init` on an existing marker returns the
    /// PERSISTED deadline (does not overwrite with the
    /// current clock).
    #[tokio::test]
    async fn read_or_init_returns_existing_marker_unchanged() {
        let (_dir, path) = marker_path();
        let original = KeystoreRotationDeadline::new_with_defaults(1_500_000_000).expect("ctor");
        write_marker(&path, &original).expect("seed");

        let clock = SystemClockAuthority::new();
        let loaded = read_or_init(&path, &clock, |_| {
            panic!("init factory MUST NOT be called when marker exists")
        })
        .await
        .expect("read");

        assert_eq!(loaded.last_rotation_at_unix_secs(), 1_500_000_000);
    }

    /// `record_rotation_now` advances the deadline AND
    /// persists. Re-reading the marker shows the new
    /// timestamp.
    #[tokio::test]
    async fn record_rotation_now_advances_and_persists() {
        let (_dir, path) = marker_path();
        let mut deadline =
            KeystoreRotationDeadline::new_with_defaults(1_500_000_000).expect("ctor");
        write_marker(&path, &deadline).expect("seed");

        let clock = SystemClockAuthority::new();
        record_rotation_now(&path, &mut deadline, &clock)
            .await
            .expect("record");

        // In-memory advanced past the seed value.
        assert!(
            deadline.last_rotation_at_unix_secs() > 1_500_000_000,
            "in-memory deadline must advance past 2017 seed"
        );

        // Persisted shows the new value.
        let loaded = read_marker(&path).expect("read").expect("Some");
        assert_eq!(
            loaded.last_rotation_at_unix_secs(),
            deadline.last_rotation_at_unix_secs()
        );
    }

    /// MarkerStoreError Display strings pinned for
    /// audit-stable emission.
    #[test]
    fn marker_store_error_display_strings_pinned() {
        let path = PathBuf::from("/x/y");
        assert!(
            format!(
                "{}",
                MarkerStoreError::ReadFailed {
                    path: path.clone(),
                    reason: "perm".into()
                }
            )
            .contains("marker_store_read_failed")
        );
        assert!(
            format!(
                "{}",
                MarkerStoreError::WriteFailed {
                    path: path.clone(),
                    reason: "disk".into()
                }
            )
            .contains("marker_store_write_failed")
        );
        assert!(
            format!(
                "{}",
                MarkerStoreError::Corrupt {
                    path: path.clone(),
                    reason: "json".into()
                }
            )
            .contains("marker_store_corrupt")
        );
        assert!(
            format!(
                "{}",
                MarkerStoreError::SchemaVersionMismatch {
                    path,
                    expected: 1,
                    actual: 999
                }
            )
            .contains("schema_version_mismatch")
        );
    }

    #[test]
    fn marker_store_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<MarkerStoreError>();
    }
}
