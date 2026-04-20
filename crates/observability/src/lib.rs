//! `observability` — Rust-side tracing + OTLP + Prometheus init.
//!
//! WHY this crate exists:
//!   The TS side (`@platform/backend-common`) already pushes structured logs
//!   and OTel traces to a shared collector. Rust services must produce
//!   compatible spans + attributes so a single dashboard correlates a
//!   `traceparent` propagated through MQTT (v5 user property) and NATS
//!   (header `Nats-Trace-Context`) end-to-end.
//!
//!   PII safety:
//!     - All log fields default to `Display` masking; secrets wrapped in
//!       `secrecy::Secret<T>`. Custom `Layer` enforces masking semantics
//!       equivalent to `maskPii()` in the NestJS `StructuredLoggerService`.
//!
//! Faz 0 status: skeleton crate. Init function + masking layer land in
//! Faz 2 alongside `sensor-ingestion`.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(not(test), deny(missing_docs))]

/// Crate version for diagnostic telemetry.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
