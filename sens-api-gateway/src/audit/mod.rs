// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

//! # Audit — append-only signed audit log (ADR-020)
//!
//! The audit module is the edge agent's **primary forensic surface**. Every
//! regulated action (command execution, RBAC manifest change, force_value,
//! firmware deploy, safe-state trigger, PII field access) emits a pre-execution
//! audit entry AND a post-execution audit entry. Entries are chained via
//! HMAC-SHA256 so tamper is structurally detectable offline by the
//! `audit-verify` CLI (Sprint 6.2).
//!
//! ## Architectural position
//!
//! | Layer | Concern | File |
//! |-------|---------|------|
//! | 1. AuditEntry data model | What fields belong in one audit record | [`entry`] |
//! | 2. Canonical bytes | Deterministic serialization for HMAC input | [`entry`] `AuditEntry::canonical_bytes` |
//! | 3. HMAC chain | `prev_hmac || entry_bytes -> current_hmac` | [`chain`] |
//! | 4. Sink / rotation | `/var/log/suderra/audit.log` append + fsync | Sprint 6.2 `sink.rs` |
//! | 5. Cloud relay | MQTT `edge/{device_id}/audit` publish | Sprint 6.2 `relay.rs` |
//! | 6. audit-verify CLI | Offline chain integrity re-compute | Sprint 6.2 `cli_verify.rs` |
//!
//! Batch 6 delivers layers 1-3 as pure types + one pure function (HMAC chain
//! append signature with closure-injected HMAC computation). Runtime sink +
//! relay + CLI land in Sprint 6.2.
//!
//! ## Why HMAC chain (not plain signatures)?
//!
//! A per-entry signature would require an online HSM call per event — 100us
//! ARM cost × N hundred events/day = operational friction. HMAC-SHA256 with
//! a master-derived chain key (`KeyPurpose::AuditHmacChain` per Batch 4b) gives
//! O(1) append + tamper-evident chain in O(N) offline verify. Cloud-side
//! correlation with a daily ed25519-signed anchor (ADR-020 §4) gives
//! non-repudiation for regulatory audit.
//!
//! ## Cross-references
//!
//! - ADR-020 §1 Pre+Post audit entry pattern
//! - ADR-020 §2 Master-key-derived HMAC chain
//! - ADR-020 §3 Canonical bytes length-prefix framing (same discipline as Batch 4b/5b)
//! - ADR-020 §4 Daily ed25519 anchor (cloud-side, not edge-side)
//! - ADR-020 §6 Append-only `/var/log/suderra/audit.log` + fsync
//! - Batch 4b `KeyPurpose::AuditHmacChain` hkdf info string

pub mod chain;
pub mod entry;
// Batch 74 Sprint 6.2 Phase 2: runtime sink — file append +
// HMAC chain state + NDJSON serialization. Chain recovery on
// restart + SIGHUP rotation + cloud relay land in follow-up
// batches; this module is the foundation layer.
pub mod sink;

pub use chain::{
    append_entry,
    compose_hmac_input,
    CurrentHmac,
    HmacChainError,
    HmacChainEntry,
    PrevHmac,
};

pub use sink::{AuditHmacKey, AuditSink, AuditSinkError};

pub use entry::{
    AuditAction,
    AuditActor,
    AuditEntry,
    AuditEntryCanonicalBytesError,
    AuditOutcome,
    AuditPhase,
    AuditResource,
    MAX_ACTOR_LABEL_BYTES,
    MAX_CORRELATION_ID_BYTES,
    MAX_DETAIL_BYTES,
};
