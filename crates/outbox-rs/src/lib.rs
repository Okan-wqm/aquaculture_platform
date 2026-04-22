//! Transactional Outbox primitive for Rust services.
//!
//! # Why this crate exists
//!
//! The sensor-ingestion sidecar (ADR-025) emits `SensorMetricIngested`
//! NATS events after writing each metric batch to TimescaleDB. Before
//! this crate, the emit path ran through an in-memory `mpsc` channel:
//! if the sidecar crashed with events queued in the channel — or if
//! NATS was briefly unavailable and the publisher loop logged + dropped
//! — those events vanished. The persistence write was committed but
//! downstream consumers (alert-engine, AI service) never saw them.
//!
//! ADR-029 pins the fix: **Transactional Outbox**. The sidecar writes
//! the outbox row in the same postgres transaction as the metric COPY.
//! A separate dispatcher task claims pending rows with `FOR UPDATE
//! SKIP LOCKED`, publishes to NATS, and marks them dispatched. The
//! persistence-write and the publish-intent are atomic by PG TX
//! contract; delivery becomes at-least-once and consumers are
//! expected to de-dupe by `event_id`.
//!
//! # Scope
//!
//! - [`OutboxRecord`] — the in-memory shape of a queued event.
//! - [`OutboxStatus`] — pending / dispatched / dead-lettered discriminator.
//! - [`OutboxError`] — all failure modes surfaced by the primitives.
//! - [`OutboxRepository`] — the async trait every storage backend
//!   implements. `PgOutboxRepository` (added in a follow-up commit)
//!   targets tokio-postgres; `InMemoryOutboxRepository` (feature-
//!   gated, test-only) targets unit tests that do not need a live PG.
//!
//! # Follow-up commits in the ADR-029 series (planned)
//!
//! Each of these lands as a discrete commit on the same branch,
//! preserving commit-by-commit reviewability. The plan phase is
//! `/root/.claude/plans/snappy-sniffing-pine.md` Kör Nokta 7 —
//! PR-B finding #14 parts 2b through 2d.
//!
//! - The PG-backed repository impl (part 2b) adds the `pg` module
//!   and binds to tokio-postgres. Keeping this crate PG-dep-free
//!   until then lets the trait-shape review stay focused on the
//!   contract rather than SQL details.
//! - The `OutboxDispatcher` async task (part 2c) adds claim +
//!   publish + mark + backoff + DLQ counter wiring on top of the
//!   trait + the PG impl.
//! - The `OutboxMaintenance` retention job (also part 2c) brings
//!   nightly cleanup + pending-count gauge emission.
//! - The sensor-ingestion integration (part 2d) wires
//!   `write_tenant_batch` enqueue + replaces the in-memory
//!   `events.rs` mpsc path. The cut-over is atomic with the
//!   dispatcher landing so a transitional enqueue-without-dispatcher
//!   state cannot ship.

#![forbid(unsafe_code)]
#![cfg_attr(not(test), deny(missing_docs))]
// Tests drive the primitives with asserted-valid inputs + controlled
// panics; the workspace-wide unwrap/expect/panic/indexing denies are
// production guards, not test-harness constraints.
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::no_effect_underscore_binding,
    )
)]

pub mod error;
pub mod pg;
pub mod record;
pub mod repository;

pub use error::OutboxError;
pub use pg::PgOutboxRepository;
pub use record::{DLQ_THRESHOLD, OutboxRecord, OutboxStatus};
pub use repository::{ClaimBatch, OutboxRepository, encode_payload};
