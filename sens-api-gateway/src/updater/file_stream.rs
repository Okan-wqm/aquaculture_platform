//! File-streaming orchestrator (Batch 125 Sprint 6.5).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 6 + ADR-019 §2 specify the write-to-
//! standby step of the A/B firmware update lifecycle:
//! after the manifest body verifies + BEFORE the
//! SwapToPending transition, the firmware files must land
//! on the standby slot's filesystem. Batch 124 shipped
//! the read-side verifier; this batch shipps the write-
//! side orchestrator that puts files in place + calls
//! the verifier for TOCTOU re-verify.
//!
//! ## Scope
//!
//! - `FileSource` trait — the caller supplies a
//!   `read_file(path) -> Result<Vec<u8>>` implementation.
//!   Production impls come from MQTT file transfer / HTTP
//!   download / local cache; test impls use
//!   `InMemoryFileSource` with a HashMap<path, bytes>.
//! - `stream_files_to_standby(source, manifest, root)` —
//!   iterates manifest.files; for each: fetch bytes from
//!   source, stage at `root/.staging/<path>`, fsync,
//!   rename into `root/<path>`, run per-file verifier.
//! - TOCTOU discipline: the rename happens INSIDE
//!   root/.staging then moves to root/<path>; the verify
//!   runs on the FINAL path after rename so any swap-
//!   between-rename-and-verify is caught.
//! - Mode bits: after rename, chmod to
//!   `entry.digest.mode`. On Unix this is fchmodat; on
//!   other targets it is a no-op (config validation
//!   rejects non-Unix deployments during boot per plan).
//! - Atomic batch: if ANY file in the manifest fails
//!   (fetch / verify / chmod), the orchestrator returns
//!   Err; partial files remain on disk but the caller
//!   does NOT proceed to SwapToPending. Cleanup of
//!   partial state is the caller's responsibility (a
//!   retry attempt will overwrite).
//!
//! ## NOT in scope
//!
//! - Deletion of files that existed on the standby slot
//!   but are NOT in the new manifest. Clean-slate apply
//!   would delete; incremental apply would not. The
//!   simple answer is "operator wipes the slot before
//!   deploy" (A/B lifecycle discipline) + manifest lists
//!   the complete file set. Incremental apply is not
//!   supported per ADR-019 §2.
//! - Executable-bit enforcement on non-Unix platforms.
//!   Agent runs on Linux; a feature-gated no-op handles
//!   x86 dev boxes.
//! - Delta/binary-diff application. Manifest files are
//!   WHOLE-FILE replaced.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::file_verify::{verify_file_against_entry, FileVerifyError};
use super::manifest::FirmwareManifest;

/// File-source abstraction — produces the bytes of a
/// firmware file identified by its manifest path. The
/// caller drives the source (cloud download, local cache,
/// MQTT file transfer) + the orchestrator just asks for
/// bytes.
pub trait FileSource {
    fn read_file(&self, relative_path: &str) -> Result<Vec<u8>, FileSourceError>;
}

/// File-source failure taxonomy.
#[derive(Debug, Clone)]
pub enum FileSourceError {
    /// Path not found in the source (typo in manifest or
    /// missing file in the published release).
    NotFound { path: String },
    /// Transport error (network / disk / cache failure).
    Transport { path: String, reason: String },
}

impl std::fmt::Display for FileSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { path } => {
                write!(f, "file source: not found '{}'", path)
            }
            Self::Transport { path, reason } => {
                write!(f, "file source transport error for '{}': {}", path, reason)
            }
        }
    }
}

impl std::error::Error for FileSourceError {}

/// In-memory FileSource for tests + for the future
/// SignedFirmwareManifest-inlines-bytes flow (small
/// manifests can carry file bytes alongside the header;
/// large manifests use a separate transport).
#[derive(Clone, Default)]
pub struct InMemoryFileSource {
    files: HashMap<String, Vec<u8>>,
}

impl InMemoryFileSource {
    pub fn new() -> Self {
        Self {
            files: HashMap::new(),
        }
    }

    pub fn insert(&mut self, path: impl Into<String>, bytes: Vec<u8>) {
        self.files.insert(path.into(), bytes);
    }
}

impl FileSource for InMemoryFileSource {
    fn read_file(&self, relative_path: &str) -> Result<Vec<u8>, FileSourceError> {
        self.files
            .get(relative_path)
            .cloned()
            .ok_or_else(|| FileSourceError::NotFound {
                path: relative_path.to_string(),
            })
    }
}

/// Failure taxonomy for the streaming orchestrator.
#[derive(Debug)]
pub enum StreamError {
    /// FileSource rejected a manifest file.
    Source(FileSourceError),
    /// File-verify rejected a file after it landed on
    /// disk. The write AND the post-write read agreed on
    /// bytes, but the manifest-declared digest did NOT
    /// match — most common signal of either a manifest
    /// bug or active tampering between download + verify.
    Verify(FileVerifyError),
    /// std::io::Error during staging / rename / chmod /
    /// mkdir.
    Io { operation: String, reason: String },
    /// Manifest path escapes the standby root (absolute
    /// / `..` traversal). Tier-1 defense — should have
    /// been caught by manifest body verification (Batch 8
    /// `file_path_is_safe`) but redundant defense at
    /// write time covers manifest-verify bypass.
    UnsafePath { path: String },
}

impl std::fmt::Display for StreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(e) => write!(f, "stream source: {}", e),
            Self::Verify(e) => write!(f, "stream verify: {}", e),
            Self::Io { operation, reason } => {
                write!(f, "stream io {}: {}", operation, reason)
            }
            Self::UnsafePath { path } => {
                write!(f, "stream unsafe path: {}", path)
            }
        }
    }
}

impl std::error::Error for StreamError {}

/// Streaming report — counts + per-file failures. Even
/// when `verified_count` matches the manifest length, the
/// caller should check `failed.is_empty()` + abort apply
/// if any entry failed (fail-closed discipline).
#[derive(Debug)]
pub struct StreamReport {
    pub verified_count: usize,
    pub failed: Vec<(String, StreamError)>,
}

impl StreamReport {
    pub fn all_ok(&self) -> bool {
        self.failed.is_empty()
    }
}

/// Stream + stage + verify every file declared in the
/// manifest from `source` into `standby_root`.
///
/// Steps per file:
/// 1. Path-safety recheck (defense-in-depth vs manifest
///    body verify).
/// 2. Fetch bytes from source.
/// 3. `mkdir -p` parent directories under
///    `<root>/.staging`.
/// 4. Write to `<root>/.staging/<path>` + fsync.
/// 5. Rename to `<root>/<path>` (atomic within same
///    filesystem).
/// 6. Apply mode bits (Unix only).
/// 7. Run `verify_file_against_entry` on the FINAL path
///    (TOCTOU re-verify).
pub fn stream_files_to_standby(
    source: &dyn FileSource,
    manifest: &FirmwareManifest,
    standby_root: &Path,
) -> StreamReport {
    let staging_root = standby_root.join(".staging");

    // Ensure root + staging dirs exist. Boot-time config
    // validation catches missing mount points; this is
    // defense against partial operator provisioning.
    if let Err(e) = std::fs::create_dir_all(standby_root) {
        return StreamReport {
            verified_count: 0,
            failed: vec![(
                "<root>".to_string(),
                StreamError::Io {
                    operation: format!("mkdir {}", standby_root.display()),
                    reason: e.to_string(),
                },
            )],
        };
    }
    if let Err(e) = std::fs::create_dir_all(&staging_root) {
        return StreamReport {
            verified_count: 0,
            failed: vec![(
                ".staging".to_string(),
                StreamError::Io {
                    operation: format!("mkdir {}", staging_root.display()),
                    reason: e.to_string(),
                },
            )],
        };
    }

    let mut verified = 0usize;
    let mut failed = Vec::new();

    for entry in &manifest.files {
        match stream_one_file(source, entry, standby_root, &staging_root) {
            Ok(()) => verified += 1,
            Err(e) => failed.push((entry.path.clone(), e)),
        }
    }

    StreamReport {
        verified_count: verified,
        failed,
    }
}

fn stream_one_file(
    source: &dyn FileSource,
    entry: &super::manifest::FileEntry,
    standby_root: &Path,
    staging_root: &Path,
) -> Result<(), StreamError> {
    // Path-safety redundant check: manifest body verify
    // SHOULD already have rejected traversal paths, but
    // defense-in-depth catches a manifest-verify bypass
    // path or future manifest version that weakens the
    // check.
    if entry.path.starts_with('/')
        || entry.path.contains("..")
        || entry.path.contains('\0')
        || entry.path.contains('\\')
    {
        return Err(StreamError::UnsafePath {
            path: entry.path.clone(),
        });
    }

    let bytes = source
        .read_file(&entry.path)
        .map_err(StreamError::Source)?;

    let staging_path: PathBuf = staging_root.join(&entry.path);
    if let Some(parent) = staging_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| StreamError::Io {
            operation: format!("mkdir staging parent {}", parent.display()),
            reason: e.to_string(),
        })?;
    }

    {
        let mut f = File::create(&staging_path).map_err(|e| StreamError::Io {
            operation: format!("create {}", staging_path.display()),
            reason: e.to_string(),
        })?;
        f.write_all(&bytes).map_err(|e| StreamError::Io {
            operation: format!("write {}", staging_path.display()),
            reason: e.to_string(),
        })?;
        f.sync_all().map_err(|e| StreamError::Io {
            operation: format!("fsync {}", staging_path.display()),
            reason: e.to_string(),
        })?;
    }

    let final_path: PathBuf = standby_root.join(&entry.path);
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| StreamError::Io {
            operation: format!("mkdir final parent {}", parent.display()),
            reason: e.to_string(),
        })?;
    }
    std::fs::rename(&staging_path, &final_path).map_err(|e| StreamError::Io {
        operation: format!(
            "rename {} -> {}",
            staging_path.display(),
            final_path.display()
        ),
        reason: e.to_string(),
    })?;

    // Mode bits. On Unix: chmod. On non-Unix: skip (the
    // agent is Linux-only per plan §2 HC-7 cross-compile
    // targets aarch64/armv7/x86_64 all Unix).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(entry.digest.mode);
        std::fs::set_permissions(&final_path, perms).map_err(|e| StreamError::Io {
            operation: format!("chmod {:o} {}", entry.digest.mode, final_path.display()),
            reason: e.to_string(),
        })?;
    }

    // TOCTOU re-verify: the file-verify runs on the
    // FINAL path (post-rename). Any symlink-swap between
    // rename + verify is caught by the canonicalize +
    // starts_with(root) check inside verify_file_against_entry.
    verify_file_against_entry(standby_root, entry).map_err(StreamError::Verify)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::manifest::{FileDigest, FileEntry, FirmwareManifest, Sha256Digest, TargetArch};
    use crate::authz::permission::TenantId;
    use sha2::{Digest, Sha256};

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "suderra-stream-test-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        // Parent must exist for the orchestrator's mkdir-p
        // of root to succeed; we don't pre-create root
        // itself since the orchestrator is expected to
        // handle that.
        p
    }

    fn build_entry(path: &str, contents: &[u8], mode: u32) -> FileEntry {
        let mut h = Sha256::new();
        h.update(contents);
        let digest: [u8; 32] = h.finalize().into();
        FileEntry {
            path: path.to_string(),
            digest: FileDigest {
                sha256: Sha256Digest::from_bytes(digest),
                size_bytes: contents.len() as u64,
                mode,
            },
        }
    }

    fn build_manifest(entries: Vec<FileEntry>) -> FirmwareManifest {
        FirmwareManifest {
            firmware_version: 1,
            tenant_id: TenantId::new_from_verified([0u8; 16]),
            target_arch: TargetArch::compiled_target(),
            valid_from_unix_secs: 0,
            valid_until_unix_secs: 0,
            release_tag: "test".to_string(),
            files: entries,
        }
    }

    #[test]
    fn happy_path_streams_single_file_and_verifies_it() {
        let root = tmp_root();
        let bytes = b"fake-agent-binary-for-streaming-test".to_vec();
        let entry = build_entry("bin/suderra-agent", &bytes, 0o755);
        let manifest = build_manifest(vec![entry]);

        let mut source = InMemoryFileSource::new();
        source.insert("bin/suderra-agent", bytes);

        let report = stream_files_to_standby(&source, &manifest, &root);
        assert!(report.all_ok(), "stream failed: {:?}", report.failed);
        assert_eq!(report.verified_count, 1);

        // Final file exists at root/bin/suderra-agent.
        let final_path = root.join("bin/suderra-agent");
        assert!(final_path.exists());
        let content = std::fs::read(&final_path).expect("read final");
        assert_eq!(content, b"fake-agent-binary-for-streaming-test");

        // Staging directory is empty (file was moved out).
        let staging = root.join(".staging");
        let staging_bin = staging.join("bin/suderra-agent");
        assert!(!staging_bin.exists(), "staging file should be renamed");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn happy_path_streams_multiple_files_nested_dirs() {
        let root = tmp_root();
        let a = b"binary-alpha".to_vec();
        let b = b"service-unit-bravo".to_vec();
        let c = b"libssl-bytes".to_vec();
        let entries = vec![
            build_entry("bin/a", &a, 0o755),
            build_entry("etc/suderra/b.service", &b, 0o644),
            build_entry("lib/c.so", &c, 0o644),
        ];
        let manifest = build_manifest(entries);

        let mut source = InMemoryFileSource::new();
        source.insert("bin/a", a.clone());
        source.insert("etc/suderra/b.service", b.clone());
        source.insert("lib/c.so", c.clone());

        let report = stream_files_to_standby(&source, &manifest, &root);
        assert!(report.all_ok(), "multi-file stream failed: {:?}", report.failed);
        assert_eq!(report.verified_count, 3);
        assert_eq!(std::fs::read(root.join("bin/a")).unwrap(), a);
        assert_eq!(std::fs::read(root.join("etc/suderra/b.service")).unwrap(), b);
        assert_eq!(std::fs::read(root.join("lib/c.so")).unwrap(), c);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn source_not_found_reports_error_without_partial_write() {
        let root = tmp_root();
        let entry = build_entry("bin/missing", b"irrelevant", 0o755);
        let manifest = build_manifest(vec![entry]);
        let source = InMemoryFileSource::new(); // empty

        let report = stream_files_to_standby(&source, &manifest, &root);
        assert_eq!(report.verified_count, 0);
        assert_eq!(report.failed.len(), 1);
        assert!(matches!(
            report.failed[0].1,
            StreamError::Source(FileSourceError::NotFound { .. })
        ));
        // No final file materialized.
        assert!(!root.join("bin/missing").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn manifest_declared_digest_mismatch_is_caught_at_toctou_reverify() {
        // Source returns DIFFERENT bytes than the manifest
        // declared. Write succeeds (bytes-on-disk = source
        // bytes) but verify fails because manifest.digest
        // was computed for DIFFERENT bytes. Proves TOCTOU
        // re-verify catches source-integrity issues.
        let root = tmp_root();
        let manifest_bytes = b"genuine-bytes-per-manifest".to_vec();
        let mut entry = build_entry("bin/agent", &manifest_bytes, 0o755);
        // Tamper source: provide different bytes.
        let attacker_bytes = b"attacker-bytes-different".to_vec();
        let _ = attacker_bytes.len(); // same-size would also mismatch; we want digest-mismatch specifically
        entry.digest.size_bytes = attacker_bytes.len() as u64; // keep size consistent to reach digest check
        let manifest = build_manifest(vec![entry]);

        let mut source = InMemoryFileSource::new();
        source.insert("bin/agent", attacker_bytes);

        let report = stream_files_to_standby(&source, &manifest, &root);
        assert_eq!(report.verified_count, 0);
        assert_eq!(report.failed.len(), 1);
        match &report.failed[0].1 {
            StreamError::Verify(FileVerifyError::DigestMismatch { .. }) => {}
            other => panic!("expected DigestMismatch, got {:?}", other),
        }

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unsafe_manifest_path_rejected_before_any_write() {
        let root = tmp_root();
        // Path with `..` — manifest body verify SHOULD
        // have rejected, but Batch 125 has redundant
        // defense. Craft the entry directly to bypass
        // Batch 8's canonical_bytes safety.
        let entry = FileEntry {
            path: "../etc/passwd".to_string(),
            digest: FileDigest {
                sha256: Sha256Digest::from_bytes([0u8; 32]),
                size_bytes: 0,
                mode: 0o644,
            },
        };
        let manifest = build_manifest(vec![entry]);
        let source = InMemoryFileSource::new();

        let report = stream_files_to_standby(&source, &manifest, &root);
        assert_eq!(report.failed.len(), 1);
        assert!(matches!(
            report.failed[0].1,
            StreamError::UnsafePath { .. }
        ));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn partial_failure_reports_each_file_independently() {
        let root = tmp_root();
        let good_bytes = b"good".to_vec();
        let good_entry = build_entry("bin/good", &good_bytes, 0o644);
        let missing_entry = build_entry("bin/missing", b"missing", 0o644);
        let manifest = build_manifest(vec![good_entry, missing_entry]);

        let mut source = InMemoryFileSource::new();
        source.insert("bin/good", good_bytes);
        // bin/missing NOT in source.

        let report = stream_files_to_standby(&source, &manifest, &root);
        assert_eq!(report.verified_count, 1);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].0.ends_with("missing"));

        // good file IS written even though bad file failed —
        // atomicity discipline is at the apply_roll layer
        // (caller aborts SwapToPending), not at the per-
        // file stream layer.
        assert!(root.join("bin/good").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn unix_mode_bits_applied_after_rename() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp_root();
        let bytes = b"executable-binary".to_vec();
        let entry = build_entry("bin/exec", &bytes, 0o755);
        let manifest = build_manifest(vec![entry]);
        let mut source = InMemoryFileSource::new();
        source.insert("bin/exec", bytes);

        let report = stream_files_to_standby(&source, &manifest, &root);
        assert!(report.all_ok());
        let metadata = std::fs::metadata(root.join("bin/exec")).expect("stat");
        // Low 9 bits = permissions; compare masked.
        assert_eq!(metadata.permissions().mode() & 0o777, 0o755);

        std::fs::remove_dir_all(&root).ok();
    }
}
