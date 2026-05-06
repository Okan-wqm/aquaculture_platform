//! Atomic JSON sidecar write with full POSIX crash
//! safety (Batch #338 — closes audit MEDIUM-004 finding).
//!
//! ## The architectural property
//!
//! For a sidecar JSON file at `<path>` with content `T`,
//! a call to `write_atomic_json(<path>, &T)` MUST leave
//! the filesystem in EXACTLY one of two observable
//! states under a power-loss event at any point during
//! execution:
//!
//!   - **State A (pre-write):** the OLD file at `<path>`
//!     is intact. If `<path>` did not exist before the
//!     call, no file at `<path>`.
//!   - **State B (post-commit):** the NEW file at
//!     `<path>` contains the fully-written, fsync'd
//!     JSON payload.
//!
//! The intermediate states (zero-byte file, half-written
//! JSON, temp file present but rename incomplete) MUST
//! NOT be observable on disk after a crash + reboot.
//!
//! ## The 6-step dance
//!
//!   1. Ensure parent directory exists (first-boot path).
//!   2. Serialize `T` to JSON via serde.
//!   3. Open a temp file in the SAME directory as the
//!      target (cross-fs rename returns EXDEV; same-fs
//!      rename is atomic per POSIX).
//!   4. Write the JSON bytes + `fsync` the temp file
//!      (data + metadata durable; without this a power
//!      loss between rename + disk flush could leave a
//!      zero-byte file with a successful rename name).
//!   5. Rename temp over target. Atomic on the directory
//!      inode per POSIX.
//!   6. **fsync the PARENT DIRECTORY** so the rename's
//!      directory entry is durable. Without this a power
//!      loss between rename + the directory's journal
//!      flush can leave the directory entry pointing
//!      nowhere on ext4 with `data=writeback` mount
//!      option.
//!
//! Pre-Batch-#338 both `keystore::rotation_marker_store::
//! write_marker` (Batch #316) and `db_migration::manifest::
//! write_manifest` (Batch #329) implemented steps 1-5 but
//! omitted step 6 — surfaced by the audit follow-up after
//! Batch #335.
//!
//! ## Why a shared helper (not duplicated inline)
//!
//! Adding step 6 inline at both consumer sites would be
//! duplication-as-patch (banned by CLAUDE.md). The
//! correct architectural shape is a shared SSoT helper.
//! Both consumers retain their domain-specific envelope
//! handling (schema_version field, version constants,
//! domain-shaped error taxonomy); only the FS dance
//! moves.
//!
//! ## Why generic over `T: Serialize`
//!
//! Both consumers serialize different shapes (manifest
//! envelope vs rotation marker envelope) but the FS dance
//! is identical regardless of the JSON shape. Generic
//! over `T: Serialize` lets each consumer plug in its own
//! envelope struct + the helper computes bytes via
//! `serde_json::to_vec_pretty`. The pretty form is
//! preserved (operator-readable JSON) — both pre-existing
//! consumers used `to_vec_pretty`; the helper preserves
//! the convention.
//!
//! ## Why a custom error type (not `std::io::Error`
//! propagation)
//!
//! Each consumer's domain error type has its own
//! `WriteFailed { path: PathBuf, reason: String }`
//! variant. The helper returns a structured
//! `AtomicJsonWriteError` carrying the path + the reason
//! string; consumers map it into their domain error via
//! a one-line `From` impl. This keeps the helper free of
//! consumer-specific dependencies + lets each consumer's
//! Display string keep its canonical operator-search
//! prefix.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Error produced by `write_atomic_json`. Distinct from
/// any consumer-specific error type — consumers map it
/// via `From` into their own taxonomy.
#[derive(Debug)]
pub enum AtomicJsonWriteError {
    /// Failed to create parent directory (first-boot
    /// path where `$SUDERRA_DATA_DIR` was just created or
    /// a deep subdirectory).
    ParentCreate { path: PathBuf, reason: String },
    /// JSON serialization failed (caller-supplied `T`
    /// produced an `Err` from `serde_json::to_vec_pretty`
    /// — typically because `T`'s serde impl failed).
    Serialize { path: PathBuf, reason: String },
    /// Temp file open / write / fsync failed. Caller MUST
    /// treat this as "target file unchanged" — neither
    /// the OLD nor the NEW content is on disk at `<path>`
    /// after this error.
    TempIo { temp_path: PathBuf, reason: String },
    /// Rename of temp to target failed. The OLD target
    /// (if any) is intact; best-effort cleanup of the
    /// temp file has been attempted.
    Rename { path: PathBuf, reason: String },
    /// Parent-directory fsync failed. The NEW target IS
    /// on disk + the rename succeeded, but durability of
    /// the directory entry under power loss is NOT
    /// guaranteed. Caller should treat this as a
    /// soft-failure: the next reboot MAY observe the new
    /// file, OR it MAY observe the old file. This error
    /// is rare in practice (parent dir is open + valid)
    /// but distinct from earlier errors so the diagnostic
    /// is precise.
    ParentFsync { parent: PathBuf, reason: String },
}

impl std::fmt::Display for AtomicJsonWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ParentCreate { path, reason } => write!(
                f,
                "atomic_json_parent_create_failed: {}: {}",
                path.display(),
                reason
            ),
            Self::Serialize { path, reason } => write!(
                f,
                "atomic_json_serialize_failed: {}: {}",
                path.display(),
                reason
            ),
            Self::TempIo { temp_path, reason } => write!(
                f,
                "atomic_json_temp_io_failed: {}: {}",
                temp_path.display(),
                reason
            ),
            Self::Rename { path, reason } => write!(
                f,
                "atomic_json_rename_failed: {}: {}",
                path.display(),
                reason
            ),
            Self::ParentFsync { parent, reason } => write!(
                f,
                "atomic_json_parent_fsync_failed: {}: {}",
                parent.display(),
                reason
            ),
        }
    }
}

impl std::error::Error for AtomicJsonWriteError {}

/// Write `payload` as JSON to `path` with full POSIX
/// crash safety. See module-level doc for the 6-step
/// dance.
///
/// **Panics:** never. All failure modes return a
/// structured error.
///
/// **Concurrency:** caller-side serialization required.
/// Two concurrent invocations on the same `path` race on
/// the rename — POSIX guarantees one wins atomically,
/// but the loser's bytes are silently discarded. This is
/// the consumer's problem (both pre-existing consumers
/// hold per-instance state to prevent concurrent writes).
pub fn write_atomic_json<T: Serialize>(
    path: &Path,
    payload: &T,
) -> Result<(), AtomicJsonWriteError> {
    // Step 1: ensure parent directory exists.
    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent).map_err(|e| AtomicJsonWriteError::ParentCreate {
        path: path.to_path_buf(),
        reason: format!("create_dir_all: {e}"),
    })?;

    // Step 2: serialize.
    let bytes =
        serde_json::to_vec_pretty(payload).map_err(|e| AtomicJsonWriteError::Serialize {
            path: path.to_path_buf(),
            reason: format!("json serialize: {e}"),
        })?;

    // Step 3+4: temp file in the SAME directory; write +
    // fsync.
    //
    // Temp filename is `.<original>.tmp-<pid>` to avoid
    // collisions when a previous invocation crashed
    // mid-write — the new write overwrites stale temp.
    let temp_path = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("atomic_json_sidecar"),
        std::process::id()
    ));
    let _ = fs::remove_file(&temp_path);

    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp_path)
            .map_err(|e| AtomicJsonWriteError::TempIo {
                temp_path: temp_path.clone(),
                reason: format!("open temp: {e}"),
            })?;
        f.write_all(&bytes)
            .map_err(|e| AtomicJsonWriteError::TempIo {
                temp_path: temp_path.clone(),
                reason: format!("write_all: {e}"),
            })?;
        f.sync_all().map_err(|e| AtomicJsonWriteError::TempIo {
            temp_path: temp_path.clone(),
            reason: format!("fsync: {e}"),
        })?;
        // f drops here, releasing the file descriptor
        // before the rename below takes the temp path.
    }

    // Step 5: atomic rename.
    fs::rename(&temp_path, path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        AtomicJsonWriteError::Rename {
            path: path.to_path_buf(),
            reason: format!("rename: {e}"),
        }
    })?;

    // Step 6 (the missing step pre-Batch-#338): fsync the
    // parent directory so the rename's directory entry
    // is durable. The 6-step dance is now complete.
    sync_parent_directory(&parent).map_err(|e| AtomicJsonWriteError::ParentFsync {
        parent: parent.clone(),
        reason: format!("parent dir fsync: {e}"),
    })?;

    Ok(())
}

/// Open the parent directory + fsync it. The directory
/// must already exist (we created it in step 1 OR it was
/// pre-existing). On a clean system this is fast; on a
/// busy disk it may block on the journal flush.
///
/// **Why a separate helper:** the directory-fd
/// open/fsync/drop sequence is small but easy to get
/// wrong. Keeping it isolated lets the unit test pin the
/// syscall sequence without dragging in the rest of the
/// 6-step dance.
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    // `OpenOptions::read(true)` opens the directory for
    // reading — Linux supports `fsync(2)` on directory
    // fds. macOS supports it via fcntl(F_FULLFSYNC); the
    // edge agent runs on Linux, so we use the standard
    // `sync_all` which calls `fsync` under the hood.
    let dir_fd = fs::OpenOptions::new().read(true).open(parent)?;
    dir_fd.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct TestPayload {
        schema_version: u32,
        value: String,
    }

    /// Per-test tempdir + target path.
    fn target_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("payload.json");
        (dir, path)
    }

    /// Round-trip: write a known payload, read it back via
    /// raw fs::read + serde_json::from_slice, every field
    /// matches.
    #[test]
    fn write_atomic_json_round_trips_payload() {
        let (_dir, path) = target_path();
        let original = TestPayload {
            schema_version: 1,
            value: "round-trip".to_string(),
        };
        write_atomic_json(&path, &original).expect("write");

        let bytes = fs::read(&path).expect("read");
        let loaded: TestPayload = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(loaded, original);
    }

    /// First-boot path: the parent directory of the target
    /// does NOT exist beforehand. The helper creates it
    /// (step 1).
    #[test]
    fn write_atomic_json_creates_missing_parent_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir
            .path()
            .join("nested")
            .join("subdir")
            .join("payload.json");
        assert!(!nested.parent().unwrap().exists());
        write_atomic_json(
            &nested,
            &TestPayload {
                schema_version: 1,
                value: "first-boot".to_string(),
            },
        )
        .expect("write to deep path");
        assert!(nested.exists());
        assert!(nested.parent().unwrap().is_dir());
    }

    /// After a successful write the parent directory
    /// contains exactly the target file (no leftover
    /// `.payload.json.tmp-<pid>`). Pins step 5's atomic
    /// rename + temp cleanup contract.
    #[test]
    fn write_atomic_json_leaves_no_temp_file_on_success() {
        let (dir, path) = target_path();
        write_atomic_json(
            &path,
            &TestPayload {
                schema_version: 1,
                value: "no-leftover".to_string(),
            },
        )
        .expect("write");
        let entries: Vec<_> = fs::read_dir(dir.path())
            .expect("readdir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(
            entries.is_empty(),
            "expected no temp leftovers, found: {entries:?}"
        );
        assert!(path.exists());
    }

    /// Re-write semantic: a second call REPLACES the
    /// previous payload (e.g., updating a manifest after
    /// migration).
    #[test]
    fn write_atomic_json_replaces_previous_contents() {
        let (_dir, path) = target_path();
        write_atomic_json(
            &path,
            &TestPayload {
                schema_version: 1,
                value: "first".to_string(),
            },
        )
        .expect("write 1");
        write_atomic_json(
            &path,
            &TestPayload {
                schema_version: 2,
                value: "second".to_string(),
            },
        )
        .expect("write 2");
        let bytes = fs::read(&path).expect("read");
        let loaded: TestPayload = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(loaded.schema_version, 2);
        assert_eq!(loaded.value, "second");
    }

    /// `sync_parent_directory` works on a normal directory
    /// (no error). Pins step 6's syscall correctness.
    #[test]
    fn sync_parent_directory_succeeds_on_existing_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        sync_parent_directory(dir.path()).expect("fsync ok");
    }

    /// `sync_parent_directory` errors on a non-existent
    /// path. Pins the IO-error propagation.
    #[test]
    fn sync_parent_directory_errors_on_missing_path() {
        let bogus = PathBuf::from("/nonexistent-path-batch-338-test");
        assert!(sync_parent_directory(&bogus).is_err());
    }

    /// JSON output is operator-readable pretty-printed
    /// (multi-line, indented). Pins the format contract
    /// against accidental switch to compact form which
    /// would break `cat`-able operator ergonomics.
    #[test]
    fn write_atomic_json_outputs_pretty_form() {
        let (_dir, path) = target_path();
        write_atomic_json(
            &path,
            &TestPayload {
                schema_version: 7,
                value: "pretty".to_string(),
            },
        )
        .expect("write");
        let raw = fs::read_to_string(&path).expect("read");
        // Pretty form contains newlines + indentation;
        // compact form would be `{"schema_version":7,...}`
        // single-line.
        assert!(
            raw.contains('\n'),
            "expected multi-line pretty JSON, got: {raw:?}"
        );
        assert!(
            raw.contains("  "),
            "expected indented pretty JSON, got: {raw:?}"
        );
    }

    /// Display string for each error variant carries the
    /// canonical `atomic_json_*_failed` prefix for log
    /// aggregator search.
    #[test]
    fn error_display_strings_pinned() {
        let p = PathBuf::from("/x/y");
        let cases = [
            (
                AtomicJsonWriteError::ParentCreate {
                    path: p.clone(),
                    reason: "perm".into(),
                },
                "atomic_json_parent_create_failed",
            ),
            (
                AtomicJsonWriteError::Serialize {
                    path: p.clone(),
                    reason: "json".into(),
                },
                "atomic_json_serialize_failed",
            ),
            (
                AtomicJsonWriteError::TempIo {
                    temp_path: p.clone(),
                    reason: "io".into(),
                },
                "atomic_json_temp_io_failed",
            ),
            (
                AtomicJsonWriteError::Rename {
                    path: p.clone(),
                    reason: "ren".into(),
                },
                "atomic_json_rename_failed",
            ),
            (
                AtomicJsonWriteError::ParentFsync {
                    parent: p,
                    reason: "fs".into(),
                },
                "atomic_json_parent_fsync_failed",
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

    #[test]
    fn error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<AtomicJsonWriteError>();
    }
}
