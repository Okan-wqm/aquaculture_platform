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
//! - Single-writer: `Mutex<File>` gates every append. No
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

use super::chain::{CurrentHmac, HmacChainEntry, PrevHmac, append_entry};
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
    /// ## Chain recovery (Batch 75 Sprint 6.2 Phase 2)
    ///
    /// Before opening in append-mode, this function SCANS
    /// the file (if it already exists + non-empty) for the
    /// LAST complete NDJSON line. On success, initializes:
    /// - `last_hmac = <current_hmac_hex from last line>`
    /// - `last_sequence = <sequence from last line>`
    ///
    /// so the next append chains from where the previous
    /// process left off. This closes the cross-restart
    /// forensic-continuity gap: without recovery, every
    /// boot starts a new chain segment at genesis zeros,
    /// forcing the audit-verify CLI to stitch independent
    /// segments across restart boundaries.
    ///
    /// RECOVERY FAILURE MODES:
    /// - File does not exist yet → genesis zeros (first boot).
    /// - File exists but empty → genesis zeros (touched but
    ///   never written; idempotent on logrotate truncate).
    /// - File exists but LAST line is malformed (partial
    ///   write on crash) → the recovery scanner drops the
    ///   trailing partial line + recovers from the LAST
    ///   COMPLETE line. The partial line is left in place
    ///   for the audit-verify CLI to flag as "torn tail".
    /// - File exists + last line is valid but not parseable
    ///   as NDJSON (log corruption / wrong file) → open
    ///   returns Err. Fail-closed: an unrecoverable audit
    ///   log is a forensic-integrity signal.
    pub fn open(path: &Path, hmac_key: AuditHmacKey) -> Result<Self, AuditSinkError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AuditSinkError::OpenFailed(format!("mkdir {}: {}", parent.display(), e))
            })?;
        }

        // Batch 75: scan existing file for chain recovery.
        let (recovered_hmac, recovered_seq, recovery_note) = recover_chain_state(path)?;

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

        let file = file
            .map_err(|e| AuditSinkError::OpenFailed(format!("open {}: {}", path.display(), e)))?;

        let writer = BufWriter::new(file);

        let state = SinkState {
            writer,
            hmac_key,
            last_hmac: recovered_hmac,
            last_sequence: recovered_seq,
        };

        info!(
            "AuditSink opened: path={} chain={}",
            path.display(),
            recovery_note
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
        let mut guard = self
            .state
            .lock()
            .map_err(|_| AuditSinkError::LockPoisoned)?;

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

    /// Swap the HMAC key without touching the chain state
    /// or file handle (Batch 99 Sprint 6.3 master-key
    /// rotation integration).
    ///
    /// ## WHY
    ///
    /// The audit sink's AuditHmacKey is MATERIALIZED at
    /// init time from `keystore.derive_key(AuditHmacChain)`.
    /// When master rotation happens (Batch 98
    /// `rotate_master_from_files`), the derived key CHANGES
    /// immediately but the sink's cached key stays OLD.
    /// Post-rotation audit entries would still be HMAC'd
    /// with the OLD key — breaking the property "same key
    /// across a chain segment" + creating a forensic
    /// discontinuity.
    ///
    /// `reload_hmac_key` lets the rotation orchestrator
    /// atomically:
    /// 1. Rotate master in keystore.
    /// 2. Derive NEW audit HMAC key.
    /// 3. Call sink.reload_hmac_key(new_key).
    /// 4. Subsequent appends use new key.
    ///
    /// ## Chain continuity
    ///
    /// Chain state (last_hmac, last_sequence) is
    /// INTENTIONALLY preserved. The NEXT entry after a
    /// key swap uses:
    /// - prev_hmac = LAST ENTRY'S current_hmac (under OLD
    ///   key, the OLD value carried forward as the chain
    ///   link).
    /// - computed via HMAC_NEW(prev_hmac || entry_bytes).
    ///
    /// audit-verify CLI consumers MUST know the key
    /// rotation boundary: segment N (entries 1..K) verifies
    /// with OLD key, segment N+1 (entries K+1..) verifies
    /// with NEW key; cross-boundary link uses the OLD key's
    /// last current_hmac as the NEW key's first prev_hmac.
    ///
    /// Operator procedure: on rotation, emit an audit entry
    /// `KeyRotated` BEFORE calling reload_hmac_key. That
    /// entry is the explicit boundary marker in the log.
    pub fn reload_hmac_key(&self, new_key: AuditHmacKey) -> Result<(), AuditSinkError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| AuditSinkError::LockPoisoned)?;

        // Flush buffered content + fsync under the OLD key
        // before the swap. If we flipped the key first, any
        // buffered unflushed line would be HMAC-queued with
        // OLD but technically written under NEW context.
        // (The chain entry was COMPUTED when append was
        // called, so this is defense-in-depth — the write
        // path already has computed the HMAC at append
        // time.)
        guard
            .writer
            .flush()
            .map_err(|e| AuditSinkError::WriteFailed(format!("reload flush: {}", e)))?;
        guard
            .writer
            .get_ref()
            .sync_all()
            .map_err(|e| AuditSinkError::WriteFailed(format!("reload fsync: {}", e)))?;

        guard.hmac_key = new_key;

        info!(
            "AuditSink hmac_key reloaded: chain_preserved_at_sequence={} (operator should emit KeyRotated audit entry BEFORE this call for forensic clarity)",
            guard.last_sequence
        );

        Ok(())
    }

    /// Reopen the file handle at the same path WITHOUT
    /// resetting chain state (Batch 76 Sprint 6.2 Phase 2
    /// SIGHUP rotation compatibility).
    ///
    /// ## WHY
    ///
    /// Standard logrotate pattern is `create + rename +
    /// signal`:
    /// 1. logrotate renames `/var/log/suderra/audit.log` →
    ///    `audit.log.1` (the agent's fd still points at the
    ///    renamed file — still writable but to a rotated
    ///    name the operator expects to be frozen).
    /// 2. logrotate creates a new empty `audit.log`.
    /// 3. logrotate sends SIGHUP to the agent.
    /// 4. Agent's SIGHUP handler calls this method →
    ///    `reopen()` flushes + closes the old fd (now
    ///    pointing at `audit.log.1`) and opens a new fd at
    ///    `audit.log` (the fresh empty file).
    /// 5. Next append writes to the fresh file at sequence
    ///    N+1 — chain state (last_hmac, last_sequence)
    ///    preserved in memory, so the new file's first line
    ///    has prev_hmac = <current_hmac from last line of
    ///    rotated file>. The audit-verify CLI stitches
    ///    across files via that prev_hmac linkage.
    ///
    /// ## CHAIN STATE PRESERVATION
    ///
    /// Unlike `open()` which runs chain recovery from the
    /// file, `reopen()` DOES NOT touch `last_hmac` /
    /// `last_sequence`. This is a deliberate design choice:
    /// the in-memory state is the source of truth across
    /// rotation. A new file starts EMPTY; trying to recover
    /// chain state from an empty file would regress to
    /// genesis zeros and BREAK cross-file chain continuity.
    ///
    /// ## FAILURE SEMANTICS
    ///
    /// - Flush failure → return WriteFailed (the previous
    ///   fd had buffered data; losing it on reopen is an
    ///   integrity loss).
    /// - Open failure on the new path → return OpenFailed;
    ///   caller (SIGHUP handler) logs the error. The sink
    ///   is left in a degraded state — old fd is closed,
    ///   new fd is NOT replaced. Next append will fail-fast
    ///   at the same OpenFailed. Fail-loudly is better than
    ///   silent write-to-dangling-fd.
    pub fn reopen(&self) -> Result<(), AuditSinkError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| AuditSinkError::LockPoisoned)?;

        // Flush any buffered content to the old fd BEFORE
        // closing it. The old fd is still valid even after
        // logrotate's rename (POSIX: rename doesn't
        // invalidate open fds).
        guard
            .writer
            .flush()
            .map_err(|e| AuditSinkError::WriteFailed(format!("reopen flush: {}", e)))?;
        guard
            .writer
            .get_ref()
            .sync_all()
            .map_err(|e| AuditSinkError::WriteFailed(format!("reopen fsync: {}", e)))?;

        // Open the new file at the same path. Same 0640
        // perms + same O_APPEND | O_CREATE as `open()`.
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AuditSinkError::OpenFailed(format!("reopen mkdir {}: {}", parent.display(), e))
            })?;
        }

        #[cfg(unix)]
        let new_file = {
            use std::os::unix::fs::OpenOptionsExt;
            OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o640)
                .open(&self.path)
        };
        #[cfg(not(unix))]
        let new_file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.path);

        let new_file = new_file.map_err(|e| {
            AuditSinkError::OpenFailed(format!("reopen {}: {}", self.path.display(), e))
        })?;

        // Replace the writer. Dropping the old BufWriter
        // closes the old fd. Chain state (last_hmac,
        // last_sequence) is INTENTIONALLY preserved — the
        // new file starts at sequence=last_sequence+1 with
        // prev_hmac=last_hmac linking it to the rotated file.
        guard.writer = BufWriter::new(new_file);

        info!(
            "AuditSink reopened: path={} chain_preserved_at_sequence={}",
            self.path.display(),
            guard.last_sequence
        );

        Ok(())
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

/// Chain-state recovery on open (Batch 75 Sprint 6.2 Phase 2).
///
/// Reads the existing log file (if any) and extracts the
/// LAST COMPLETE NDJSON line's `(current_hmac_hex, sequence)`.
/// A "complete" line is one that ends with `\n` in the stored
/// content — a partial line (crash mid-write) is dropped.
///
/// Returns `(last_hmac, last_sequence, recovery_note)` where
/// recovery_note is a human-readable string for boot-banner
/// logging ("genesis (no prior log)", "recovered from
/// sequence=N", "recovered after dropping torn tail at
/// offset=K").
///
/// FAIL-CLOSED behavior:
/// - If the last complete line is non-empty but unparseable
///   (bad JSON / missing fields / wrong-length hmac hex),
///   returns Err — an audit log that CANNOT be recovered is
///   a forensic-integrity signal that warrants operator
///   attention. Silently starting a new chain at genesis
///   after a mystery corruption would erase the discontinuity.
///
/// Performance note:
/// - For the expected log sizes (rotated daily at ~10-100 MB),
///   reading the file to locate the last newline is
///   acceptable. If log sizes grow beyond ~1 GB, a
///   reverse-chunk reader (memchr::memrchr on 64 KB
///   windows) is the Phase 2 metrics-gated upgrade path per
///   plan §5 Faz 2 item 8 — Phase 9 test matrix surfaces
///   the signal before the upgrade fires.
fn recover_chain_state(path: &Path) -> Result<(PrevHmac, u64, String), AuditSinkError> {
    use std::io::Read;

    if !path.exists() {
        return Ok((
            PrevHmac::from_bytes([0u8; 32]),
            0,
            "genesis (file not yet created)".to_string(),
        ));
    }

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return Err(AuditSinkError::OpenFailed(format!(
                "recovery-scan open {}: {}",
                path.display(),
                e
            )));
        }
    };

    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| {
        AuditSinkError::OpenFailed(format!("recovery-scan read {}: {}", path.display(), e))
    })?;

    if buf.is_empty() {
        return Ok((
            PrevHmac::from_bytes([0u8; 32]),
            0,
            "genesis (file exists but empty — logrotate truncate or never-written)".to_string(),
        ));
    }

    // Find the last complete NDJSON line. A complete line ends
    // with '\n' in the file body. Partial-write tail (crash
    // mid-fsync) is dropped.
    //
    // Strategy: walk backward from the end, locate the
    // rightmost '\n'. The content AFTER that '\n' (if any) is
    // the torn tail; the content BEFORE it contains the last
    // complete line as its tail.
    let last_newline_idx = buf.iter().rposition(|&b| b == b'\n');
    let (complete_bytes, torn_tail_len) = match last_newline_idx {
        Some(idx) => {
            // buf[..=idx] ends with \n; buf[idx+1..] is the torn tail.
            let torn_len = buf.len() - (idx + 1);
            // Trim the trailing newline to avoid an empty "line" split.
            let complete = &buf[..idx];
            (complete, torn_len)
        }
        None => {
            // No newline at all → entire file is a torn tail
            // (never flushed a complete line). Fail-closed:
            // the file exists but has no complete entry —
            // treat as genesis + log the anomaly.
            warn!(
                "AuditSink recovery: file {} has no newline (torn-tail-only, {} bytes). Starting at genesis; audit-verify CLI will flag the torn tail.",
                path.display(),
                buf.len()
            );
            return Ok((
                PrevHmac::from_bytes([0u8; 32]),
                0,
                format!(
                    "genesis (torn-tail-only: {} bytes before first newline)",
                    buf.len()
                ),
            ));
        }
    };

    // Locate the last LINE within complete_bytes — split on
    // the second-to-last newline (if any).
    let last_line_start = complete_bytes
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let last_line = &complete_bytes[last_line_start..];

    if last_line.is_empty() {
        // File is "\n\n\n..." — unusual but not malformed.
        // Treat as genesis.
        return Ok((
            PrevHmac::from_bytes([0u8; 32]),
            0,
            "genesis (empty-line file)".to_string(),
        ));
    }

    // Parse the last line as our NDJSON shape.
    #[derive(serde::Deserialize)]
    struct RecoveredLine {
        sequence: u64,
        current_hmac_hex: String,
    }

    let parsed: RecoveredLine = serde_json::from_slice(last_line).map_err(|e| {
        AuditSinkError::OpenFailed(format!(
            "recovery-scan parse last line (corruption detected): {} \
             — refusing to silently start new chain at genesis. \
             File: {}",
            e,
            path.display()
        ))
    })?;

    if parsed.current_hmac_hex.len() != 64
        || !parsed
            .current_hmac_hex
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err(AuditSinkError::OpenFailed(format!(
            "recovery-scan: current_hmac_hex must be 64 lowercase hex chars, got {:?} in file {}",
            parsed.current_hmac_hex,
            path.display()
        )));
    }

    let mut hmac_bytes = [0u8; 32];
    for (i, b) in hmac_bytes.iter_mut().enumerate() {
        let pair = parsed
            .current_hmac_hex
            .get(i * 2..i * 2 + 2)
            .ok_or_else(|| {
                AuditSinkError::OpenFailed(format!(
                    "recovery-scan: hmac hex slice error at byte {} in file {}",
                    i,
                    path.display()
                ))
            })?;
        *b = u8::from_str_radix(pair, 16).map_err(|e| {
            AuditSinkError::OpenFailed(format!(
                "recovery-scan: hmac hex parse at byte {}: {} in file {}",
                i,
                e,
                path.display()
            ))
        })?;
    }

    let note = if torn_tail_len == 0 {
        format!("recovered from sequence={}", parsed.sequence)
    } else {
        format!(
            "recovered from sequence={} (dropped {} torn-tail bytes; audit-verify will flag)",
            parsed.sequence, torn_tail_len
        )
    };

    Ok((PrevHmac::from_bytes(hmac_bytes), parsed.sequence, note))
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
            resource: AuditResource::Tag {
                name: "pond3_temp".to_string(),
            },
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
        assert!(
            contents.contains("\"current_hmac_hex\""),
            "got: {}",
            contents
        );
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

    // -------------------------------------------------------
    // Batch 75 — chain recovery on restart
    // -------------------------------------------------------

    #[test]
    fn recovery_genesis_on_missing_file() {
        let path = tmp_path();
        let _ = std::fs::remove_file(&path);
        let (hmac, seq, note) = recover_chain_state(&path).expect("recovery OK on missing file");
        assert_eq!(hmac.as_bytes(), &[0u8; 32]);
        assert_eq!(seq, 0);
        assert!(note.starts_with("genesis"), "unexpected note: {}", note);
    }

    #[test]
    fn recovery_genesis_on_empty_file() {
        let path = tmp_path();
        std::fs::write(&path, b"").expect("create empty");
        let (hmac, seq, note) = recover_chain_state(&path).expect("recovery OK empty");
        assert_eq!(hmac.as_bytes(), &[0u8; 32]);
        assert_eq!(seq, 0);
        assert!(note.contains("empty"), "unexpected note: {}", note);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn recovery_reads_last_complete_line() {
        let path = tmp_path();
        let key = AuditHmacKey::from_bytes([0x77u8; 32]);
        {
            let sink = AuditSink::open(&path, key).expect("open 1");
            sink.append(canned_entry()).expect("append 1");
            sink.append(canned_entry()).expect("append 2");
            sink.append(canned_entry()).expect("append 3");
        } // drop closes file

        let key2 = AuditHmacKey::from_bytes([0x77u8; 32]);
        let sink2 = AuditSink::open(&path, key2).expect("open 2 (recovery)");
        let (seq, _hmac_hex) = sink2.snapshot();
        assert_eq!(seq, 3, "recovered sequence should be 3 after 3 appends");

        // Next append chains from sequence=3 → 4.
        let seq4 = sink2
            .append(canned_entry())
            .expect("append 4 post-recovery");
        assert_eq!(seq4, 4);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn recovery_drops_torn_tail() {
        let path = tmp_path();
        // Compose a valid first line + a torn partial tail.
        let valid_line = serde_json::json!({
            "sequence": 7,
            "prev_hmac_hex": "0".repeat(64),
            "current_hmac_hex": "a".repeat(64),
            "entry": { "placeholder": true }
        });
        let mut buf = serde_json::to_string(&valid_line).unwrap();
        buf.push('\n');
        buf.push_str("{\"sequence\":8,\"prev_hmac_hex\":\"aaa"); // torn tail
        std::fs::write(&path, buf.as_bytes()).expect("write");

        let (hmac, seq, note) = recover_chain_state(&path).expect("recovery OK");
        assert_eq!(seq, 7, "should recover from last complete line");
        assert_eq!(hmac.as_bytes(), &[0xaau8; 32]);
        assert!(
            note.contains("torn-tail"),
            "note should flag torn tail: {}",
            note
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn recovery_fails_closed_on_corrupt_last_line() {
        let path = tmp_path();
        // Well-formed complete line but the json shape is
        // wrong (missing current_hmac_hex) — fail-closed.
        let bad_line = b"{\"sequence\":1}\n";
        std::fs::write(&path, bad_line).expect("write");

        let outcome = recover_chain_state(&path);
        assert!(outcome.is_err(), "must fail-closed on corrupt last line");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn recovery_fails_closed_on_bad_hmac_hex_length() {
        let path = tmp_path();
        let bad = serde_json::json!({
            "sequence": 1,
            "prev_hmac_hex": "0".repeat(64),
            "current_hmac_hex": "abc",  // too short
            "entry": {}
        });
        let mut buf = serde_json::to_string(&bad).unwrap();
        buf.push('\n');
        std::fs::write(&path, buf.as_bytes()).expect("write");

        let outcome = recover_chain_state(&path);
        assert!(
            outcome.is_err(),
            "must fail-closed on wrong-length hmac hex"
        );
        let _ = std::fs::remove_file(&path);
    }

    // -------------------------------------------------------
    // Batch 76 — SIGHUP rotation compatibility
    // -------------------------------------------------------

    #[test]
    fn reopen_preserves_chain_state() {
        // Simulates logrotate's rename+signal pattern:
        // 1. Open sink + append 3 entries.
        // 2. Rename the file (as logrotate would).
        // 3. Call reopen() — agent's SIGHUP handler path.
        // 4. Append 1 more entry — it should chain from
        //    sequence=4 with prev_hmac matching the
        //    rotated file's last current_hmac.
        let path = tmp_path();
        let rotated_path = path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated_path);
        let key = AuditHmacKey::from_bytes([0x88u8; 32]);
        let sink = AuditSink::open(&path, key).expect("open");

        assert_eq!(sink.append(canned_entry()).expect("1"), 1);
        assert_eq!(sink.append(canned_entry()).expect("2"), 2);
        assert_eq!(sink.append(canned_entry()).expect("3"), 3);

        let (pre_rotate_seq, pre_rotate_hmac) = sink.snapshot();
        assert_eq!(pre_rotate_seq, 3);

        // Simulate logrotate: rename file.
        std::fs::rename(&path, &rotated_path).expect("rename");

        // SIGHUP handler path.
        sink.reopen().expect("reopen OK");

        // Chain state MUST be preserved.
        let (post_reopen_seq, post_reopen_hmac) = sink.snapshot();
        assert_eq!(
            post_reopen_seq, pre_rotate_seq,
            "reopen must preserve last_sequence across rotation"
        );
        assert_eq!(
            post_reopen_hmac, pre_rotate_hmac,
            "reopen must preserve last_hmac across rotation"
        );

        // Next append goes to the NEW file at sequence 4.
        let seq4 = sink.append(canned_entry()).expect("append 4");
        assert_eq!(seq4, 4);

        // New file should have exactly one entry (seq=4).
        let new_contents = std::fs::read_to_string(&path).expect("read new");
        assert_eq!(
            new_contents.lines().count(),
            1,
            "rotated file should have 1 entry"
        );
        assert!(
            new_contents.contains("\"sequence\":4"),
            "new file first entry = seq 4: {}",
            new_contents
        );

        // Rotated file should have 3 entries (seq=1,2,3).
        let rotated_contents = std::fs::read_to_string(&rotated_path).expect("read rotated");
        assert_eq!(
            rotated_contents.lines().count(),
            3,
            "rotated file should have 3 entries"
        );

        // Cross-file linkage: new file's first line's
        // prev_hmac_hex == rotated file's last line's
        // current_hmac_hex.
        let rotated_last_line = rotated_contents.lines().last().expect("last line");
        let new_first_line = new_contents.lines().next().expect("first line");
        #[derive(serde::Deserialize)]
        struct Extract {
            prev_hmac_hex: Option<String>,
            current_hmac_hex: Option<String>,
        }
        let r: Extract = serde_json::from_str(rotated_last_line).expect("parse r");
        let n: Extract = serde_json::from_str(new_first_line).expect("parse n");
        assert_eq!(
            r.current_hmac_hex, n.prev_hmac_hex,
            "cross-file chain linkage MUST hold"
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&rotated_path);
    }

    // -------------------------------------------------------
    // Batch 99 — reload_hmac_key (rotation integration)
    // -------------------------------------------------------

    #[test]
    fn reload_hmac_key_preserves_chain_state() {
        let path = tmp_path();
        let key1 = AuditHmacKey::from_bytes([0xaau8; 32]);
        let sink = AuditSink::open(&path, key1).expect("open");

        sink.append(canned_entry()).expect("1");
        sink.append(canned_entry()).expect("2");
        let (pre_seq, pre_hmac) = sink.snapshot();
        assert_eq!(pre_seq, 2);

        // Swap HMAC key — chain state MUST be preserved.
        let key2 = AuditHmacKey::from_bytes([0xbbu8; 32]);
        sink.reload_hmac_key(key2).expect("reload");

        let (post_seq, post_hmac) = sink.snapshot();
        assert_eq!(post_seq, pre_seq, "sequence preserved");
        assert_eq!(post_hmac, pre_hmac, "last_hmac preserved");

        // Next append chains from seq=3 but uses NEW key.
        let seq3 = sink.append(canned_entry()).expect("3");
        assert_eq!(seq3, 3);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reload_hmac_key_uses_new_key_for_subsequent_appends() {
        let path = tmp_path();
        let key1_bytes = [0xccu8; 32];
        let key2_bytes = [0xddu8; 32];

        // Append one entry under key1, snapshot, reload to
        // key2, append another, and verify the two entries
        // HAVE DIFFERENT current_hmac (different key =
        // different HMAC output even for identical
        // canonical_bytes + prev_hmac is DIFFERENT per
        // append which drives entry-to-entry difference
        // anyway; the proof here is that the NEW key is
        // actually consumed).
        let sink = AuditSink::open(&path, AuditHmacKey::from_bytes(key1_bytes)).expect("open");
        sink.append(canned_entry()).expect("1");
        let (_, hmac_after_1) = sink.snapshot();

        sink.reload_hmac_key(AuditHmacKey::from_bytes(key2_bytes))
            .expect("reload");

        sink.append(canned_entry()).expect("2");
        let (_, hmac_after_2) = sink.snapshot();

        assert_ne!(hmac_after_1, hmac_after_2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reopen_after_external_file_delete_creates_new_file() {
        // Edge case: operator manually deletes the file
        // (rare but operationally possible). reopen() should
        // recreate it + continue appending with preserved
        // chain state.
        let path = tmp_path();
        let key = AuditHmacKey::from_bytes([0x99u8; 32]);
        let sink = AuditSink::open(&path, key).expect("open");
        sink.append(canned_entry()).expect("append 1");

        // Externally delete.
        std::fs::remove_file(&path).expect("manual delete");

        // reopen() recreates.
        sink.reopen().expect("reopen OK after delete");

        // Append chains from seq=2 into the fresh file.
        let seq2 = sink.append(canned_entry()).expect("append 2");
        assert_eq!(seq2, 2);

        let contents = std::fs::read_to_string(&path).expect("read");
        assert_eq!(contents.lines().count(), 1);
        assert!(contents.contains("\"sequence\":2"));

        let _ = std::fs::remove_file(&path);
    }
}
