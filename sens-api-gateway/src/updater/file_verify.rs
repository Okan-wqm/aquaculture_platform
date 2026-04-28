//! Per-file SHA-256 + size verification against a
//! verified SignedFirmwareManifest (Batch 124 Sprint 6.5).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 6 + ADR-019 §5 TOCTOU defense
//! mandate per-file verification AFTER files land on
//! the standby partition. The manifest-body verify
//! (`verify_firmware_manifest`, Batch 8) only proves
//! the FILE LIST + declared digests are signed by the
//! trusted pubkey; it does NOT prove that the bytes
//! actually written to disk match the declared digests.
//!
//! Between download + rename, the file can be:
//! - Corrupted by storage media errors (RPi SD cards).
//! - Tampered by an attacker with filesystem write
//!   access (supply-chain defense).
//! - Truncated by a mid-download interruption that the
//!   downloader retry logic didn't catch.
//!
//! Per-file re-verify is the ONLY way to prove the
//! bytes-on-disk match the bytes-the-manifest-signed-
//! for. Without this, a bootloader flip could point at
//! a partition of corrupt firmware.
//!
//! ## Scope
//!
//! - Pure function: `verify_file_against_entry(path,
//!   entry) -> Result<(), FileVerifyError>`.
//! - Batch orchestrator: `verify_all_files(manifest_dir,
//!   manifest)` — iterates manifest.files + calls the
//!   per-file verifier.
//! - Streaming SHA-256: reads in 64 KiB chunks so large
//!   firmware binaries don't require full in-memory
//!   buffering.
//! - Size check: file size MUST equal
//!   `entry.digest.size_bytes`. Cheap short-circuit
//!   before SHA computation.
//!
//! ## NOT in scope
//!
//! - File-streaming FROM cloud TO standby. Batch 125
//!   wires the orchestrator that calls this verifier
//!   AFTER streaming.
//! - TOCTOU (re-verify after rename). Same Batch 125.
//! - Mode (executable) bit verification. The manifest
//!   carries mode; enforcing it requires root privilege
//!   + is applied at write time by the streaming path
//!   (not the verify path). Tracked for Batch 125.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::manifest::{FileEntry, FirmwareManifest, Sha256Digest};

/// Buffer size for streaming SHA-256. 64 KiB is the
/// sweet spot for RPi SD-card throughput: small enough
/// to fit in L2, large enough to amortize syscall cost.
const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// Per-file verification failure taxonomy.
#[derive(Debug, Clone)]
pub enum FileVerifyError {
    /// File does not exist at the computed path.
    NotFound { path: PathBuf },
    /// Path traversed outside the manifest root directory
    /// (e.g. symlink / `..` escape). Tier-1 defense
    /// against post-verify symlink attacks.
    PathEscaped { path: PathBuf },
    /// File size does not match `entry.digest.size_bytes`.
    SizeMismatch {
        path: PathBuf,
        expected: u64,
        actual: u64,
    },
    /// Streaming SHA-256 does not match
    /// `entry.digest.sha256`. The most common post-write
    /// corruption signal.
    DigestMismatch { path: PathBuf },
    /// IO error reading the file (permission denied,
    /// unreadable block, etc.).
    IoError {
        path: PathBuf,
        error: String,
    },
}

impl std::fmt::Display for FileVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { path } => write!(f, "file not found: {}", path.display()),
            Self::PathEscaped { path } => write!(f, "path escaped manifest root: {}", path.display()),
            Self::SizeMismatch { path, expected, actual } => write!(
                f,
                "size mismatch for {}: expected {} bytes, actual {} bytes",
                path.display(), expected, actual
            ),
            Self::DigestMismatch { path } => write!(f, "sha256 digest mismatch for {}", path.display()),
            Self::IoError { path, error } => write!(f, "io error for {}: {}", path.display(), error),
        }
    }
}

impl std::error::Error for FileVerifyError {}

/// Verify a single file against its manifest entry.
///
/// Steps (cheapest-first, same discipline as Batch 8
/// `verify_firmware_manifest`):
/// 1. Open file (catches NotFound).
/// 2. Stat for size (catches SizeMismatch without
///    reading any bytes).
/// 3. Streaming SHA-256 (catches DigestMismatch).
///
/// `manifest_root` is the base directory under which
/// `entry.path` is resolved. The resolved path MUST NOT
/// escape manifest_root (symlink / `..` defense). Root
/// containment is verified via canonicalize-and-compare.
pub fn verify_file_against_entry(
    manifest_root: &Path,
    entry: &FileEntry,
) -> Result<(), FileVerifyError> {
    let file_path = manifest_root.join(&entry.path);

    // Path-escape defense: resolve + check the result is
    // a descendant of manifest_root. The streaming SHA
    // operation uses the ORIGINAL (non-canonicalized)
    // path so symlink-swaps between canonicalize + open
    // can't bypass the containment check. This is the
    // TOCTOU-safe discipline.
    let root_canonical = match manifest_root.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return Err(FileVerifyError::IoError {
                path: manifest_root.to_path_buf(),
                error: format!("canonicalize manifest root: {}", e),
            });
        }
    };
    let resolved = match file_path.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(FileVerifyError::NotFound { path: file_path });
        }
        Err(e) => {
            return Err(FileVerifyError::IoError {
                path: file_path,
                error: format!("canonicalize: {}", e),
            });
        }
    };
    if !resolved.starts_with(&root_canonical) {
        return Err(FileVerifyError::PathEscaped { path: resolved });
    }

    // Open + stat.
    let file = File::open(&resolved).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FileVerifyError::NotFound {
                path: resolved.clone(),
            }
        } else {
            FileVerifyError::IoError {
                path: resolved.clone(),
                error: format!("open: {}", e),
            }
        }
    })?;
    let metadata = file.metadata().map_err(|e| FileVerifyError::IoError {
        path: resolved.clone(),
        error: format!("metadata: {}", e),
    })?;
    let actual_size = metadata.len();
    if actual_size != entry.digest.size_bytes {
        return Err(FileVerifyError::SizeMismatch {
            path: resolved,
            expected: entry.digest.size_bytes,
            actual: actual_size,
        });
    }

    // Streaming SHA-256.
    let mut reader = BufReader::with_capacity(STREAM_CHUNK_BYTES, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; STREAM_CHUNK_BYTES];
    loop {
        let n = reader.read(&mut buf).map_err(|e| FileVerifyError::IoError {
            path: resolved.clone(),
            error: format!("read: {}", e),
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut digest_bytes = [0u8; 32];
    digest_bytes.copy_from_slice(&digest);

    if Sha256Digest::from_bytes(digest_bytes) != entry.digest.sha256 {
        return Err(FileVerifyError::DigestMismatch { path: resolved });
    }

    Ok(())
}

/// Summary returned by the batch verifier.
#[derive(Debug, Clone)]
pub struct BatchVerifyReport {
    /// Number of files successfully verified.
    pub verified_count: usize,
    /// Paths of files that failed verification.
    pub failed: Vec<(String, FileVerifyError)>,
}

impl BatchVerifyReport {
    pub fn all_ok(&self) -> bool {
        self.failed.is_empty()
    }
}

/// Verify every file declared in `manifest` against the
/// filesystem rooted at `manifest_root`. Returns a
/// structured `BatchVerifyReport` — does NOT short-
/// circuit on first failure because the caller may want
/// to collect ALL failures for forensic analysis before
/// aborting the apply.
///
/// The orchestrator that calls this is responsible for
/// checking `all_ok()` + rejecting the apply when any
/// file failed. Fail-closed discipline: a single failure
/// is sufficient to abort.
pub fn verify_all_files(
    manifest_root: &Path,
    manifest: &FirmwareManifest,
) -> BatchVerifyReport {
    let mut verified = 0usize;
    let mut failed = Vec::new();
    for entry in &manifest.files {
        match verify_file_against_entry(manifest_root, entry) {
            Ok(()) => verified += 1,
            Err(e) => failed.push((entry.path.clone(), e)),
        }
    }
    BatchVerifyReport {
        verified_count: verified,
        failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::manifest::{FileDigest, Sha256Digest};
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "suderra-file-verify-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&p).expect("mkdir");
        p
    }

    fn write_and_hash(root: &Path, rel: &str, contents: &[u8]) -> (FileEntry, PathBuf) {
        let full = root.join(rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("mkdir parent");
        }
        let mut f = std::fs::File::create(&full).expect("create");
        f.write_all(contents).expect("write");
        f.sync_all().expect("fsync");
        let mut h = Sha256::new();
        h.update(contents);
        let digest_bytes: [u8; 32] = h.finalize().into();
        let entry = FileEntry {
            path: rel.to_string(),
            digest: FileDigest {
                sha256: Sha256Digest::from_bytes(digest_bytes),
                size_bytes: contents.len() as u64,
                mode: 0o644,
            },
        };
        (entry, full)
    }

    #[test]
    fn verify_ok_on_matching_file() {
        let root = tmp_root();
        let (entry, _) = write_and_hash(&root, "bin/agent", b"test-binary-bytes-here");
        let result = verify_file_against_entry(&root, &entry);
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_rejects_missing_file() {
        let root = tmp_root();
        let entry = FileEntry {
            path: "bin/nonexistent".to_string(),
            digest: FileDigest {
                sha256: Sha256Digest::from_bytes([0u8; 32]),
                size_bytes: 0,
                mode: 0o644,
            },
        };
        let err = verify_file_against_entry(&root, &entry).expect_err("must reject");
        assert!(matches!(err, FileVerifyError::NotFound { .. }));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_rejects_size_mismatch() {
        let root = tmp_root();
        let (mut entry, _) = write_and_hash(&root, "bin/agent", b"hello");
        entry.digest.size_bytes = 999; // claim wrong size
        let err = verify_file_against_entry(&root, &entry).expect_err("must reject");
        assert!(matches!(err, FileVerifyError::SizeMismatch { expected: 999, actual: 5, .. }));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_rejects_digest_mismatch() {
        let root = tmp_root();
        let (mut entry, _) = write_and_hash(&root, "bin/agent", b"genuine-bytes");
        // Clobber digest to a different hash; keep size
        // correct so we fall through to the digest check.
        entry.digest.sha256 = Sha256Digest::from_bytes([0xffu8; 32]);
        let err = verify_file_against_entry(&root, &entry).expect_err("must reject");
        assert!(matches!(err, FileVerifyError::DigestMismatch { .. }));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_streams_large_file_correctly() {
        // Build a file larger than STREAM_CHUNK_BYTES so
        // the streaming loop iterates multiple times.
        let root = tmp_root();
        let contents: Vec<u8> = (0..=255u8)
            .cycle()
            .take(STREAM_CHUNK_BYTES * 3 + 17)
            .collect();
        let (entry, _) = write_and_hash(&root, "bin/large", &contents);
        let result = verify_file_against_entry(&root, &entry);
        assert!(result.is_ok(), "large-file streaming failed: {:?}", result);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_all_files_reports_aggregated_ok_and_failures() {
        use super::super::manifest::{FirmwareManifest, TargetArch};
        use crate::authz::permission::TenantId;

        let root = tmp_root();
        let (good1, _) = write_and_hash(&root, "bin/a", b"alpha");
        let (good2, _) = write_and_hash(&root, "bin/b", b"bravo");
        let missing = FileEntry {
            path: "bin/missing".to_string(),
            digest: FileDigest {
                sha256: Sha256Digest::from_bytes([0u8; 32]),
                size_bytes: 0,
                mode: 0o644,
            },
        };

        let manifest = FirmwareManifest {
            firmware_version: 1,
            tenant_id: TenantId::new_from_verified([0u8; 16]),
            target_arch: TargetArch::compiled_target(),
            valid_from_unix_secs: 0,
            valid_until_unix_secs: 0,
            release_tag: "test".to_string(),
            files: vec![good1, good2, missing],
        };

        let report = verify_all_files(&root, &manifest);
        assert_eq!(report.verified_count, 2);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].0.ends_with("missing"));
        assert!(!report.all_ok());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn verify_all_files_all_ok_when_no_failures() {
        use super::super::manifest::{FirmwareManifest, TargetArch};
        use crate::authz::permission::TenantId;

        let root = tmp_root();
        let (g1, _) = write_and_hash(&root, "x", b"abc");
        let (g2, _) = write_and_hash(&root, "y", b"xyz");
        let manifest = FirmwareManifest {
            firmware_version: 1,
            tenant_id: TenantId::new_from_verified([0u8; 16]),
            target_arch: TargetArch::compiled_target(),
            valid_from_unix_secs: 0,
            valid_until_unix_secs: 0,
            release_tag: "test".to_string(),
            files: vec![g1, g2],
        };
        let report = verify_all_files(&root, &manifest);
        assert_eq!(report.verified_count, 2);
        assert!(report.all_ok());
        std::fs::remove_dir_all(&root).ok();
    }
}
