//! `protocol-codec` — drift-zero binary protocol parser SSoT.
//!
//! WHY this crate exists:
//!   Edge (`sens-api-gateway`) and cloud (`sensor-ingestion`) MUST agree on the
//!   exact bit-level interpretation of industrial protocol frames. A divergent
//!   parser silently corrupts telemetry. By exposing one Rust crate consumed
//!   by both, drift becomes a compile-time invariant rather than a field bug.
//!
//! WHAT lives here:
//!   - `modbus`     — TCP/RTU/ASCII frame decode + CRC-16 (planned: Faz 1)
//!   - `lorawan`    — PHY decrypt + FPort routing       (planned: Faz 1.x)
//!   - `opcua_node` — Node-id binary encoding           (planned: Faz 1.x)
//!   - `s7_db`      — Siemens S7 DB read/write          (planned: Faz 1.x)
//!   - `ethernet_ip_cip` — Allen-Bradley CIP            (planned: Faz 1.x)
//!
//! WHAT does NOT live here:
//!   - I/O (transport is the caller's job — `rumqttc`, `rodbus`, etc.)
//!   - Tenant context (see `tenant-context` crate)
//!   - Event publication (see `event-contracts-rs` + `nats-client`)
//!   - Persistence (caller decides COPY/INSERT semantics)
//!
//! Faz 0 status: skeleton crate, no protocol modules implemented.
//! See `docs/plans/sensor-rust-migration/PLAN.md` for the full migration plan.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]

/// Crate version for diagnostic / drift-detection telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
