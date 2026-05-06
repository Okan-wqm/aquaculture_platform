//! Cross-cutting IO primitives shared by multiple
//! sidecar-persisting modules (Batch #338 — closes
//! audit MEDIUM-004 finding).
//!
//! ## Why this module exists
//!
//! Pre-Batch-#338 the agent had TWO copies of the same
//! atomic-JSON-sidecar write pattern:
//!
//!   - `keystore::rotation_marker_store::write_marker`
//!     (Batch #316 — keystore rotation deadline).
//!   - `db_migration::manifest::write_manifest`
//!     (Batch #329 — SQLCipher key-source manifest).
//!
//! Both implemented the same 5-step crash-safety dance:
//!
//!   1. Ensure parent directory exists.
//!   2. Serialize the payload to JSON.
//!   3. Write to a temp file in the same directory.
//!   4. fsync the temp file (data + metadata durable).
//!   5. Rename temp over target.
//!
//! The auth-security-expert + edge-industrial-auditor
//! follow-up audit on Batch #335 flagged that BOTH copies
//! were missing the SIXTH step required for full POSIX
//! atomicity:
//!
//!   6. fsync the PARENT DIRECTORY so the rename's
//!      directory entry is durable.
//!
//! Without step 6 a power loss between the rename + the
//! directory's journal flush can leave the directory
//! entry pointing nowhere on ext4 with `data=writeback`
//! mount option. The failure mode for both consumers is
//! "manifest disappears after power loss → next boot
//! treats DB as missing-manifest = legacy v1 default" —
//! safe (fail-closed), but causes operator-visible
//! confusion + unnecessary migration backlog noise.
//!
//! ## Architectural fix — Tier-1 SSoT helper
//!
//! Adding step 6 inline at BOTH consumer sites would be
//! duplication-as-patch (banned by CLAUDE.md). The
//! correct architectural shape is a shared SSoT helper
//! that owns the full 6-step dance + the consumers
//! delegate. Both consumers retain their domain-specific
//! envelope handling (schema_version, JSON shape); only
//! the FS dance moves.
//!
//! ## Module layout
//!
//! - `atomic_json_sidecar` — the SSoT helper:
//!   `write_atomic_json::<T>(path, &T) -> Result<(),
//!   AtomicJsonWriteError>` where `T: Serialize`.
//!
//! Future cross-cutting IO primitives (e.g., a shared
//! atomic-text-write or atomic-binary-write) land as
//! sibling modules under `shared_io::`.
//!
//! ## What this module does NOT cover
//!
//! - Reading sidecars — each consumer's read path has
//!   different deserialization + envelope-version
//!   handling; sharing the read would force a generic
//!   that doesn't carry value.
//! - Non-atomic writes — best-effort writes with no
//!   crash-safety belong in `std::fs` directly.

pub mod atomic_json_sidecar;
