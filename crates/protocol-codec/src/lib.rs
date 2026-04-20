//! `protocol-codec` — drift-zero binary protocol parser SSoT.
//!
//! WHY this crate exists:
//!   Edge (`sens-api-gateway`) and cloud (`sensor-ingestion`) MUST agree on
//!   the exact bit-level interpretation of industrial protocol frames.
//!   A divergent parser silently corrupts telemetry. By exposing one Rust
//!   crate consumed by both, drift becomes a compile-time invariant
//!   rather than a field bug.
//!
//! WHAT lives here:
//!   - [`modbus`] — TCP frame decode (RTU + ASCII land in subsequent
//!     commits of the Faz 1 PR).
//!   - LoRaWAN, OPC-UA, S7, EtherNet/IP — Faz 1.x follow-on PRs.
//!
//! WHAT does NOT live here:
//!   - I/O (transport is the caller's job — `rumqttc`, `rodbus`, etc.).
//!   - Tenant context (see `tenant-context` crate).
//!   - Event publication (see `event-contracts-rs` + `nats-client`).
//!   - Persistence (caller decides COPY/INSERT semantics).

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]
// Tests get the same behaviour matrix as sens-api-gateway: the deny lints
// stay on for production code but unit tests are allowed to assert via
// unwrap / expect / panic / direct indexing. Doc tests are a separate
// compilation unit and must opt in to the same allow set inline (see
// modbus::tcp::parse_mbap_header for the canonical pattern).
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
    )
)]

pub mod error;
pub mod modbus;

pub use error::ParseError;

/// Crate version for diagnostic / drift-detection telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
