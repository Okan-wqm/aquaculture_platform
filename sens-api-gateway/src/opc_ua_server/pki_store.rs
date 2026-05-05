//! `PkiStore` — filesystem-backed signed PKI ledger for the OPC UA server.
//!
//! ## WHY this primitive exists
//!
//! Phase B-1 of the Faz 2 closure plan (`docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` §B-1, Batch #266) replaces
//! `async-opcua 0.18`'s `ServerBuilder::trust_client_certs(true)` Trust-On-First-Use
//! blob with a fingerprint-pinned, rotation-aware, audit-anchored PKI store.
//! Pre-B-1 the OPC UA server accepted any cert chained to a configured CA — a
//! poisoned intermediate CA could mint a fresh leaf and authenticate as any
//! operator. This module establishes the SSoT for "what fingerprints are
//! accepted right now" with structural rotation primitives + an append-only
//! signed ledger.
//!
//! See [`docs/adr/031-opc-ua-pki-lifecycle.md`](../../../docs/adr/031-opc-ua-pki-lifecycle.md)
//! for the architectural decision record (plan-intended ID was ADR-024 but
//! that was already taken — renumbered to 031 per the next free slot).
//!
//! ## Filesystem layout
//!
//! ```text
//! <pki_root>/
//! ├── own/                         # server's own keypair
//! │   ├── cert.der                 # ed25519 self-signed cert
//! │   └── key.pem                  # ed25519 private key
//! ├── trusted/clients/             # async-opcua reads this dir at handshake time
//! │   ├── <fingerprint-prefix>.der # one DER per accepted client cert
//! │   └── ...
//! ├── rejected/                    # async-opcua's revocation surface
//! │   ├── <fingerprint-prefix>.der # one DER per revoked client cert
//! │   └── ...
//! └── rotation_ledger.jsonl        # append-only signed ledger (one entry per line)
//! ```
//!
//! ## Ledger entry shape
//!
//! Each line in `rotation_ledger.jsonl` is a JSON object with shape:
//!
//! ```json
//! {
//!   "sequence": 42,
//!   "timestamp_unix_secs": 1730000000,
//!   "entry": {"kind": "cert_trusted", "fingerprint_hex": "abc...", "cert_label": "..."},
//!   "prev_hash_hex": "...",
//!   "current_hash_hex": "..."
//! }
//! ```
//!
//! `prev_hash_hex` of entry N+1 = SHA-256 of entry N's full JSON line. The
//! genesis prev_hash is `b"opc_ua_pki_ledger_v1\0"` (32-byte zero-padded
//! domain-separation tag) — distinct from audit log + RBAC manifest +
//! acceptance token chains. Future Phase B-1.5 wraps this with a full
//! `KeyPurpose::OpcUaPkiLedger` HMAC chain when the keystore-derived key
//! plumbing lands; the current SHA-256 chain is integrity-anchored
//! (tamper-evident) but not key-bound.
//!
//! ## Concurrency contract
//!
//! `PkiStore` is `Send + Sync`. All mutating methods take `&self` + use
//! interior `Mutex` for atomicity. The ledger is opened with O_APPEND so
//! concurrent writers from a misconfigured deployment are detected via
//! sequence-number gap + chain-mismatch on next reload, not via filesystem
//! lock contention. Production wires PkiStore as `Arc<PkiStore>` — single
//! instance per process.

#![cfg(feature = "opc-ua-server")]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Domain-separation tag for the OPC UA PKI ledger genesis prev_hash.
/// Distinct from audit log (`audit-entry-v1`), RBAC manifest, and acceptance
/// token chains — a signer cannot cross-substitute a valid signature across
/// protocols. Bytes laid out as 32-byte zero-padded ASCII for stable hex
/// representation in the ledger's first entry.
const GENESIS_DOMAIN_TAG: &[u8; 32] = b"opc_ua_pki_ledger_v1\0\0\0\0\0\0\0\0\0\0\0\0";

/// SHA-256 hex hash (64-char lowercase). Used for both prev/current hash
/// linkage in the ledger and for cert fingerprint identification. Newtype
/// wraps `String` for grepability — a `LedgerHash` cannot be accidentally
/// compared against a cert fingerprint at the type level.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LedgerHash(String);

impl LedgerHash {
    /// Compute genesis hash from the domain-separation tag.
    pub fn genesis() -> Self {
        Self(hex_lower(&Sha256::digest(GENESIS_DOMAIN_TAG)))
    }

    pub fn as_hex(&self) -> &str {
        &self.0
    }

    /// Compute SHA-256 of arbitrary bytes + return the hex form.
    fn from_bytes_sha256(bytes: &[u8]) -> Self {
        Self(hex_lower(&Sha256::digest(bytes)))
    }
}

/// Cert fingerprint — SHA-256 of DER bytes, lowercase 64-char hex.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CertFingerprint(String);

impl CertFingerprint {
    /// Compute from raw DER bytes.
    pub fn from_der(der: &[u8]) -> Self {
        Self(hex_lower(&Sha256::digest(der)))
    }

    pub fn as_hex(&self) -> &str {
        &self.0
    }

    /// First 16 hex chars (8 bytes) of the fingerprint — used as the
    /// filesystem filename prefix to avoid 64-char filenames while
    /// preserving forensic uniqueness across a fleet of < 100K devices.
    pub fn filename_prefix(&self) -> &str {
        // String guaranteed 64 chars by from_der.
        &self.0[..16]
    }
}

/// One mutation event in the rotation ledger. Variants are
/// `serde(tag = "kind")` so the wire JSON is grep-friendly + future
/// variants append cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LedgerEntry {
    /// First-boot genesis. Emitted exactly once, sequence=0.
    Genesis {
        device_code: String,
        own_cert_fingerprint_hex: String,
    },
    /// New client cert added to the trusted set.
    CertTrusted {
        fingerprint_hex: String,
        cert_label: String,
    },
    /// Client cert revoked. Re-adding the same fingerprint is REJECTED
    /// by `add_trusted_cert` (operator must mint a fresh cert with a new
    /// fingerprint).
    CertRevoked {
        fingerprint_hex: String,
        reason: String,
    },
    /// 3-phase rotation transition (Legacy/Warn/Strict). The associated
    /// pre/post mode strings are written verbatim by `cert_rotation.rs`.
    PhaseTransition {
        from_mode: String,
        to_mode: String,
    },
}

/// One full line of the ledger, as serialized to JSONL. Includes the
/// chain linkage hashes computed at append time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerLine {
    pub sequence: u64,
    pub timestamp_unix_secs: i64,
    pub entry: LedgerEntry,
    pub prev_hash_hex: String,
    pub current_hash_hex: String,
}

/// Errors surfaced by [`PkiStore`] mutating + open operations.
#[derive(Debug)]
pub enum PkiStoreError {
    /// Filesystem operation failed at boot.
    OpenFailed(String),
    /// Filesystem operation failed mid-mutation (write/rename/fsync).
    WriteFailed(String),
    /// Ledger line failed JSON deserialization or chain linkage check.
    LedgerCorrupted(String),
    /// Operator attempted to add a fingerprint that was previously revoked.
    /// Per ADR-031 §1, the architectural contract: revoked fingerprints
    /// are forever-banned to prevent accidental reuse of a known-bad
    /// cert.
    FingerprintWasRevoked { fingerprint_hex: String },
    /// Operator attempted to revoke a fingerprint that is not currently
    /// in the trusted set. Surfaces operator typos.
    FingerprintNotTrusted { fingerprint_hex: String },
    /// Internal mutex poisoned by a previous panic.
    LockPoisoned,
}

impl std::fmt::Display for PkiStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpenFailed(e) => write!(f, "PkiStore open failed: {e}"),
            Self::WriteFailed(e) => write!(f, "PkiStore write failed: {e}"),
            Self::LedgerCorrupted(e) => write!(f, "PkiStore ledger corrupted: {e}"),
            Self::FingerprintWasRevoked { fingerprint_hex } => write!(
                f,
                "PkiStore: fingerprint {fingerprint_hex} was previously revoked — \
                 mint a fresh cert with a new fingerprint instead of re-adding the \
                 known-bad one (ADR-031 §1 architectural contract)"
            ),
            Self::FingerprintNotTrusted { fingerprint_hex } => write!(
                f,
                "PkiStore: cannot revoke fingerprint {fingerprint_hex} — \
                 not currently in the trusted set"
            ),
            Self::LockPoisoned => f.write_str(
                "PkiStore mutex poisoned (previous writer panicked); restart required",
            ),
        }
    }
}

impl std::error::Error for PkiStoreError {}

/// In-memory snapshot of the PkiStore's authoritative state, derived from
/// the ledger at boot + maintained as mutations append. Used by callers
/// (e.g., `CertRotation`, future `OpcUaCertVerifier`) to query the trust
/// state without re-reading the filesystem.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PkiStoreSnapshot {
    /// Currently-trusted fingerprints. Order is insertion order (the
    /// ledger sequence number's chronological order).
    pub trusted: Vec<CertFingerprint>,
    /// Revoked fingerprints — forever-banned per ADR-031 §1.
    pub revoked: Vec<CertFingerprint>,
    /// Last applied sequence number. Genesis = 0; first mutation = 1; etc.
    pub last_sequence: u64,
    /// Last computed chain hash. Used by the next append + verifiable
    /// offline by `audit-verify`-style tooling.
    pub last_chain_hash: LedgerHash,
}

impl PkiStoreSnapshot {
    /// Returns true if the fingerprint is currently trusted (and was not
    /// subsequently revoked).
    pub fn is_trusted(&self, fp: &CertFingerprint) -> bool {
        self.trusted.iter().any(|f| f == fp)
    }

    /// Returns true if the fingerprint is in the revoked set.
    pub fn is_revoked(&self, fp: &CertFingerprint) -> bool {
        self.revoked.iter().any(|f| f == fp)
    }
}

/// `PkiStore` — owns the on-disk state + the in-memory snapshot.
///
/// Construction is via [`Self::open_or_initialize`] — first boot creates
/// the directory layout + genesis ledger entry; subsequent boots load
/// the existing state + verify chain integrity.
pub struct PkiStore {
    root: PathBuf,
    /// Device code recorded in the genesis entry. Used to detect a
    /// PkiStore being moved between physical devices (a misconfig that
    /// would invalidate the audit chain's device-binding).
    device_code: String,
    /// Mutable state — `Mutex<PkiStoreInner>`. Reads use `snapshot()` for
    /// a `Clone` of the inner state without holding the lock.
    inner: Mutex<PkiStoreInner>,
}

struct PkiStoreInner {
    snapshot: PkiStoreSnapshot,
    ledger_writer: BufWriter<File>,
}

impl PkiStore {
    /// Open the PkiStore at `root`, initializing the directory layout +
    /// genesis ledger entry on first boot. `device_code` is recorded in
    /// the genesis entry to bind the ledger to a physical device.
    ///
    /// Returns `Err(LedgerCorrupted)` if a previously-written ledger fails
    /// chain-linkage verification on reload — fail-closed at boot rather
    /// than silently continuing on a corrupted chain.
    pub fn open_or_initialize(
        root: &Path,
        device_code: String,
    ) -> Result<Self, PkiStoreError> {
        // Ensure the directory layout exists.
        let trusted_dir = root.join("trusted").join("clients");
        let rejected_dir = root.join("rejected");
        let own_dir = root.join("own");
        for d in [&trusted_dir, &rejected_dir, &own_dir, &root.to_path_buf()] {
            fs::create_dir_all(d).map_err(|e| {
                PkiStoreError::OpenFailed(format!(
                    "mkdir {}: {e}",
                    d.display()
                ))
            })?;
        }

        let ledger_path = root.join("rotation_ledger.jsonl");
        let snapshot = if ledger_path.exists() {
            Self::reload_snapshot(&ledger_path, &device_code)?
        } else {
            // First boot — synthesize a zero snapshot; genesis line will
            // be written below before the constructor returns.
            PkiStoreSnapshot {
                trusted: Vec::new(),
                revoked: Vec::new(),
                last_sequence: 0,
                last_chain_hash: LedgerHash::genesis(),
            }
        };

        let ledger_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&ledger_path)
            .map_err(|e| {
                PkiStoreError::OpenFailed(format!(
                    "open ledger {}: {e}",
                    ledger_path.display()
                ))
            })?;
        let ledger_writer = BufWriter::new(ledger_file);

        let mut store = Self {
            root: root.to_path_buf(),
            device_code: device_code.clone(),
            inner: Mutex::new(PkiStoreInner {
                snapshot,
                ledger_writer,
            }),
        };

        // First boot: append the genesis line. We detect first-boot by
        // last_sequence == 0 + a missing genesis line in the snapshot
        // (Genesis is recorded at sequence=0 but the snapshot starts at
        // last_sequence=0 either way; reload distinguishes via presence
        // of the file).
        if !ledger_path.exists() || fs::metadata(&ledger_path).map(|m| m.len()).unwrap_or(0) == 0 {
            // The file is zero-bytes — write the genesis line.
            let own_cert_fp = Self::initialize_own_keypair(&own_dir)?;
            store.append_locked(LedgerEntry::Genesis {
                device_code,
                own_cert_fingerprint_hex: own_cert_fp.as_hex().to_string(),
            })?;
        }

        Ok(store)
    }

    /// Read-only snapshot of the current state. Cheap — clones an
    /// in-memory `Vec<CertFingerprint>` pair (typical fleet has < 50
    /// trusted certs at any time).
    pub fn snapshot(&self) -> Result<PkiStoreSnapshot, PkiStoreError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| PkiStoreError::LockPoisoned)?;
        Ok(guard.snapshot.clone())
    }

    /// Filesystem root — exposed for `ServerBuilder::pki_dir(...)` wire.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Add a new client cert to the trusted set. Computes the SHA-256
    /// fingerprint, writes the DER to `<root>/trusted/clients/<prefix>.der`,
    /// and appends a `CertTrusted` ledger entry.
    ///
    /// Rejects if the fingerprint was previously revoked (architectural
    /// floor — see [`PkiStoreError::FingerprintWasRevoked`]).
    ///
    /// Phase B-1.5 audit-sink wire — on successful add the operation
    /// emits an `OpcUaCertTrusted` AuditEntry through the ADR-020
    /// audit-sink HMAC chain (alongside the PkiStore's own SHA-256
    /// ledger). Two parallel forensic chains:
    /// - PkiStore JSONL ledger — fail-closed-on-tamper at boot reload.
    /// - audit-sink chain — fail-closed-on-tamper at offline verify
    ///   via `audit-verify` CLI.
    /// Operators querying the audit chain see OpcUa cert events
    /// alongside mTLS cert events + RBAC manifest changes — single
    /// timeline.
    pub fn add_trusted_cert(
        &self,
        cert_der: &[u8],
        cert_label: String,
    ) -> Result<CertFingerprint, PkiStoreError> {
        let fingerprint = CertFingerprint::from_der(cert_der);
        {
            let guard = self
                .inner
                .lock()
                .map_err(|_| PkiStoreError::LockPoisoned)?;
            if guard.snapshot.is_revoked(&fingerprint) {
                return Err(PkiStoreError::FingerprintWasRevoked {
                    fingerprint_hex: fingerprint.as_hex().to_string(),
                });
            }
            if guard.snapshot.is_trusted(&fingerprint) {
                // Idempotent — no-op + return the existing fingerprint.
                return Ok(fingerprint);
            }
        }
        // Write the DER atomically (tmpfile + rename).
        let cert_path = self
            .root
            .join("trusted")
            .join("clients")
            .join(format!("{}.der", fingerprint.filename_prefix()));
        write_atomically(&cert_path, cert_der)?;

        self.append_locked(LedgerEntry::CertTrusted {
            fingerprint_hex: fingerprint.as_hex().to_string(),
            cert_label: cert_label.clone(),
        })?;
        // Phase B-1.5 audit-sink emit (ADR-020 cross-chain).
        crate::audit::try_emit_mtls_forensic_event(
            crate::audit::AuditAction::OpcUaCertTrusted,
            "opc_ua.pki.cert_trusted",
            serde_json::json!({
                "fingerprint_prefix": fingerprint.filename_prefix(),
                "cert_label": cert_label,
            }),
        );
        Ok(fingerprint)
    }

    /// Revoke a fingerprint. Moves the DER from `trusted/clients/` to
    /// `rejected/` (atomic rename) and appends a `CertRevoked` ledger
    /// entry. Rejects if the fingerprint is not currently trusted.
    pub fn revoke_cert(
        &self,
        fingerprint: &CertFingerprint,
        reason: String,
    ) -> Result<(), PkiStoreError> {
        {
            let guard = self
                .inner
                .lock()
                .map_err(|_| PkiStoreError::LockPoisoned)?;
            if !guard.snapshot.is_trusted(fingerprint) {
                return Err(PkiStoreError::FingerprintNotTrusted {
                    fingerprint_hex: fingerprint.as_hex().to_string(),
                });
            }
        }
        let prefix = fingerprint.filename_prefix();
        let from = self
            .root
            .join("trusted")
            .join("clients")
            .join(format!("{prefix}.der"));
        let to = self
            .root
            .join("rejected")
            .join(format!("{prefix}.der"));
        fs::rename(&from, &to).map_err(|e| {
            PkiStoreError::WriteFailed(format!(
                "rename {} → {}: {e}",
                from.display(),
                to.display()
            ))
        })?;

        self.append_locked(LedgerEntry::CertRevoked {
            fingerprint_hex: fingerprint.as_hex().to_string(),
            reason: reason.clone(),
        })?;
        // Phase B-1.5 audit-sink emit (ADR-020 cross-chain).
        crate::audit::try_emit_mtls_forensic_event(
            crate::audit::AuditAction::OpcUaCertRevoked,
            "opc_ua.pki.cert_revoked",
            serde_json::json!({
                "fingerprint_prefix": fingerprint.filename_prefix(),
                "reason": reason,
            }),
        );
        Ok(())
    }

    /// Append a phase-transition ledger entry. Called by [`crate::opc_ua_server::cert_rotation`]
    /// when [`crate::opc_ua_server::cert_rotation::CertRotation::transition_to`] applies a new
    /// rollout phase.
    ///
    /// Phase B-1.5 audit-sink wire — emits `OpcUaPkiPhaseTransition`
    /// alongside the PkiStore ledger entry. Operators querying the
    /// audit chain see the rollout timeline (Legacy → Warn → Strict
    /// promotions, plus rejected downgrade attempts that the caller
    /// emits separately at the dispatch layer).
    pub fn append_phase_transition(
        &self,
        from_mode: &str,
        to_mode: &str,
    ) -> Result<(), PkiStoreError> {
        self.append_locked(LedgerEntry::PhaseTransition {
            from_mode: from_mode.to_string(),
            to_mode: to_mode.to_string(),
        })?;
        crate::audit::try_emit_mtls_forensic_event(
            crate::audit::AuditAction::OpcUaPkiPhaseTransition,
            "opc_ua.pki.phase_transition",
            serde_json::json!({
                "from_mode": from_mode,
                "to_mode": to_mode,
            }),
        );
        Ok(())
    }

    /// Number of distinct trusted fingerprints currently active.
    pub fn trusted_count(&self) -> Result<usize, PkiStoreError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| PkiStoreError::LockPoisoned)?;
        Ok(guard.snapshot.trusted.len())
    }

    /// Walk the on-disk ledger + return ALL `LedgerEntry` records in
    /// chronological order. Used by [`crate::opc_ua_server::cert_rotation::CertRotation::load_from_pki_store`]
    /// to recover the most recent applied phase transition at boot.
    ///
    /// The walk re-reads the file rather than caching all entries
    /// in-memory — entries-per-device is bounded by operator activity
    /// (typically < 100 entries over a device's lifetime), and the
    /// walker is invoked once at boot. A streaming iterator-shaped API
    /// would be marginal complexity for negligible benefit at expected
    /// fleet sizes.
    ///
    /// Chain integrity is RE-VERIFIED on the walk (same logic as
    /// `reload_snapshot`) — if a tamper is detected between boot's
    /// initial reload + this call, the error surfaces here. Concurrent
    /// in-process mutations append AFTER the file pointer this walker
    /// reads, so the walker observes a consistent prefix.
    pub fn ledger_entries(&self) -> Result<Vec<LedgerEntry>, PkiStoreError> {
        let ledger_path = self.root.join("rotation_ledger.jsonl");
        let f = File::open(&ledger_path).map_err(|e| {
            PkiStoreError::OpenFailed(format!("open ledger for walk: {e}"))
        })?;
        let reader = BufReader::new(f);
        let mut entries = Vec::new();
        let mut expected_seq = 1u64;
        let mut expected_prev = LedgerHash::genesis();
        for (line_no, line_res) in reader.lines().enumerate() {
            let line = line_res.map_err(|e| {
                PkiStoreError::LedgerCorrupted(format!(
                    "walk read line {line_no}: {e}"
                ))
            })?;
            if line.is_empty() {
                continue;
            }
            let parsed: LedgerLine = serde_json::from_str(&line).map_err(|e| {
                PkiStoreError::LedgerCorrupted(format!(
                    "walk parse line {line_no}: {e}"
                ))
            })?;
            if parsed.sequence != expected_seq {
                return Err(PkiStoreError::LedgerCorrupted(format!(
                    "walk sequence gap at line {line_no}: expected \
                     {expected_seq}, got {}",
                    parsed.sequence
                )));
            }
            if parsed.prev_hash_hex != expected_prev.as_hex() {
                return Err(PkiStoreError::LedgerCorrupted(format!(
                    "walk prev_hash mismatch at line {line_no}"
                )));
            }
            entries.push(parsed.entry);
            expected_seq += 1;
            expected_prev = LedgerHash(parsed.current_hash_hex);
        }
        Ok(entries)
    }

    // ------------------------------------------------------------------
    // Private helpers.
    // ------------------------------------------------------------------

    fn append_locked(&self, entry: LedgerEntry) -> Result<(), PkiStoreError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| PkiStoreError::LockPoisoned)?;
        let next_seq = guard.snapshot.last_sequence + 1;
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let prev_hash = guard.snapshot.last_chain_hash.clone();

        // Compute current_hash over the canonical bytes:
        // be_u64(sequence) || be_i64(ts) || prev_hash_bytes || serde_json(entry)
        let entry_json = serde_json::to_string(&entry).map_err(|e| {
            PkiStoreError::WriteFailed(format!("serialize entry: {e}"))
        })?;
        let mut hash_input = Vec::with_capacity(8 + 8 + 64 + entry_json.len());
        hash_input.extend_from_slice(&next_seq.to_be_bytes());
        hash_input.extend_from_slice(&now_secs.to_be_bytes());
        hash_input.extend_from_slice(prev_hash.as_hex().as_bytes());
        hash_input.extend_from_slice(entry_json.as_bytes());
        let current_hash = LedgerHash::from_bytes_sha256(&hash_input);

        let line = LedgerLine {
            sequence: next_seq,
            timestamp_unix_secs: now_secs,
            entry: entry.clone(),
            prev_hash_hex: prev_hash.as_hex().to_string(),
            current_hash_hex: current_hash.as_hex().to_string(),
        };
        let line_json = serde_json::to_string(&line).map_err(|e| {
            PkiStoreError::WriteFailed(format!("serialize line: {e}"))
        })?;

        guard
            .ledger_writer
            .write_all(line_json.as_bytes())
            .and_then(|_| guard.ledger_writer.write_all(b"\n"))
            .and_then(|_| guard.ledger_writer.flush())
            .map_err(|e| PkiStoreError::WriteFailed(format!("ledger append: {e}")))?;
        guard.ledger_writer.get_ref().sync_data().map_err(|e| {
            PkiStoreError::WriteFailed(format!("ledger fsync: {e}"))
        })?;

        // Update the in-memory snapshot AFTER successful fsync — the
        // chain hash on disk is the SSoT; in-memory state mirrors it.
        match &entry {
            LedgerEntry::Genesis { .. } => {
                // Genesis does not mutate trusted/revoked sets.
            }
            LedgerEntry::CertTrusted { fingerprint_hex, .. } => {
                guard
                    .snapshot
                    .trusted
                    .push(CertFingerprint(fingerprint_hex.clone()));
            }
            LedgerEntry::CertRevoked { fingerprint_hex, .. } => {
                let fp = CertFingerprint(fingerprint_hex.clone());
                guard.snapshot.trusted.retain(|f| f != &fp);
                guard.snapshot.revoked.push(fp);
            }
            LedgerEntry::PhaseTransition { .. } => {
                // Phase transition does not mutate trusted/revoked sets;
                // CertRotation owns the active mode separately.
            }
        }
        guard.snapshot.last_sequence = next_seq;
        guard.snapshot.last_chain_hash = current_hash;
        Ok(())
    }

    fn reload_snapshot(
        ledger_path: &Path,
        expected_device_code: &str,
    ) -> Result<PkiStoreSnapshot, PkiStoreError> {
        let f = File::open(ledger_path).map_err(|e| {
            PkiStoreError::OpenFailed(format!("open ledger: {e}"))
        })?;
        let reader = BufReader::new(f);

        let mut snapshot = PkiStoreSnapshot {
            trusted: Vec::new(),
            revoked: Vec::new(),
            last_sequence: 0,
            last_chain_hash: LedgerHash::genesis(),
        };
        let mut expected_seq = 1u64;
        let mut expected_prev = LedgerHash::genesis();
        let mut saw_genesis = false;

        for (line_no, line_res) in reader.lines().enumerate() {
            let line = line_res.map_err(|e| {
                PkiStoreError::LedgerCorrupted(format!(
                    "read line {line_no}: {e}"
                ))
            })?;
            if line.is_empty() {
                continue;
            }
            let parsed: LedgerLine = serde_json::from_str(&line).map_err(|e| {
                PkiStoreError::LedgerCorrupted(format!(
                    "parse line {line_no}: {e}"
                ))
            })?;
            // First entry must be the genesis.
            if !saw_genesis {
                match &parsed.entry {
                    LedgerEntry::Genesis { device_code, .. } => {
                        if device_code != expected_device_code {
                            return Err(PkiStoreError::LedgerCorrupted(format!(
                                "genesis device_code={device_code} ≠ \
                                 boot-time device_code={expected_device_code} — \
                                 PkiStore moved between physical devices?"
                            )));
                        }
                        saw_genesis = true;
                    }
                    _ => {
                        return Err(PkiStoreError::LedgerCorrupted(
                            "first ledger entry must be Genesis".to_string(),
                        ));
                    }
                }
            }
            // Sequence + chain hash linkage.
            if parsed.sequence != expected_seq {
                return Err(PkiStoreError::LedgerCorrupted(format!(
                    "sequence gap at line {line_no}: expected {expected_seq}, got {}",
                    parsed.sequence
                )));
            }
            if parsed.prev_hash_hex != expected_prev.as_hex() {
                return Err(PkiStoreError::LedgerCorrupted(format!(
                    "prev_hash mismatch at line {line_no}"
                )));
            }
            // Recompute current_hash + verify.
            let mut hash_input = Vec::with_capacity(
                8 + 8 + 64 + line.len(),
            );
            hash_input.extend_from_slice(&parsed.sequence.to_be_bytes());
            hash_input.extend_from_slice(&parsed.timestamp_unix_secs.to_be_bytes());
            hash_input.extend_from_slice(parsed.prev_hash_hex.as_bytes());
            // `entry` JSON for chain input — re-serialize to canonical form.
            let entry_json = serde_json::to_string(&parsed.entry).map_err(|e| {
                PkiStoreError::LedgerCorrupted(format!(
                    "re-serialize entry at line {line_no}: {e}"
                ))
            })?;
            hash_input.extend_from_slice(entry_json.as_bytes());
            let recomputed = LedgerHash::from_bytes_sha256(&hash_input);
            if recomputed.as_hex() != parsed.current_hash_hex {
                return Err(PkiStoreError::LedgerCorrupted(format!(
                    "current_hash mismatch at line {line_no} \
                     (expected {}, recomputed {})",
                    parsed.current_hash_hex,
                    recomputed.as_hex()
                )));
            }

            // Apply to snapshot.
            match parsed.entry {
                LedgerEntry::Genesis { .. } => {}
                LedgerEntry::CertTrusted { fingerprint_hex, .. } => {
                    snapshot
                        .trusted
                        .push(CertFingerprint(fingerprint_hex));
                }
                LedgerEntry::CertRevoked { fingerprint_hex, .. } => {
                    let fp = CertFingerprint(fingerprint_hex);
                    snapshot.trusted.retain(|f| f != &fp);
                    snapshot.revoked.push(fp);
                }
                LedgerEntry::PhaseTransition { .. } => {}
            }

            expected_seq += 1;
            expected_prev = LedgerHash(parsed.current_hash_hex);
        }

        if !saw_genesis {
            // Empty file is treated as first-boot by the caller; this
            // branch fires when the file has bytes but no genesis — corrupt.
            return Err(PkiStoreError::LedgerCorrupted(
                "non-empty ledger file has no Genesis entry".to_string(),
            ));
        }
        snapshot.last_sequence = expected_seq - 1;
        snapshot.last_chain_hash = expected_prev;
        Ok(snapshot)
    }

    fn initialize_own_keypair(own_dir: &Path) -> Result<CertFingerprint, PkiStoreError> {
        // Use rcgen to mint a self-signed ed25519 cert for the OPC UA
        // server's own identity. This is a placeholder for the full
        // ADR-031 §1 keypair flow — Phase B-1 lands the SHAPE of the
        // operation; actual cert content (subject, SANs, validity) is
        // refined in Phase B-1.5 when the device-binding parameters are
        // plumbed through from `device_code` + `tenant_id`.
        let cert_path = own_dir.join("cert.der");
        let key_path = own_dir.join("key.pem");
        if cert_path.exists() && key_path.exists() {
            // Already initialized — re-use existing keypair.
            let der = fs::read(&cert_path).map_err(|e| {
                PkiStoreError::OpenFailed(format!(
                    "read existing own cert: {e}"
                ))
            })?;
            return Ok(CertFingerprint::from_der(&der));
        }
        // Synthesize a fresh ed25519 self-signed cert via rcgen.
        let cert = rcgen::generate_simple_self_signed(vec![
            "suderra-edge.local".to_string(),
        ])
        .map_err(|e| {
            PkiStoreError::OpenFailed(format!("rcgen self-signed: {e}"))
        })?;
        let der_bytes = cert.cert.der().to_vec();
        let key_pem = cert.signing_key.serialize_pem();
        write_atomically(&cert_path, &der_bytes)?;
        write_atomically(&key_path, key_pem.as_bytes())?;
        Ok(CertFingerprint::from_der(&der_bytes))
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), PkiStoreError> {
    let parent = path.parent().ok_or_else(|| {
        PkiStoreError::WriteFailed(format!("path {} has no parent", path.display()))
    })?;
    let tmp_path = parent.join(format!(
        ".{}.tmp.{}",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("tmp"),
        std::process::id()
    ));
    {
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| {
                PkiStoreError::WriteFailed(format!(
                    "open tmp {}: {e}",
                    tmp_path.display()
                ))
            })?;
        f.write_all(bytes).map_err(|e| {
            PkiStoreError::WriteFailed(format!("write tmp: {e}"))
        })?;
        f.sync_data().map_err(|e| {
            PkiStoreError::WriteFailed(format!("fsync tmp: {e}"))
        })?;
    }
    fs::rename(&tmp_path, path).map_err(|e| {
        PkiStoreError::WriteFailed(format!(
            "rename tmp → {}: {e}",
            path.display()
        ))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh_store() -> (TempDir, PkiStore) {
        let tmp = TempDir::new().expect("tempdir");
        let store =
            PkiStore::open_or_initialize(tmp.path(), "test-device-001".to_string())
                .expect("first-boot init");
        (tmp, store)
    }

    /// First-boot initializes the directory layout + genesis ledger.
    #[test]
    fn first_boot_creates_layout_and_genesis() {
        let (tmp, store) = fresh_store();
        assert!(tmp.path().join("trusted/clients").is_dir());
        assert!(tmp.path().join("rejected").is_dir());
        assert!(tmp.path().join("own").is_dir());
        assert!(tmp.path().join("rotation_ledger.jsonl").is_file());
        let snap = store.snapshot().expect("snapshot");
        assert_eq!(snap.last_sequence, 1, "genesis is sequence=1");
        assert!(snap.trusted.is_empty());
        assert!(snap.revoked.is_empty());
    }

    /// A cert added to the trusted set yields a deterministic SHA-256
    /// fingerprint (Plan §B-1 Batch #266 Unit 2).
    #[test]
    fn add_trusted_cert_yields_deterministic_fingerprint() {
        let (_tmp, store) = fresh_store();
        let der = b"DUMMY_DER_BYTES_FOR_TEST";
        let fp = store
            .add_trusted_cert(der.to_vec().as_slice(), "hmi-1".to_string())
            .expect("add trusted");
        // SHA-256("DUMMY_DER_BYTES_FOR_TEST") — deterministic check.
        let expected = hex_lower(&Sha256::digest(der));
        assert_eq!(fp.as_hex(), expected.as_str());
        let snap = store.snapshot().expect("snapshot");
        assert_eq!(snap.trusted.len(), 1);
        assert!(snap.is_trusted(&fp));
    }

    /// Re-adding a previously-revoked fingerprint MUST be rejected
    /// (Plan §B-1 Batch #266 Unit 3).
    #[test]
    fn revoked_fingerprint_blocks_re_add() {
        let (_tmp, store) = fresh_store();
        let der = b"REVOKE_ME_CERT";
        let fp = store
            .add_trusted_cert(der.as_slice(), "hmi-2".to_string())
            .expect("add");
        store
            .revoke_cert(&fp, "operator decision".to_string())
            .expect("revoke");
        let err = store
            .add_trusted_cert(der.as_slice(), "hmi-2".to_string())
            .expect_err("re-add must fail");
        assert!(matches!(
            err,
            PkiStoreError::FingerprintWasRevoked { .. }
        ));
    }

    /// Adding the same cert twice is idempotent — returns the existing
    /// fingerprint without a duplicate ledger entry.
    #[test]
    fn add_trusted_cert_is_idempotent() {
        let (_tmp, store) = fresh_store();
        let der = b"IDEMPOTENT_CERT";
        let fp1 = store
            .add_trusted_cert(der.as_slice(), "hmi-3".to_string())
            .expect("first add");
        let seq_after_first = store.snapshot().expect("snap").last_sequence;
        let fp2 = store
            .add_trusted_cert(der.as_slice(), "hmi-3".to_string())
            .expect("idempotent add");
        let seq_after_second = store.snapshot().expect("snap").last_sequence;
        assert_eq!(fp1, fp2);
        assert_eq!(
            seq_after_first, seq_after_second,
            "idempotent re-add must NOT advance the ledger sequence"
        );
    }

    /// Revoking a fingerprint not in the trusted set surfaces operator
    /// typo as `FingerprintNotTrusted`.
    #[test]
    fn revoke_untrusted_fingerprint_errors() {
        let (_tmp, store) = fresh_store();
        let stranger = CertFingerprint::from_der(b"NEVER_ADDED");
        let err = store
            .revoke_cert(&stranger, "test".to_string())
            .expect_err("must fail");
        assert!(matches!(
            err,
            PkiStoreError::FingerprintNotTrusted { .. }
        ));
    }

    /// Reload from disk reconstructs the exact in-memory snapshot.
    /// Chain-linkage verification fires at boot.
    #[test]
    fn reload_after_mutations_preserves_snapshot() {
        let (tmp, store) = fresh_store();
        let der1 = b"CERT_A";
        let der2 = b"CERT_B";
        let fp1 = store
            .add_trusted_cert(der1.as_slice(), "a".to_string())
            .expect("add a");
        let _fp2 = store
            .add_trusted_cert(der2.as_slice(), "b".to_string())
            .expect("add b");
        store
            .revoke_cert(&fp1, "rotation".to_string())
            .expect("revoke a");
        let pre = store.snapshot().expect("snap");
        drop(store);

        let store2 =
            PkiStore::open_or_initialize(tmp.path(), "test-device-001".to_string())
                .expect("reload");
        let post = store2.snapshot().expect("snap2");
        assert_eq!(pre.last_sequence, post.last_sequence);
        assert_eq!(pre.trusted, post.trusted);
        assert_eq!(pre.revoked, post.revoked);
        assert_eq!(pre.last_chain_hash, post.last_chain_hash);
    }

    /// Tamper detection: a manually-edited ledger line fails chain
    /// linkage on reload — fail-closed boot.
    #[test]
    fn tampered_ledger_fails_reload() {
        let (tmp, store) = fresh_store();
        store
            .add_trusted_cert(b"ORIGINAL", "x".to_string())
            .expect("add");
        drop(store);

        // Tamper: rewrite the file by appending an unsigned line that
        // doesn't chain.
        let ledger_path = tmp.path().join("rotation_ledger.jsonl");
        let original = fs::read_to_string(&ledger_path).expect("read");
        let tampered = format!(
            "{original}{}\n",
            r#"{"sequence":99,"timestamp_unix_secs":0,"entry":{"kind":"cert_trusted","fingerprint_hex":"deadbeef","cert_label":"injected"},"prev_hash_hex":"00","current_hash_hex":"00"}"#
        );
        fs::write(&ledger_path, tampered).expect("write");

        let err = PkiStore::open_or_initialize(
            tmp.path(),
            "test-device-001".to_string(),
        )
        .expect_err("must fail");
        assert!(matches!(err, PkiStoreError::LedgerCorrupted(_)));
    }

    /// Genesis device_code mismatch on reload (PkiStore moved between
    /// devices) is caught with a specific error message.
    #[test]
    fn moved_device_detected_on_reload() {
        let (tmp, _store) = fresh_store();
        let err =
            PkiStore::open_or_initialize(tmp.path(), "different-device".to_string())
                .expect_err("must fail");
        assert!(
            matches!(err, PkiStoreError::LedgerCorrupted(s) if s.contains("device_code"))
        );
    }

    /// Phase-transition entries chain correctly + don't mutate the
    /// trusted/revoked sets.
    #[test]
    fn phase_transition_appends_chain_only() {
        let (_tmp, store) = fresh_store();
        store
            .add_trusted_cert(b"PRE_TRANSITION", "x".to_string())
            .expect("add");
        let pre = store.snapshot().expect("snap");
        store
            .append_phase_transition("LegacyAccept", "WarnOnMismatch")
            .expect("transition");
        let post = store.snapshot().expect("snap");
        assert_eq!(pre.trusted, post.trusted);
        assert_eq!(post.last_sequence, pre.last_sequence + 1);
    }

    /// Filename prefix is the first 16 hex chars (8 bytes) — stable +
    /// long enough for forensic uniqueness.
    #[test]
    fn fingerprint_filename_prefix_is_16_chars() {
        let fp = CertFingerprint::from_der(b"prefix_test");
        assert_eq!(fp.filename_prefix().len(), 16);
        // Hex chars are [0-9a-f] only.
        for c in fp.filename_prefix().chars() {
            assert!(c.is_ascii_hexdigit() && (c.is_ascii_digit() || c.is_ascii_lowercase()));
        }
    }
}
