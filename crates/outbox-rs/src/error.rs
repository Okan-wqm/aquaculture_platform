//! [`OutboxError`] — every failure mode the outbox primitives can
//! surface to a caller. Variants are exhaustive on purpose: the
//! sensor-ingestion sidecar + the dispatcher task route operator
//! alarms by variant shape (transport, storage, encode, contract),
//! not by parsing log strings.

use thiserror::Error;

/// All ways an outbox operation can fail. Each variant carries the
/// source error where applicable, so the `source` chain preserves
/// postgres / serde / tokio detail for operator diagnostics.
#[derive(Debug, Error)]
pub enum OutboxError {
    /// The outbox row could not be serialised for persistence. In
    /// practice this fires only on OOM — the payload envelope is a
    /// small fixed-shape struct.
    #[error("outbox payload encode failed")]
    Encode(#[source] serde_json::Error),

    /// The outbox row could not be deserialised after read-back.
    /// Indicates the storage backend returned a payload that does not
    /// match the wire contract — a schema migration drift is the
    /// usual cause.
    #[error("outbox payload decode failed")]
    Decode(#[source] serde_json::Error),

    /// Storage-layer error. Each repository impl wraps its native
    /// error type here so callers can route on `OutboxError::Storage`
    /// without coupling to tokio-postgres / in-memory / future
    /// backend choice.
    ///
    /// The boxed-dyn-Error shape keeps `OutboxError` object-safe
    /// across the `dyn OutboxRepository` boundary while still
    /// carrying the full source chain to tracing.
    #[error("outbox storage backend failed")]
    Storage(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// The caller passed an event_type that is outside the platform
    /// whitelist (PascalCase, bounded length). Validated at the
    /// repository boundary so a malformed dispatcher subject cannot
    /// reach NATS.
    #[error("invalid event_type '{got}': must match {PASCAL_CASE_SPEC}")]
    InvalidEventType {
        /// The offending event_type. Bounded length (<=100 chars) so
        /// it is safe to echo.
        got: String,
    },

    /// A mark-dispatched / mark-failed call targeted an id that no
    /// longer exists in the outbox. Either the row was already
    /// deleted by the retention job, or another dispatcher removed
    /// it (should never happen under the single-dispatcher advisory-
    /// lock invariant, but the variant exists as defense-in-depth).
    #[error("outbox record id={id} not found")]
    RecordNotFound {
        /// The missing record id.
        id: uuid::Uuid,
    },
}

/// Contract the `InvalidEventType` error message references. Matches
/// the PascalCase + bounded-length check the repository enforces
/// before accepting an enqueue.
pub const PASCAL_CASE_SPEC: &str = "^[A-Z][A-Za-z0-9]{0,99}$";
