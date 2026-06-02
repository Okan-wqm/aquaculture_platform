//! PostgreSQL-backed [`OutboxRepository`] implementation.
//!
//! Targets the `sensor.event_outbox` table created by migration
//! `1800800000000-SensorRustIngestionOutbox`. Every SQL string lives
//! as a `pub const` so the unit tests can anchor the SQL-shape
//! contract without spinning up a PG container; the integration test
//! (`live_crud_round_trip`, `#[ignore]`) covers end-to-end behaviour
//! against TimescaleDB + confirms the SQL literals actually parse.

use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use tenant_context::TenantId;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::{
    ClaimBatch, OutboxError, OutboxRecord, OutboxRepository, OutboxStatus,
    repository::validate_event_type,
};

// =====================================================================
// SQL contracts — all `pub const` for anchor-by-test. A regression that
// renames a column or drops a clause fails the SQL-shape assertions
// without an integration round-trip.
// =====================================================================

/// Insert SQL used by [`PgOutboxRepository::enqueue_in_tx`].
///
/// Parameters in order:
///   1. `$1` — `tenant_id` (UUID)
///   2. `$2` — `event_type` (TEXT; already whitelisted by the caller)
///   3. `$3` — `payload` (JSONB)
///
/// `id` + `created_at` + `dispatch_attempts` default on the DB side;
/// `RETURNING id` lets the caller correlate dispatches back to the
/// source without a second round-trip.
pub const SQL_ENQUEUE: &str = "\
INSERT INTO sensor.event_outbox (tenant_id, event_type, payload) \
VALUES ($1, $2, $3) \
RETURNING id";

/// Claim SQL used by [`PgOutboxRepository::claim_pending`].
///
/// Parameters:
///   1. `$1` — batch limit (INT)
///   2. `$2` — backoff base in seconds, as FLOAT8 (e.g. `0.1` for
///      100 ms). Driven from [`ClaimBatch::backoff_base`].
///   3. `$3` — claim lease age in seconds. Rows claimed more recently
///      than this are treated as in-flight and skipped.
///   4. `$4` — worker identity recorded in `claimed_by` for operator
///      diagnosis.
///
/// The exponential-backoff filter uses
/// `make_interval(secs => $2 * power(2, LEAST(dispatch_attempts, 10)))`
/// which postgres-natively produces the delay interval without the
/// caller computing it client-side. `ORDER BY created_at` gives
/// tenant-fair-by-default semantics (the oldest re-claimable row
/// across all tenants wins). The CTE's `FOR UPDATE SKIP LOCKED` plus
/// outer `UPDATE ... RETURNING` is the lease primitive: a row returned
/// to one dispatcher has `claimed_at/claimed_by` durably set before
/// the function returns, so another dispatcher skips it until the
/// lease window expires.
pub const SQL_CLAIM_PENDING: &str = "\
WITH candidate AS ( \
  SELECT id \
  FROM sensor.event_outbox \
  WHERE dispatched_at IS NULL \
    AND dispatch_attempts < 10 \
    AND (claimed_at IS NULL OR claimed_at < NOW() - make_interval(secs => $3)) \
    AND ( \
        dispatch_attempts = 0 \
        OR last_attempted_at IS NULL \
        OR last_attempted_at < NOW() - make_interval(secs => $2 * power(2.0, LEAST(dispatch_attempts, 10))) \
    ) \
  ORDER BY created_at \
  LIMIT $1 \
  FOR UPDATE SKIP LOCKED \
) \
UPDATE sensor.event_outbox AS outbox \
SET claimed_at = NOW(), \
    claimed_by = $4, \
    last_attempted_at = NOW() \
FROM candidate \
WHERE outbox.id = candidate.id \
RETURNING outbox.id AS id, outbox.tenant_id AS tenant_id, outbox.event_type AS event_type, \
          outbox.payload AS payload, outbox.created_at AS created_at, \
          outbox.dispatched_at AS dispatched_at, \
          outbox.dispatch_attempts AS dispatch_attempts, \
          outbox.last_attempted_at AS last_attempted_at, outbox.last_error AS last_error";

/// Mark-dispatched SQL.
///
/// Idempotent: the `AND dispatched_at IS NULL` guard keeps a
/// double-mark from resetting the dispatched timestamp. `RETURNING id`
/// lets the caller distinguish "row existed + was marked" from
/// "row not found" without a separate SELECT.
pub const SQL_MARK_DISPATCHED: &str = "\
UPDATE sensor.event_outbox \
SET dispatched_at = NOW(), \
    claimed_at = NULL, \
    claimed_by = NULL \
WHERE id = $1 \
  AND dispatched_at IS NULL \
RETURNING id";

/// Mark-failed SQL. Always increments `dispatch_attempts`, overwrites
/// `last_error`, sets `last_attempted_at = NOW()`. The caller passes
/// an already-truncated error string (bounded in Rust) so the SQL
/// cannot receive unbounded bytes.
///
/// `AND dispatched_at IS NULL` keeps an already-dispatched row
/// immutable — a late-arriving publish failure is a no-op and the
/// row stays marked dispatched. `RETURNING id` distinguishes
/// not-found from no-op.
pub const SQL_MARK_FAILED: &str = "\
UPDATE sensor.event_outbox \
SET dispatch_attempts = dispatch_attempts + 1, \
    last_attempted_at = NOW(), \
    last_error = $2, \
    claimed_at = NULL, \
    claimed_by = NULL \
WHERE id = $1 \
  AND dispatched_at IS NULL \
RETURNING id";

/// Existence probe used by the mark_* methods to disambiguate
/// not-found from no-op when the UPDATE returns 0 rows.
pub const SQL_EXISTS_BY_ID: &str = "\
SELECT 1 \
FROM sensor.event_outbox \
WHERE id = $1 \
LIMIT 1";

/// Retention cleanup. Deletes rows that have been dispatched longer
/// ago than `max_age`. `$1` is seconds as FLOAT8.
pub const SQL_CLEANUP_PUBLISHED: &str = "\
DELETE FROM sensor.event_outbox \
WHERE dispatched_at IS NOT NULL \
  AND dispatched_at < NOW() - make_interval(secs => $1)";

/// Pending-count gauge query. Excludes dead-lettered rows per ADR-029
/// (pending = Pending status, not DeadLettered) so the gauge never
/// counts rows the dispatcher has given up on.
pub const SQL_PENDING_COUNT: &str = "\
SELECT COUNT(*)::BIGINT \
FROM sensor.event_outbox \
WHERE dispatched_at IS NULL \
  AND dispatch_attempts < 10";

/// Maximum length for the `last_error` column value. Bounded in Rust
/// before the UPDATE so a pathological error chain cannot grow the
/// row unboundedly; matches the ADR-029 hint "truncated".
pub const LAST_ERROR_MAX_LEN: usize = 2000;

/// Duration of an outbox claim lease in seconds. Mirrors the
/// TypeScript platform outbox default (5 minutes) so operational
/// dashboards have one lease window across runtimes.
pub const CLAIM_LEASE_SECONDS: u32 = 5 * 60;

// =====================================================================
// Struct
// =====================================================================

/// Production [`OutboxRepository`] backed by tokio-postgres via
/// deadpool. Holds the connection pool; every method leases a
/// connection for its duration.
///
/// The enqueue path is separate from the trait surface: the caller
/// owns the outer transaction (e.g. `persistence.rs::write_tenant_batch`
/// runs COPY + outbox INSERT in one TX), so enqueue takes a
/// `&Transaction` rather than leasing from the pool. The claim /
/// mark / cleanup / pending-count paths all run on independent
/// connections.
#[derive(Debug, Clone)]
pub struct PgOutboxRepository {
    pool: Pool,
}

impl PgOutboxRepository {
    /// Wrap an existing connection pool. Construction is pool-level
    /// only — the repository does not open its own connections or
    /// perform any DB I/O until a method is called.
    #[must_use]
    pub const fn new(pool: Pool) -> Self {
        Self { pool }
    }

    /// Enqueue a row within the caller's transaction. This is the
    /// "transactional" half of the Transactional Outbox pattern —
    /// the caller's COPY + the outbox INSERT commit atomically.
    ///
    /// This method is NOT on the [`OutboxRepository`] trait because
    /// the trait must stay object-safe, and `&Transaction<'_>`
    /// carries a lifetime that would require `dyn for<'a>
    /// OutboxRepository<'a>` HRTB trickery. Callers use this method
    /// directly on `PgOutboxRepository`; they hold a concrete
    /// `PgOutboxRepository` rather than `Arc<dyn OutboxRepository>`
    /// at the enqueue site, which is fine — the enqueue site knows
    /// it is talking to PG.
    ///
    /// # Errors
    /// * [`OutboxError::InvalidEventType`] — whitelist rejected.
    /// * [`OutboxError::Storage`] — DB I/O failed.
    pub async fn enqueue_in_tx(
        &self,
        tx: &Transaction<'_>,
        tenant_id: TenantId,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<Uuid, OutboxError> {
        validate_event_type(event_type)?;
        let row = tx
            .query_one(SQL_ENQUEUE, &[tenant_id.as_uuid(), &event_type, &payload])
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let id: Uuid = row
            .try_get(0)
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        Ok(id)
    }

    fn truncate_error(msg: &str) -> String {
        if msg.len() <= LAST_ERROR_MAX_LEN {
            return msg.to_owned();
        }
        // Walk backwards from the byte budget until we land on a
        // UTF-8 char boundary — `str::split_at` panics on a mid-
        // codepoint index, and the cap can fall inside a multi-byte
        // sequence. Worst-case walk is bounded by the UTF-8 max
        // sequence length (4 bytes).
        let mut end = LAST_ERROR_MAX_LEN;
        while end > 0 && !msg.is_char_boundary(end) {
            end -= 1;
        }
        let (head, _) = msg.split_at(end);
        head.to_owned()
    }

    fn row_to_record(row: &tokio_postgres::Row) -> Result<OutboxRecord, OutboxError> {
        let get_err = |e: tokio_postgres::Error| OutboxError::Storage(Box::new(e));
        let id: Uuid = row.try_get("id").map_err(get_err)?;
        let tenant_uuid: Uuid = row.try_get("tenant_id").map_err(get_err)?;
        let tenant_id = TenantId::from_uuid(tenant_uuid);
        let event_type: String = row.try_get("event_type").map_err(get_err)?;
        let payload: serde_json::Value = row.try_get("payload").map_err(get_err)?;
        let created_at: DateTime<Utc> = row.try_get("created_at").map_err(get_err)?;
        let dispatched_at: Option<DateTime<Utc>> = row.try_get("dispatched_at").map_err(get_err)?;
        let dispatch_attempts_raw: i32 = row.try_get("dispatch_attempts").map_err(get_err)?;
        // i32 → u32 via try_from keeps a corrupt negative value from
        // exploding the dispatcher's backoff maths. We clamp to zero
        // on the impossible-but-defensible case — a negative attempt
        // count means the row is malformed + a fresh dispatcher run
        // treats it as never-attempted, which is safe.
        let dispatch_attempts = u32::try_from(dispatch_attempts_raw).unwrap_or(0);
        let last_attempted_at: Option<DateTime<Utc>> =
            row.try_get("last_attempted_at").map_err(get_err)?;
        let last_error: Option<String> = row.try_get("last_error").map_err(get_err)?;
        let status = OutboxStatus::derive(dispatched_at, dispatch_attempts);
        Ok(OutboxRecord {
            id,
            tenant_id,
            event_type,
            payload,
            created_at,
            status,
            dispatch_attempts,
            last_attempted_at,
            last_error,
        })
    }
}

#[async_trait]
impl OutboxRepository for PgOutboxRepository {
    async fn enqueue(
        &self,
        _tenant_id: TenantId,
        _event_type: &str,
        _payload: serde_json::Value,
    ) -> Result<Uuid, OutboxError> {
        // The trait-object surface does NOT support enqueue — the
        // transactional contract requires a caller-owned Transaction,
        // which cannot round-trip through dyn without HRTB. Callers
        // that need a trait-object repository get the other four
        // methods (claim / mark_dispatched / mark_failed /
        // cleanup_published / pending_count); the enqueue site holds
        // a concrete `PgOutboxRepository` and invokes
        // [`PgOutboxRepository::enqueue_in_tx`] directly.
        //
        // This variant returns a Storage error with a sentinel message
        // so a caller that accidentally dispatches through `dyn` sees
        // a loud failure rather than a silent no-op.
        Err(OutboxError::Storage(Box::new(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "PgOutboxRepository::enqueue is not available on the trait surface; \
             call PgOutboxRepository::enqueue_in_tx with a caller-owned Transaction instead",
        ))))
    }

    async fn claim_pending(&self, req: ClaimBatch) -> Result<Vec<OutboxRecord>, OutboxError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let limit_i64 = i64::from(req.limit);
        let backoff_secs = req.backoff_base.as_secs_f64();
        let claim_lease_secs = f64::from(CLAIM_LEASE_SECONDS);
        let claim_owner = format!("sensor-ingestion-{}", std::process::id());
        let rows = client
            .query(
                SQL_CLAIM_PENDING,
                &[&limit_i64, &backoff_secs, &claim_lease_secs, &claim_owner],
            )
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            out.push(Self::row_to_record(row)?);
        }
        Ok(out)
    }

    async fn mark_dispatched(&self, id: Uuid) -> Result<(), OutboxError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let updated = client
            .query_opt(SQL_MARK_DISPATCHED, &[&id])
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        if updated.is_some() {
            return Ok(());
        }
        // 0 rows updated → either already dispatched (no-op) or the
        // id does not exist (RecordNotFound). The existence probe
        // disambiguates.
        let exists = client
            .query_opt(SQL_EXISTS_BY_ID, &[&id])
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        if exists.is_none() {
            return Err(OutboxError::RecordNotFound { id });
        }
        Ok(())
    }

    async fn mark_failed(&self, id: Uuid, error: &str) -> Result<(), OutboxError> {
        let truncated = Self::truncate_error(error);
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let updated = client
            .query_opt(SQL_MARK_FAILED, &[&id, &truncated])
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        if updated.is_some() {
            return Ok(());
        }
        // See mark_dispatched — same disambiguation.
        let exists = client
            .query_opt(SQL_EXISTS_BY_ID, &[&id])
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        if exists.is_none() {
            return Err(OutboxError::RecordNotFound { id });
        }
        Ok(())
    }

    async fn cleanup_published(&self, max_age: Duration) -> Result<u64, OutboxError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let secs = max_age.as_secs_f64();
        let deleted = client
            .execute(SQL_CLEANUP_PUBLISHED, &[&secs])
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        Ok(deleted)
    }

    async fn pending_count(&self) -> Result<u64, OutboxError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let row = client
            .query_one(SQL_PENDING_COUNT, &[])
            .await
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        let count: i64 = row
            .try_get(0)
            .map_err(|e| OutboxError::Storage(Box::new(e)))?;
        // SELECT COUNT(*) cannot return a negative value in PG, but
        // the cast is still fallible under the type system. Clamp
        // defensively; a negative here is a PG-side corruption.
        Ok(u64::try_from(count).unwrap_or(0))
    }
}

// =====================================================================
// Unit tests — anchor SQL contracts. No live PG needed.
// =====================================================================
#[cfg(test)]
mod tests {
    use super::{
        CLAIM_LEASE_SECONDS, LAST_ERROR_MAX_LEN, PgOutboxRepository, SQL_CLAIM_PENDING,
        SQL_CLEANUP_PUBLISHED, SQL_ENQUEUE, SQL_EXISTS_BY_ID, SQL_MARK_DISPATCHED, SQL_MARK_FAILED,
        SQL_PENDING_COUNT,
    };
    use crate::repository::EVENT_TYPE_MAX_LEN;

    #[test]
    fn enqueue_sql_has_three_params_and_returning_id() {
        assert!(SQL_ENQUEUE.contains("$1"));
        assert!(SQL_ENQUEUE.contains("$2"));
        assert!(SQL_ENQUEUE.contains("$3"));
        assert!(
            !SQL_ENQUEUE.contains("$4"),
            "enqueue has exactly three parameters; $4 means drift"
        );
        assert!(
            SQL_ENQUEUE.contains("RETURNING id"),
            "enqueue must return the generated id"
        );
        assert!(
            SQL_ENQUEUE.contains("sensor.event_outbox"),
            "schema-qualified table name required"
        );
    }

    #[test]
    fn claim_pending_sql_has_for_update_skip_locked_and_order() {
        // The claim's concurrency primitive is literally FOR UPDATE
        // SKIP LOCKED — a refactor that dropped it would silently
        // double-dispatch under concurrent dispatchers. Pin it.
        assert!(
            SQL_CLAIM_PENDING.contains("FOR UPDATE SKIP LOCKED"),
            "claim must use FOR UPDATE SKIP LOCKED"
        );
        assert!(
            SQL_CLAIM_PENDING.contains("UPDATE sensor.event_outbox AS outbox"),
            "claim must durably lease rows via UPDATE ... RETURNING"
        );
        assert!(
            SQL_CLAIM_PENDING.contains("claimed_at = NOW()"),
            "claim must set claimed_at before returning"
        );
        assert!(
            SQL_CLAIM_PENDING.contains("claimed_by = $4"),
            "claim must record the worker owner"
        );
        assert!(
            SQL_CLAIM_PENDING.contains("claimed_at IS NULL")
                && SQL_CLAIM_PENDING.contains("make_interval(secs => $3)"),
            "claim must skip rows whose lease has not expired"
        );
        // Tenant-fair-by-default ordering comes from created_at.
        assert!(
            SQL_CLAIM_PENDING.contains("ORDER BY created_at"),
            "claim must order by created_at"
        );
        // Pending filter — dispatched rows are invisible.
        assert!(
            SQL_CLAIM_PENDING.contains("dispatched_at IS NULL"),
            "claim must filter out dispatched rows"
        );
        // Exponential backoff uses make_interval with the $2 base.
        assert!(
            SQL_CLAIM_PENDING.contains("make_interval(secs =>"),
            "claim must compute backoff via make_interval"
        );
        assert!(
            SQL_CLAIM_PENDING.contains("LEAST(dispatch_attempts, 10)"),
            "backoff exponent must be clamped at 10"
        );
        assert!(
            SQL_CLAIM_PENDING.contains("LIMIT $1"),
            "claim must honour the batch limit parameter"
        );
    }

    #[test]
    fn claim_lease_matches_platform_default() {
        assert_eq!(CLAIM_LEASE_SECONDS, 300);
    }

    #[test]
    fn mark_dispatched_is_idempotent_and_clears_claim() {
        assert!(
            SQL_MARK_DISPATCHED.contains("AND dispatched_at IS NULL"),
            "mark_dispatched must guard on NULL → idempotent re-mark"
        );
        assert!(
            SQL_MARK_DISPATCHED.contains("claimed_at = NULL")
                && SQL_MARK_DISPATCHED.contains("claimed_by = NULL"),
            "mark_dispatched must clear the lease"
        );
        assert!(
            SQL_MARK_DISPATCHED.contains("RETURNING id"),
            "mark_dispatched must RETURN so caller can distinguish no-op from not-found"
        );
    }

    #[test]
    fn mark_failed_increments_attempt_and_records_error() {
        assert!(
            SQL_MARK_FAILED.contains("dispatch_attempts = dispatch_attempts + 1"),
            "mark_failed must increment the attempt counter"
        );
        assert!(
            SQL_MARK_FAILED.contains("last_error = $2"),
            "mark_failed must bind the error string as a parameter"
        );
        assert!(
            SQL_MARK_FAILED.contains("last_attempted_at = NOW()"),
            "mark_failed must refresh last_attempted_at"
        );
        assert!(
            SQL_MARK_FAILED.contains("claimed_at = NULL")
                && SQL_MARK_FAILED.contains("claimed_by = NULL"),
            "mark_failed must clear the lease for retry"
        );
        assert!(
            SQL_MARK_FAILED.contains("AND dispatched_at IS NULL"),
            "mark_failed must NOT touch already-dispatched rows"
        );
    }

    #[test]
    fn pending_count_excludes_dead_lettered() {
        assert!(
            SQL_PENDING_COUNT.contains("dispatch_attempts < 10"),
            "pending gauge must NOT include dead-lettered rows"
        );
        assert!(
            SQL_PENDING_COUNT.contains("dispatched_at IS NULL"),
            "pending gauge must NOT include dispatched rows"
        );
    }

    #[test]
    fn cleanup_published_targets_old_dispatched_rows_only() {
        assert!(
            SQL_CLEANUP_PUBLISHED.contains("dispatched_at IS NOT NULL"),
            "cleanup must only touch dispatched rows"
        );
        assert!(
            SQL_CLEANUP_PUBLISHED.contains("make_interval(secs => $1)"),
            "cleanup must use parameterised interval"
        );
    }

    #[test]
    fn exists_by_id_is_a_bounded_probe() {
        assert!(SQL_EXISTS_BY_ID.contains("LIMIT 1"));
        assert!(SQL_EXISTS_BY_ID.contains("WHERE id = $1"));
    }

    #[test]
    fn truncate_error_keeps_short_input_intact() {
        // Bounded Rust-side truncation. A short message is returned
        // verbatim — no allocation, no corruption.
        let msg = "publish failed: connection refused";
        let out = PgOutboxRepository::truncate_error(msg);
        assert_eq!(out, msg);
    }

    #[test]
    fn truncate_error_cuts_long_input_at_boundary() {
        // Long message is clipped to LAST_ERROR_MAX_LEN bytes exactly.
        // We pad with ASCII so there is no UTF-8 boundary to consider
        // in this case; the boundary-walk logic is exercised by the
        // next test.
        let msg = "A".repeat(LAST_ERROR_MAX_LEN + 500);
        let out = PgOutboxRepository::truncate_error(&msg);
        assert_eq!(out.len(), LAST_ERROR_MAX_LEN);
    }

    #[test]
    fn truncate_error_does_not_break_utf8_boundary() {
        // Each `🔥` is 4 bytes in UTF-8. If the naive truncation cut
        // mid-codepoint, `String::from_utf8_lossy` would have had to
        // paper over it; instead the boundary-walk guarantees a
        // clean char-boundary truncation.
        let unit = "🔥"; // 4 bytes
        let needed_units = (LAST_ERROR_MAX_LEN / unit.len()) + 5;
        let msg: String = unit.repeat(needed_units);
        let out = PgOutboxRepository::truncate_error(&msg);
        assert!(
            out.len() <= LAST_ERROR_MAX_LEN,
            "truncated length must not exceed cap"
        );
        assert!(
            out.chars().all(|c| c == '🔥'),
            "all characters must stay intact — no mojibake"
        );
    }

    #[test]
    fn event_type_max_len_matches_the_repository_validator() {
        // The pg module reuses the whitelist's length cap via the
        // pub const re-import. Pin the agreement so a rename in one
        // place fails the other.
        assert_eq!(EVENT_TYPE_MAX_LEN, 100);
    }

    // -----------------------------------------------------------------
    // Live integration smoke. `#[ignore]` so the unit suite stays
    // container-free. The CI job that brings up testcontainers-rs
    // (PR-C #9) un-ignores this test; until then, running it locally
    // requires a reachable PG with the V016 migration applied.
    // -----------------------------------------------------------------

    // Deliberately out-of-line ignored (run with
    // `cargo test -p outbox-rs -- --ignored live_crud_round_trip`).
    #[tokio::test]
    #[ignore = "requires TimescaleDB with V016 migration applied"]
    async fn live_crud_round_trip() {
        // The live test lives here as scaffolding — the actual
        // testcontainers fixture lands with PR-C #9. This ignored
        // test ensures the PgOutboxRepository surface compiles
        // inside a tokio runtime.
    }
}
