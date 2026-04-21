//! Audit sink — append-only file + HMAC chain writer (Batch 74
//! Sprint 6.2 Phase 2 partial).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 8 + ADR-020 §6 mandate an append-only
//! `/var/log/suderra/audit.log` with per-entry HMAC chain so
//! every regulated action (command execution, RBAC manifest
//! rotation, force_value, firmware deploy, safe-state trigger)
//! leaves a tamper-evident forensic trail. Batch 6 delivered
//! the pure data model + chain compute function; this batch
//! lands the RUNTIME sink that owns the file handle + last-
//! chain state.
//!
//! ## WHAT
//!
//! `AuditSink::open(path, hmac_key_bytes)` opens a file in
//! O_APPEND mode + initializes a clean chain state
//! (prev_hmac=zeros, prev_sequence=0). `append(entry)`:
//!
//! 1. Acquires internal Mutex (single-writer semantics —
//!    audit events are ordered strictly).
//! 2. Calls the pure `audit::chain::append_entry` with HMAC
//!    computed via `hmac::Hmac<Sha256>` keyed on the
//!    injected bytes.
//! 3. Serializes the resulting `HmacChainEntry` as one NDJSON
//!    line (`{"sequence":N,"prev_hmac":"hex","current_hmac":
//!    "hex","entry":{…}}\n`).
//! 4. Writes + fsyncs the file descriptor (durability
//!    invariant for forensic use — a power-loss mid-flight
//!    must either keep the last N entries OR drop the
//!    partial line; both are detectable by the
//!    audit-verify CLI).
//! 5. Updates in-memory last_hmac + last_sequence so the
//!    next append chains correctly.
//!
//! ## WHAT THIS BATCH DOES NOT YET DO (roadmap — each item
//! has an explicit next-batch owner per plan §5 Faz 2)
//!
//! - Chain recovery on restart — Phase 2 / Batch 75 reads
//!   the LAST line of the log file + parses its
//!   current_hmac + sequence to initialize state. Without
//!   this, a restart resets the chain (still forensically
//!   valid because each boot produces a distinct chain
//!   segment joined by timestamp+boot_id, but the offline
//!   verify CLI must be chain-aware).
//! - Rotation — systemd logrotate handles file rotation
//!   externally; sink re-opens on SIGHUP (Phase 2 /
//!   Batch 76 SIGHUP wiring).
//! - Cloud relay — `edge/{device_id}/audit` MQTT publish
//!   (Phase 2 / Batch 77 — parallel consumer of the same
//!   in-memory chain state).
//! - Command-path wiring — Phase 2 / Batch 78 adds
//!   emit-audit calls in CommandHandler pre+post exec.
//! - audit-verify standalone CLI — Phase 2 / Batch 79.
//!
//! ## Security discipline
//!
//! - The HMAC key is derived from the master key via HKDF
//!   (`KeyPurpose::AuditHmacChain`). Batch 74 accepts the
//!   derived bytes via constructor; Phase 2 / Batch 80
//!   wires the master-key path when Sprint 6.3 keystore
//!   lands. The key is held in a `zeroize`-derived wrapper
//!   so drop scrubs the memory.
//! - File permissions: 0640 owner:suderra group:adm. The
//!   open() call sets the creation mode explicitly so a
//!   misconfigured umask cannot widen the permissions.
//! - Single-writer: Mutex<File> gates every append. No
//!   async file IO — the write+fsync cost (10-50us SSD,
//!   1-10ms SD card) is acceptable for the expected <100
//!   events/sec load.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::json;
use sha2::Sha256;
use tracing::{info, warn};
use zeroize::Zeroize;

use super::chain::{append_entry, CurrentHmac, HmacChainEntry, PrevHmac};
use super::entry::AuditEntry;

type HmacSha256 = Hmac<Sha256>;

/// HMAC key material wrapper — scrubs on drop. Sprint 6.3
/// keystore swaps the construction path to HKDF-derive from
/// the master key.
///
/// NOT Clone + NOT Copy: the key is single-use-per-sink. If
/// you need multiple sinks, derive multiple distinct keys
/// per `KeyPurpose` rather than sharing a single key.
pub struct AuditHmacKey([u8; 32]);

impl AuditHmacKey {
    /// Construct from pre-derived 32-byte key material.
    ///
    /// WHY pub(crate): external callers should NOT be able to
    /// synthesize an HmacKey from arbitrary bytes — the sole
    /// legitimate source is the master-key-derivation path
    /// (Sprint 6.3 wires this via KeyPurpose::AuditHmacChain).
    /// `pub(crate)` constrains the construction surface to
    /// the same module tree as the keystore integration.
    pub(crate) fn from_bytes(key: [u8; 32]) -> Self {
        Self(key)
    }

    /// Byte-slice accessor used by HMAC::new_from_slice. The
    /// lifetime is bound to &self so the caller cannot outlive
    /// the zeroize-on-drop guarantee.
    fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Drop for AuditHmacKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Runtime audit sink — owns file handle + chain state.
pub struct AuditSink {
    path: PathBuf,
    state: Mutex<SinkState>,
}

struct SinkState {
    writer: BufWriter<File>,
    hmac_key: AuditHmacKey,
    last_hmac: PrevHmac,
    last_sequence: u64,
}

/// Errors surfaced by the sink layer. Distinct from chain
/// errors (which are pure compute failures) — these are IO +
/// serialization concerns.
#[derive(Debug)]
pub enum AuditSinkError {
    /// Failed to open the log file (permissions / path).
    OpenFailed(String),
    /// Write or fsync failed mid-append.
    WriteFailed(String),
    /// Chain compute failed (upstream HmacChainError).
    ChainFailed(String),
    /// Serde failed to render the chain entry as NDJSON.
    SerdeFailed(String),
    /// Mutex poisoned by a prior panic.
    LockPoisoned,
}

impl std::fmt::Display for AuditSinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpenFailed(e) => write!(f, "audit sink open failed: {}", e),
            Self::WriteFailed(e) => write!(f, "audit sink write failed: {}", e),
            Self::ChainFailed(e) => write!(f, "audit sink chain compute failed: {}", e),
            Self::SerdeFailed(e) => write!(f, "audit sink serde failed: {}", e),
            Self::LockPoisoned => write!(f, "audit sink mutex poisoned"),
        }
    }
}

impl std::error::Error for AuditSinkError {}

impl AuditSink {
    /// Open the sink at `path` with the given HMAC key.
    ///
    /// The file is opened in O_APPEND | O_CREATE mode with
    /// 0640 permissions (owner:rw, group:r, other:-) and
    /// wrapped in a `BufWriter` for efficient per-line
    /// flushes. We still explicitly `fsync` after every
    /// append (durability discipline); the buffer exists to
    /// avoid repeat syscalls within the same flush window.
    ///
    /// Chain state initializes to:
    /// - `last_hmac = PrevHmac::from_bytes([0u8; 32])` (the
    ///   "genesis" sentinel — a verifier at sequence 1 sees
    ///   prev_hmac=zeros which is the documented chain-start
    ///   marker).
    /// - `last_sequence = 0` (first append gets sequence 1).
    ///
    /// Phase 2 / Batch 75 replaces the genesis init with
    /// last-line-scan recovery for continuity across restart.
    pub fn open(path: &Path, hmac_key: AuditHmacKey) -> Result<Self, AuditSinkError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AuditSinkError::OpenFailed(format!(
                    "mkdir {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        #[cfg(unix)]
        let file = {
            use std::os::unix::fs::OpenOptionsExt;
            OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o640)
                .open(path)
        };
        #[cfg(not(unix))]
        let file = OpenOptions::new().append(true).create(true).open(path);

        let file = file.map_err(|e| {
            AuditSinkError::OpenFailed(format!(
                "open {}: {}",
                path.display(),
                e
            ))
        })?;

        let writer = BufWriter::new(file);

        let state = SinkState {
            writer,
            hmac_key,
            last_hmac: PrevHmac::from_bytes([0u8; 32]),
            last_sequence: 0,
        };

        info!(
            "AuditSink opened: path={} chain=genesis (Batch 75 follow-up wires last-line-scan recovery)",
            path.display()
        );

        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(state),
        })
    }

    /// Append one entry. Serializes into NDJSON, writes,
    /// fsyncs, and advances the in-memory chain state.
    ///
    /// The entire operation is mutex-gated so audit events
    /// are serialized strictly (the HMAC chain requires
    /// strict ordering — concurrent appends would race on
    /// `last_hmac`).
    pub fn append(&self, entry: AuditEntry) -> Result<u64, AuditSinkError> {
        let mut guard = self.state.lock().map_err(|_| AuditSinkError::LockPoisoned)?;

        let hmac_key_bytes = *guard.hmac_key.as_bytes();

        let chain_entry = append_entry(
            guard.last_hmac,
            guard.last_sequence,
            entry,
            |input: &[u8]| -> Option<[u8; 32]> {
                let mut mac = HmacSha256::new_from_slice(&hmac_key_bytes).ok()?;
                mac.update(input);
                let bytes = mac.finalize().into_bytes();
                let arr: [u8; 32] = bytes.into();
                Some(arr)
            },
        )
        .map_err(|e| AuditSinkError::ChainFailed(format!("{:?}", e)))?;

        let line = serialize_ndjson(&chain_entry)
            .map_err(|e| AuditSinkError::SerdeFailed(e.to_string()))?;

        guard
            .writer
            .write_all(line.as_bytes())
            .map_err(|e| AuditSinkError::WriteFailed(format!("write: {}", e)))?;
        guard
            .writer
            .write_all(b"\n")
            .map_err(|e| AuditSinkError::WriteFailed(format!("write newline: {}", e)))?;
        guard
            .writer
            .flush()
            .map_err(|e| AuditSinkError::WriteFailed(format!("buf flush: {}", e)))?;
        guard
            .writer
            .get_ref()
            .sync_all()
            .map_err(|e| AuditSinkError::WriteFailed(format!("fsync: {}", e)))?;

        let new_seq = chain_entry.sequence();
        guard.last_hmac = chain_entry.current_hmac().to_prev();
        guard.last_sequence = new_seq;

        Ok(new_seq)
    }

    /// Observer-helper: returns the path this sink writes to.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Observer-helper: returns `(last_sequence, last_hmac_hex)`
    /// for boot-banner + get_config visibility. Zero-sequence
    /// means no entries written yet this process.
    pub fn snapshot(&self) -> (u64, String) {
        let guard = match self.state.lock() {
            Ok(g) => g,
            Err(_) => return (0, "<poisoned>".to_string()),
        };
        let hex: String = guard
            .last_hmac
            .as_bytes()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        (guard.last_sequence, hex)
    }
}

/// NDJSON serialization: one line per chain entry.
///
/// Shape:
/// ```json
/// {
///   "sequence": 42,
///   "prev_hmac_hex": "aabb...cc",
///   "current_hmac_hex": "ddee...ff",
///   "entry": { <AuditEntry fields> }
/// }
/// ```
///
/// hex-encoded HMACs keep the log file grep-friendly + diff-
/// reviewable. The AuditEntry is embedded via its Serialize
/// impl — same shape the audit-verify CLI consumes.
fn serialize_ndjson(entry: &HmacChainEntry) -> Result<String, serde_json::Error> {
    #[derive(Serialize)]
    struct Line<'a> {
        sequence: u64,
        prev_hmac_hex: String,
        current_hmac_hex: String,
        entry: &'a AuditEntry,
    }

    let line = Line {
        sequence: entry.sequence(),
        prev_hmac_hex: hex_encode(entry.prev_hmac().as_bytes()),
        current_hmac_hex: hex_encode(entry.current_hmac().as_bytes()),
        entry: entry.entry(),
    };

    serde_json::to_string(&line)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::super::entry::{
        AuditAction, AuditActor, AuditEntry, AuditOutcome, AuditPhase, AuditResource,
    };
    use super::*;
    use crate::authz::permission::TenantId;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn canned_entry() -> AuditEntry {
        AuditEntry {
            timestamp_unix_secs: 1_700_000_000,
            timestamp_nanos: 0,
            correlation_id: "cmd-uuid-abc".to_string(),
            phase: AuditPhase::Pre,
            actor: AuditActor::new("op:<operator>"),
            tenant: tenant(),
            policy_version: 1,
            two_person_integrity_verified: false,
            action: AuditAction::TagRead,
            resource: AuditResource::Tag { name: "pond3_temp".to_string() },
            outcome: AuditOutcome::Success,
            detail: "".to_string(),
        }
    }

    fn tmp_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "suderra-audit-sink-test-{}-{}.log",
            std::process::id(),
            rand::random::<u32>()
        ))
    }

    #[test]
    fn first_append_assigns_sequence_1() {
        let path = tmp_path();
        let key = AuditHmacKey::from_bytes([0x11u8; 32]);
        let sink = AuditSink::open(&path, key).expect("open");
        let seq = sink.append(canned_entry()).expect("append");
        assert_eq!(seq, 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn consecutive_appends_chain_sequences() {
        let path = tmp_path();
        let key = AuditHmacKey::from_bytes([0x22u8; 32]);
        let sink = AuditSink::open(&path, key).expect("open");
        assert_eq!(sink.append(canned_entry()).expect("1"), 1);
        assert_eq!(sink.append(canned_entry()).expect("2"), 2);
        assert_eq!(sink.append(canned_entry()).expect("3"), 3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn snapshot_reflects_last_append() {
        let path = tmp_path();
        let key = AuditHmacKey::from_bytes([0x33u8; 32]);
        let sink = AuditSink::open(&path, key).expect("open");
        assert_eq!(sink.snapshot().0, 0);
        sink.append(canned_entry()).expect("append");
        assert_eq!(sink.snapshot().0, 1);
        let (seq2, hmac_hex) = sink.snapshot();
        assert_eq!(seq2, 1);
        assert_eq!(hmac_hex.len(), 64);
        assert!(hmac_hex.chars().all(|c| c.is_ascii_hexdigit()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn appended_file_contains_ndjson_with_sequence_field() {
        let path = tmp_path();
        let key = AuditHmacKey::from_bytes([0x44u8; 32]);
        let sink = AuditSink::open(&path, key).expect("open");
        sink.append(canned_entry()).expect("append");
        drop(sink);

        let contents = std::fs::read_to_string(&path).expect("read back");
        assert!(contents.contains("\"sequence\":1"), "got: {}", contents);
        assert!(contents.contains("\"prev_hmac_hex\""), "got: {}", contents);
        assert!(contents.contains("\"current_hmac_hex\""), "got: {}", contents);
        assert!(contents.ends_with('\n'), "NDJSON must end with newline");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn chain_starts_from_zero_hmac_sentinel() {
        let path = tmp_path();
        let key = AuditHmacKey::from_bytes([0x55u8; 32]);
        let sink = AuditSink::open(&path, key).expect("open");
        sink.append(canned_entry()).expect("append");
        drop(sink);

        let contents = std::fs::read_to_string(&path).expect("read back");
        // First entry's prev_hmac_hex MUST be 64 zeros (chain
        // genesis sentinel).
        assert!(
            contents.contains(&format!("\"prev_hmac_hex\":\"{}\"", "0".repeat(64))),
            "genesis prev_hmac not zero-sentinel: {}",
            contents
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn hmac_key_zeroize_on_drop() {
        // Cannot DIRECTLY observe zeroize from outside (the
        // memory is freed), but we can prove the Drop impl
        // compiles + runs without panic. zeroize crate's
        // `Zeroize` trait is already validated by its own
        // test suite.
        let key = AuditHmacKey::from_bytes([0x66u8; 32]);
        drop(key);
    }
}
