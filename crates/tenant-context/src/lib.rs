//! `tenant-context` — compile-time tenant isolation primitives.
//!
//! WHY this crate exists:
//!   The platform is multi-tenant with strict schema-per-tenant isolation
//!   (ADR-011). The TS side enforces tenant boundary at runtime via
//!   `getScopedRepository()` + middleware. The Rust ingestion path needs the
//!   same guarantee but better — at compile time.
//!
//!   `TenantId(Uuid)` and `SchemaName` are opaque newtypes; `Scoped<'t, T>`
//!   lifetime-binds a value to a specific `TenantCtx`. Mixing values from two
//!   tenant contexts inside one scope fails to compile (GhostCell pattern).
//!   This is the highest tier of the architectural-solution hierarchy:
//!   "Make it impossible".
//!
//! WHAT lives here (planned):
//!   - `TenantId(Uuid)`        — opaque newtype, parses strict 36-byte UUID
//!   - `SchemaName(String)`    — whitelist-validated PostgreSQL identifier
//!   - `TenantCtx`             — runtime context; cert CN → TenantId mapping
//!   - `Scoped<'t, T>`         — lifetime-branded wrapper
//!
//! Faz 0 status: skeleton crate, types implemented in Faz 2.
//! See `docs/plans/sensor-rust-migration/PLAN.md`.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]

/// Crate version for diagnostic telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
