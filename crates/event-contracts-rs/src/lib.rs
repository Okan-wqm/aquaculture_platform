//! `event-contracts-rs` — Rust side of `@platform/event-contracts`.
//!
//! WHY this crate exists:
//!   Event interfaces and JSON Schema validators live in
//!   `libs/event-contracts/src/` (TypeScript SSoT). The Rust ingestion sidecar
//!   must publish event payloads byte-equivalent to those NestJS produces, so
//!   downstream services (alert-engine, AI, audit) cannot tell whether the
//!   producer was Rust or Node. Drift here = silent data divergence.
//!
//! Strategy:
//!   - JSON Schema (TS SSoT) is treated as the contract.
//!   - `build.rs` (planned, Faz 2) runs `typify` to generate strongly-typed
//!     Rust structs from the schema.
//!   - `BaseEvent` carries a branded `EventId` newtype — `Default` is NOT
//!     implemented; construction goes through `EventBuilder::new(...)`.
//!   - ADR-006 flat pattern is structurally enforced — `serde(flatten)`
//!     usage is banned via clippy lint.
//!
//! Faz 0 status: skeleton crate. Codegen pipeline + structs land in Faz 2.
//! See `docs/plans/sensor-rust-migration/PLAN.md`.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]

/// Crate version for diagnostic telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
