// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

//! # CommandEnvelope — Zero-Trust command dispatch wire format
//!
//! Per plan §4.10 Zero-Trust Command Model:
//!
//! > Session kavramı yok — her komut ayrı ed25519 signed.
//! > jti (JWT ID) dedup 72-saat sliding window.
//! > Replay cache Moka + SQLCipher persistence (reboot'ta kaybolmaz).
//! > Signed envelope: `{ cmd, params, actor, tenant_id, iat, exp, jti, nonce, sig }`.
//!
//! Every command arriving over MQTT / HTTP is wrapped in a
//! [`envelope::CommandEnvelope`]. The envelope carries a single-use ed25519
//! signature over deterministic canonical bytes; the edge verifies:
//!
//! 1. Signature format (64 bytes exactly — `Ed25519SignatureBytes`).
//! 2. Signature cryptographic validity against the operator's pubkey
//!    (from the verified RBAC manifest, Batch 5b).
//! 3. jti uniqueness in a 72-hour sliding window (replay defense).
//! 4. `iat <= now <= exp` freshness window.
//! 5. `cmd_hash == SHA-256(canonical_params(cmd, params))` binds the
//!    command + params to the signature.
//! 6. `tenant_id == edge_device_tenant` — cross-tenant pivot defense.
//!
//! ## Module layout
//!
//! - [`envelope`] — `CommandEnvelope` wire-format + `SignatureMode` state
//!   machine (Disabled | Permissive | Enforcing) per plan §2 HC-6 rollout
//!   discipline + `EnvelopeVerifyError` taxonomy.
//! - [`canonical`] — `canonical_params(cmd_name, params)` deterministic
//!   serialization + `cmd_hash` SHA-256 (closure-injected).
//! - [`jti`] — `Jti` newtype + `JtiDedupTable` trait + `DedupResult`
//!   enum. Runtime impl (Moka 60s + SQLCipher 72h persistence) lands in
//!   Sprint 6.4.
//! - [`mutating`] — `is_mutating(cmd_name)` predicate over the 26-command
//!   mutating list. In Enforcing mode, only mutating commands REQUIRE
//!   signature; read-only commands can be unsigned.
//!
//! ## Scope of Batch 7
//!
//! Types + canonical-bytes function + predicate. No actual ed25519 verify
//! (done by `authz::verify_manifest` closure pattern extended to envelopes
//! in Sprint 6.1), no Moka cache, no SQLCipher persistence. Those land in
//! Sprint 6.4 with the keystore runtime.
//!
//! ## Cross-references
//!
//! - Plan §4.10 Zero-Trust Command Model
//! - Plan §2 HC-6 feature-flag rollout (Disabled/Permissive/Enforcing states)
//! - ADR-018 §7 per-operator ed25519 signing key
//! - ADR-020 §5 envelope signature + jti in audit entry
//! - Batch 5a `Ed25519SignatureBytes` validated newtype (reused here)
//! - Batch 5b `verify_manifest` closure-injection precedent

pub mod canonical;
pub mod envelope;
pub mod handler;
pub mod jti;
pub mod moka_dedup;
pub mod mutating;
// Batch 91 Sprint 6.4 full wire tier 2: SQLCipher-persistent
// 72h dedup store. Closes the reboot-survives-envelope-
// lifetime replay gap left by Moka-only (in-memory) tier.
pub mod sqlcipher_dedup;
// Batch 92 Sprint 6.4 full wire composite: Moka hot-tier +
// SQLCipher persistent tier layered dedup. Fast-path hits
// Moka (microseconds); Moka-miss falls through to SQLCipher
// (catches cross-restart replays).
pub mod layered_dedup;

pub use canonical::{canonical_params, CanonicalParamsError, CmdHash};
pub use envelope::{
    verify_envelope, CommandEnvelope, EnvelopeVerifyError, SignatureMode,
    MAX_CMD_NAME_BYTES, MAX_NONCE_BYTES,
};
pub use handler::{
    EnvelopeHandler, EnvelopeMeta, HandlerError, HandlerInput, HandlerResponse,
};
pub use jti::{DedupResult, DedupTableError, InvalidJti, Jti, JtiDedupTable, MAX_JTI_BYTES};
pub use moka_dedup::{MokaJtiDedupTable, DEFAULT_MOKA_CAPACITY, DEFAULT_MOKA_TTL_SECS};
pub use mutating::{is_mutating, MUTATING_COMMANDS};
pub use sqlcipher_dedup::SqlCipherJtiDedupTable;
pub use layered_dedup::LayeredJtiDedupTable;
