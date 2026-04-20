//! `nats-client` — opinionated `async-nats` factory.
//!
//! WHY this crate exists:
//!   ADR-014/015 establish that NATS identity comes ONLY from the mTLS client
//!   certificate CN. user/pass and token auth are forbidden. Every Rust
//!   service that talks to NATS must enforce this invariant; centralising the
//!   factory means individual call-sites cannot drift.
//!
//!   The connection-builder API in this crate intentionally lacks any
//!   `with_user_pass(...)` / `with_token(...)` constructor. Adding one
//!   requires editing this crate (and would surface in code review).
//!   Architectural-solution tier 1: "Make it impossible".
//!
//!   Each service is provisioned in `infrastructure/nats/services.yaml`
//!   (single source of truth, ADR-015). Adding a new service = edit
//!   `services.yaml` + mint cert CN + run `scripts/nats/generate-nats-conf.py`
//!   in the same commit. CI invariant
//!   `e2e/tests/integration/nats-invariants.spec.ts` enforces it.
//!
//! Faz 0 status: skeleton crate. Connection factory + cert loader land in
//! Faz 2 alongside `sensor-ingestion`.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]

/// Crate version for diagnostic telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
