//! [`OutboxRecord`] + [`OutboxStatus`] — the in-memory shape of a
//! queued event. The storage backend maps between this type and its
//! native row format; callers never see raw postgres rows.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tenant_context::TenantId;
use uuid::Uuid;

/// One queued event. Matches the `sensor.event_outbox` DDL
/// (migration `1786000200000-CreateSensorEventOutbox`) column-for-
/// column, with the postgres-side TIMESTAMPTZ types mapped to
/// `DateTime<Utc>` and JSONB mapped to `serde_json::Value`.
///
/// # Identity
/// The `id` is UUID v4 generated at insert time (postgres-side
/// `gen_random_uuid()`) so a caller cannot predict the id it will
/// receive — useful for the "claim with a returning id" pattern the
/// repository uses.
///
/// # Mutability
/// `OutboxRecord` is immutable once constructed. The dispatcher
/// does not mutate a record it holds — it issues a separate
/// `mark_dispatched` / `mark_failed` call with the id. This keeps
/// the in-memory / PG views of the same record from diverging.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxRecord {
    /// Opaque record id, assigned at enqueue time.
    pub id: Uuid,
    /// Tenant the event belongs to. Always present — schema-per-tenant
    /// isolation extends to the outbox table via the same tenant_id
    /// NOT NULL invariant.
    pub tenant_id: TenantId,
    /// Event discriminator in PascalCase (`SensorMetricIngested`,
    /// `SensorCalibrated`, ...). Validated against [`PASCAL_CASE_SPEC`]
    /// at the repository boundary; a malformed value cannot reach
    /// the database.
    ///
    /// [`PASCAL_CASE_SPEC`]: crate::error::PASCAL_CASE_SPEC
    pub event_type: String,
    /// Full event payload as JSON. The dispatcher publishes this
    /// verbatim — no per-dispatch transformation.
    pub payload: serde_json::Value,
    /// Monotonic wall-clock timestamp of the enqueue. Postgres writes
    /// `DEFAULT NOW()` so every row has a server-side ordered
    /// created_at.
    pub created_at: DateTime<Utc>,
    /// Current dispatch status. Derived from `dispatched_at` and
    /// `dispatch_attempts` on read-back; not a separate column.
    pub status: OutboxStatus,
    /// Number of failed dispatch attempts. 0 on fresh enqueue, incremented
    /// by the dispatcher on every `mark_failed`.
    pub dispatch_attempts: u32,
    /// Last attempt wall-clock. Drives exponential backoff in the
    /// dispatcher's claim filter.
    pub last_attempted_at: Option<DateTime<Utc>>,
    /// Truncated error description from the most recent failed attempt.
    /// Bounded by the repository impl (<=2000 chars) so a pathological
    /// error cannot grow the row unboundedly.
    pub last_error: Option<String>,
}

/// Lifecycle state of an [`OutboxRecord`]. Derived from the storage
/// columns; carried explicitly in the in-memory type so a consumer
/// can pattern-match without re-checking `dispatched_at.is_some()`
/// every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxStatus {
    /// Not yet dispatched. `dispatched_at IS NULL` AND
    /// `dispatch_attempts < DLQ_THRESHOLD`.
    Pending,
    /// Successfully published to NATS. `dispatched_at IS NOT NULL`.
    /// Retention job deletes after the published-age threshold
    /// (default 7 days; configured by the maintenance task).
    Dispatched,
    /// Exceeded `DLQ_THRESHOLD` failed attempts.
    /// `dispatched_at IS NULL` AND `dispatch_attempts >= DLQ_THRESHOLD`.
    /// Stays in the outbox indefinitely for operator review; not
    /// auto-deleted by the retention job.
    DeadLettered,
}

/// Maximum number of failed dispatch attempts before a record is
/// considered dead-lettered. Matches the ADR-029 threshold.
pub const DLQ_THRESHOLD: u32 = 10;

impl OutboxStatus {
    /// Derive the status from the raw storage columns. Single source
    /// of truth for the PG → enum mapping; repository impls call this
    /// rather than open-coding the condition.
    ///
    /// Rules:
    ///   - `dispatched_at IS NOT NULL` → Dispatched (takes precedence;
    ///     a row that was dispatched after N failed attempts is still
    ///     Dispatched, not DeadLettered).
    ///   - `dispatch_attempts >= DLQ_THRESHOLD` → DeadLettered.
    ///   - Otherwise → Pending.
    #[must_use]
    pub const fn derive(dispatched_at: Option<DateTime<Utc>>, dispatch_attempts: u32) -> Self {
        if dispatched_at.is_some() {
            Self::Dispatched
        } else if dispatch_attempts >= DLQ_THRESHOLD {
            Self::DeadLettered
        } else {
            Self::Pending
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DLQ_THRESHOLD, OutboxStatus};
    use chrono::Utc;

    #[test]
    fn derive_pending_when_dispatched_at_null_and_under_threshold() {
        assert_eq!(OutboxStatus::derive(None, 0), OutboxStatus::Pending);
        assert_eq!(OutboxStatus::derive(None, 5), OutboxStatus::Pending);
        assert_eq!(
            OutboxStatus::derive(None, DLQ_THRESHOLD - 1),
            OutboxStatus::Pending
        );
    }

    #[test]
    fn derive_dead_lettered_at_and_above_threshold_when_dispatched_at_null() {
        assert_eq!(
            OutboxStatus::derive(None, DLQ_THRESHOLD),
            OutboxStatus::DeadLettered,
        );
        assert_eq!(
            OutboxStatus::derive(None, DLQ_THRESHOLD + 50),
            OutboxStatus::DeadLettered,
        );
    }

    #[test]
    fn derive_dispatched_takes_precedence_over_attempts() {
        // A record that was eventually dispatched after N-1 failures
        // must surface as Dispatched, NOT DeadLettered, regardless of
        // the attempt counter. Operator alarms on DeadLettered must
        // not fire for a row that actually reached NATS.
        let now = Some(Utc::now());
        assert_eq!(OutboxStatus::derive(now, 0), OutboxStatus::Dispatched);
        assert_eq!(
            OutboxStatus::derive(now, DLQ_THRESHOLD),
            OutboxStatus::Dispatched,
        );
        assert_eq!(
            OutboxStatus::derive(now, DLQ_THRESHOLD + 100),
            OutboxStatus::Dispatched,
        );
    }

    #[test]
    fn dlq_threshold_matches_adr_029() {
        // ADR-029 pins the threshold at 10. A drift here would change
        // how long a failing event stays re-tryable before landing in
        // DLQ; the const is the single source of truth. This test
        // anchors the number so an accidental bump fails loudly.
        assert_eq!(DLQ_THRESHOLD, 10);
    }
}
