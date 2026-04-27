//! [`OutboxRepository`] — the async trait every storage backend
//! implements. The dispatcher + the persistence integration
//! (`write_tenant_batch`) both program against this trait so the
//! storage backend is swappable: `PgOutboxRepository` (production,
//! added in a follow-up commit) targets tokio-postgres;
//! `InMemoryOutboxRepository` (crate feature `mock`) targets unit
//! tests that do not need a live PG.

use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tenant_context::TenantId;
use uuid::Uuid;

use crate::{OutboxError, OutboxRecord};

/// Claim request sent to the repository by the dispatcher. Carries
/// the batch size + the backoff schedule so the storage backend can
/// compute its WHERE clause without re-deriving platform constants.
#[derive(Debug, Clone, Copy)]
pub struct ClaimBatch {
    /// Maximum number of rows to claim in this call. The dispatcher
    /// uses 500 (ADR-029); tests may pass smaller values for
    /// deterministic assertions.
    pub limit: u32,
    /// Base interval for the exponential backoff. Each failed attempt
    /// multiplies this by `2^attempts` (clamped at `attempts = 10`)
    /// before the record is eligible for re-claim. The dispatcher
    /// uses `Duration::from_millis(100)`.
    pub backoff_base: Duration,
    /// Moment of the call. Passed explicitly rather than read inside
    /// the repository so tests can drive the claim loop with a
    /// synthetic clock.
    pub now: DateTime<Utc>,
}

/// Storage-layer contract for the outbox. Every operation is async +
/// fallible; errors route through [`OutboxError`] variants so the
/// caller can alarm by shape.
///
/// # Invariants every impl MUST uphold
///
/// 1. **Atomicity on enqueue.** `enqueue_in_tx` runs inside a caller-
///    owned transaction. If the caller rolls back, the row is not
///    visible.
/// 2. **Exactly-once claim semantics.** `claim_pending` is idempotent
///    under concurrent callers: a row returned to one caller MUST NOT
///    be returned to another until either the caller marks it
///    dispatched / failed, or the claim's hidden lock is released
///    (e.g. the caller panics and PG releases the `FOR UPDATE SKIP
///    LOCKED` hold on connection reset).
/// 3. **Status derivation.** `OutboxRecord::status` is derived from
///    the stored columns via [`OutboxStatus::derive`][`crate::OutboxStatus::derive`];
///    the impl never persists the status independently.
/// 4. **No lost updates.** `mark_dispatched` and `mark_failed` are
///    both idempotent: re-marking a dispatched row as dispatched is a
///    no-op; marking a dispatched row as failed is a no-op (the
///    dispatcher's success / failure ordering is resolved at the
///    publish site, not at mark time).
#[async_trait]
pub trait OutboxRepository: Send + Sync + std::fmt::Debug {
    /// Insert a new outbox row within the caller's transaction. The
    /// generated id is returned so the caller can correlate dispatches
    /// back to the source.
    ///
    /// The `payload` is passed as [`serde_json::Value`] so the trait
    /// stays `dyn`-compatible without an `erased_serde` dep. Typed
    /// callers convert via [`encode_payload`] at the call site; the
    /// `InvalidEventType` check runs before the payload is touched so
    /// a malformed event_type fails fast.
    ///
    /// # Errors
    /// * [`OutboxError::InvalidEventType`] — event_type failed the
    ///   platform whitelist (PascalCase, bounded length).
    /// * [`OutboxError::Storage`] — backend I/O failed.
    async fn enqueue(
        &self,
        tenant_id: TenantId,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<Uuid, OutboxError>;

    /// Claim up to `req.limit` pending rows whose `last_attempted_at`
    /// clears the exponential backoff. Returns the claimed records
    /// with a repository-held lock; the caller MUST call
    /// `mark_dispatched` or `mark_failed` on every id before the
    /// connection is returned to the pool, or the impl must release
    /// the lock automatically on connection drop.
    ///
    /// # Errors
    /// * [`OutboxError::Decode`] — stored payload did not match the
    ///   JSON contract.
    /// * [`OutboxError::Storage`] — backend I/O failed.
    async fn claim_pending(&self, req: ClaimBatch) -> Result<Vec<OutboxRecord>, OutboxError>;

    /// Mark the record as successfully dispatched. Idempotent: an
    /// already-dispatched record is a no-op (returns `Ok(())`).
    ///
    /// # Errors
    /// * [`OutboxError::Storage`] — backend I/O failed.
    /// * [`OutboxError::RecordNotFound`] — id no longer exists (the
    ///   retention job deleted it, or — should-never-happen — a second
    ///   dispatcher already removed it). Defense-in-depth.
    async fn mark_dispatched(&self, id: Uuid) -> Result<(), OutboxError>;

    /// Mark the record as failed: increment `dispatch_attempts`, write
    /// the truncated `last_error`, set `last_attempted_at = now`. If
    /// the new attempt count crosses [`DLQ_THRESHOLD`][`crate::record::DLQ_THRESHOLD`]
    /// the record transitions to `OutboxStatus::DeadLettered` on next
    /// read; the impl does not separately persist the derived status.
    ///
    /// # Errors
    /// * [`OutboxError::Storage`] — backend I/O failed.
    /// * [`OutboxError::RecordNotFound`] — id no longer exists.
    async fn mark_failed(&self, id: Uuid, error: &str) -> Result<(), OutboxError>;

    /// Delete dispatched rows older than `max_age`. Retention job
    /// calls this once a day; returns the number of rows actually
    /// deleted (for the operator log / gauge).
    ///
    /// # Errors
    /// * [`OutboxError::Storage`] — backend I/O failed.
    async fn cleanup_published(&self, max_age: Duration) -> Result<u64, OutboxError>;

    /// Read-only count of currently pending rows. Used by
    /// `OutboxMaintenance::pending_gauge` to feed Prometheus.
    ///
    /// # Errors
    /// * [`OutboxError::Storage`] — backend I/O failed.
    async fn pending_count(&self) -> Result<u64, OutboxError>;
}

/// Helper for repository impls + callers that have a typed payload.
/// Converts a typed `Serialize` value to the [`serde_json::Value`] the
/// trait accepts, keeping the trait object-safe without an
/// `erased_serde` dep. The PG impl then serialises `Value` to JSONB
/// in one shot.
///
/// # Errors
/// Returns [`OutboxError::Encode`] if the value does not serialise.
pub fn encode_payload<T: Serialize>(payload: &T) -> Result<serde_json::Value, OutboxError> {
    serde_json::to_value(payload).map_err(OutboxError::Encode)
}

/// Maximum length of an event_type the repository will accept at
/// enqueue. Matches the `sensor.event_outbox.event_type TEXT` column
/// plus a sanity margin; the DB would accept more but a platform
/// convention bounds the identifier length so operator logs and
/// dashboards stay readable.
pub const EVENT_TYPE_MAX_LEN: usize = 100;

/// Validate an event_type against the platform whitelist:
/// `^[A-Z][A-Za-z0-9]{0,99}$`. Every repository impl MUST call this
/// before persisting the enqueue; a malformed event_type cannot
/// reach postgres. Exposed `pub` so the PG impl + the in-memory
/// mock share the exact same check.
///
/// # Errors
/// Returns [`OutboxError::InvalidEventType`] if the input is empty,
/// exceeds [`EVENT_TYPE_MAX_LEN`], does not begin with an ASCII
/// uppercase letter, or contains any non-ASCII-alphanumeric
/// character.
pub fn validate_event_type(s: &str) -> Result<(), OutboxError> {
    if s.is_empty() || s.len() > EVENT_TYPE_MAX_LEN {
        return Err(OutboxError::InvalidEventType { got: s.to_owned() });
    }
    let bytes = s.as_bytes();
    // Empty case was filtered above; indexing byte 0 is safe and
    // avoids the Chars allocation that `.chars().next()` implies.
    let first = match bytes.first() {
        Some(b) => *b,
        None => {
            return Err(OutboxError::InvalidEventType { got: s.to_owned() });
        }
    };
    if !first.is_ascii_uppercase() {
        return Err(OutboxError::InvalidEventType { got: s.to_owned() });
    }
    for b in bytes.iter().skip(1) {
        if !b.is_ascii_alphanumeric() {
            return Err(OutboxError::InvalidEventType { got: s.to_owned() });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ClaimBatch, EVENT_TYPE_MAX_LEN, OutboxError, encode_payload, validate_event_type};
    use serde::Serialize;
    use std::time::Duration;

    #[test]
    fn validate_event_type_accepts_canonical_pascal_case() {
        for good in [
            "A",
            "Ab",
            "SensorMetricIngested",
            "AlertTriggered",
            "UserConsentRevoked",
            "Ab123Cd",
        ] {
            validate_event_type(good)
                .unwrap_or_else(|e| panic!("expected {good:?} to pass, got {e:?}"));
        }
    }

    #[test]
    fn validate_event_type_rejects_malformed_input() {
        // Each rejection case + the variant it must produce. Empty,
        // too long, leading lowercase / digit, embedded non-alnum,
        // embedded dot / slash, embedded unicode — every class of
        // attacker-controlled string the enqueue boundary can see.
        let too_long = "A".repeat(EVENT_TYPE_MAX_LEN + 1);
        for bad in [
            "",
            "sensorMetric", // leading lowercase
            "1Sensor",      // leading digit
            "Sensor.Metric",
            "Sensor/Metric",
            "Sensor Metric", // space
            "Sensor-Metric", // hyphen
            "Sensör",        // non-ASCII
            too_long.as_str(),
        ] {
            let err = validate_event_type(bad).unwrap_err();
            match err {
                OutboxError::InvalidEventType { got } => {
                    assert_eq!(got, bad, "error should echo the original input");
                }
                other => panic!("expected InvalidEventType for {bad:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn validate_event_type_boundary_length_is_accepted() {
        // The max-length string IS accepted (the reject case is
        // strictly GREATER than max). An off-by-one that flipped the
        // comparison would surface here.
        let at_max = "A".repeat(EVENT_TYPE_MAX_LEN);
        validate_event_type(&at_max).expect("EVENT_TYPE_MAX_LEN string must be accepted");
    }

    #[test]
    fn encode_payload_round_trips_a_typed_value() {
        #[derive(Serialize)]
        struct TinyEvent {
            kind: &'static str,
            n: u32,
        }
        let v = encode_payload(&TinyEvent { kind: "test", n: 7 }).expect("encode must succeed");
        // The value is a JSON object with the two fields — caller-
        // visible surface, not the internal representation.
        assert_eq!(v["kind"], "test");
        assert_eq!(v["n"], 7);
    }

    #[test]
    fn claim_batch_is_copy_and_debug() {
        // Guard the ClaimBatch Value semantics — the dispatcher passes
        // it by value to the repository; a regression that made it
        // non-Copy would force a clone at every tick.
        let req = ClaimBatch {
            limit: 500,
            backoff_base: Duration::from_millis(100),
            now: chrono::Utc::now(),
        };
        let _copied: ClaimBatch = req;
        let _as_str = format!("{req:?}"); // ensures Debug is wired
    }
}
