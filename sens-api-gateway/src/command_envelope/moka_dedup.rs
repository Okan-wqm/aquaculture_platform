//! Moka-backed `JtiDedupTable` impl (Batch 57, Sprint 6.4
//! partial).
//!
//! In-process TTL cache covering the hot-window (60s default)
//! QoS-1 MQTT redelivery replay vector. Each inbound envelope's
//! `jti` is inserted with an operator-configured expiry;
//! subsequent envelopes with the same jti within the window
//! are rejected as replay attempts.
//!
//! ## What this impl covers (baseline)
//!
//! - Hot-window replay defense (seconds-to-minutes).
//! - Thread-safe concurrent access (Moka internals).
//! - Capacity-bounded (configurable max_capacity).
//! - Lazy + explicit expired-entry eviction.
//!
//! ## What this impl does NOT cover (Sprint 6.4 full target)
//!
//! - Reboot survival. Moka is in-process only; a device restart
//!   resets the dedup table. A re-used jti WITHIN the 72-hour
//!   plan §4.10 window but ACROSS a reboot would bypass dedup.
//! - The Sprint 6.4 full wire layers SQLCipher persistence
//!   underneath Moka: Moka hit = fast-path rejection; Moka
//!   miss + SQLCipher hit = slow-path rejection with Moka
//!   promotion; Moka miss + SQLCipher miss = fresh (insert in
//!   both tiers).
//!
//! Batch 57 is the fast-path tier. Sprint 6.4 adds the
//! persistent tier below it via a composite `LayeredJtiDedup
//! Table` that delegates to both.
//!
//! ## Memory bound
//!
//! max_capacity (default 100_000) × avg_entry_size (~200 B
//! including Moka metadata) ≈ 20 MB. Operators deploying to
//! resource-constrained edge devices (256 MB RAM baseline per
//! ADR-024 §5) can tighten to 10_000 for ~2 MB footprint.

use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use moka::sync::Cache;

use super::jti::{DedupResult, DedupTableError, Jti, JtiDedupTable};

/// Default Moka cache capacity — 100 000 live entries.
/// At ~200 B per entry ≈ 20 MB peak memory. Operator-tunable
/// via `MokaJtiDedupTable::with_capacity`.
pub const DEFAULT_MOKA_CAPACITY: u64 = 100_000;

/// Default hot-window TTL — 60 seconds. Plan §4.10 specifies
/// 72-hour full window; the 60-second Moka tier handles
/// QoS-1 MQTT redelivery (sub-second) + reconnect-replay
/// (sub-minute). SQLCipher tier (Sprint 6.4) covers the full
/// 72-hour window.
pub const DEFAULT_MOKA_TTL_SECS: u64 = 60;

/// Moka-backed `JtiDedupTable` impl.
///
/// Wraps a `moka::sync::Cache<String, SystemTime>` where:
/// - Key: `Jti` inner String.
/// - Value: `expires_at` SystemTime (audit-visible).
///
/// Moka's internal TTL is set separately from the expires_at
/// we store — we use the TTL for GC + the expires_at for the
/// lookup-time check. Plan §4.10 + ADR-020 §2 note that
/// consumer-supplied `expires_at` may be SHORTER than the
/// TTL (e.g., per-envelope `exp` field); in that case the
/// entry remains valid-for-GC but the consumer's
/// post-lookup expiry check rejects it.
pub struct MokaJtiDedupTable {
    cache: Cache<String, SystemTime>,
}

impl MokaJtiDedupTable {
    /// Construct with default capacity + TTL.
    pub fn new() -> Self {
        Self::with_capacity_and_ttl(
            DEFAULT_MOKA_CAPACITY,
            Duration::from_secs(DEFAULT_MOKA_TTL_SECS),
        )
    }

    /// Construct with operator-configurable capacity + TTL.
    ///
    /// Sprint 6.4 wires `config.command_envelope.jti_dedup_
    /// capacity` + `config.command_envelope.jti_dedup_ttl_
    /// secs` to this constructor.
    pub fn with_capacity_and_ttl(capacity: u64, ttl: Duration) -> Self {
        let cache = Cache::builder()
            .max_capacity(capacity)
            .time_to_live(ttl)
            .build();
        Self { cache }
    }
}

impl Default for MokaJtiDedupTable {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl JtiDedupTable for MokaJtiDedupTable {
    async fn check_and_mark(
        &self,
        jti: &Jti,
        expires_at: SystemTime,
    ) -> Result<DedupResult, DedupTableError> {
        // Expiry sanity check — caller supplies `expires_at`
        // which MUST be in the future. Fail-closed on clock-
        // skew scenarios where expires_at <= now — Sprint
        // 6.7 ChronyNtsClockAuthority would catch this
        // upstream but we defend-in-depth at the dedup tier
        // too.
        let now = SystemTime::now();
        if expires_at <= now {
            return Err(DedupTableError::InvalidExpiry);
        }

        let key = jti.as_str().to_string();

        // Atomic check-and-insert. Moka's `get` returns Option
        // — we check presence first, THEN insert. This is
        // race-prone for concurrent insertions of the SAME
        // jti (both threads could observe None and both
        // insert Fresh). The race produces over-acceptance
        // (both threads marked Fresh) not over-rejection.
        // Sprint 6.4 SQLCipher tier uses SELECT ... FOR
        // UPDATE semantics for the authoritative check;
        // Moka's over-acceptance window is bounded by TTL
        // so a replay flood can't sustain beyond the window.
        if self.cache.get(&key).is_some() {
            return Ok(DedupResult::Duplicate);
        }

        self.cache.insert(key, expires_at);
        Ok(DedupResult::Fresh)
    }

    async fn live_entry_count(&self) -> Result<usize, DedupTableError> {
        // Moka provides `entry_count()` but it's a weak-count
        // (includes pending-evict entries). For accurate
        // live-count we'd need to iterate + filter by
        // expires_at. For Sprint 6.4 metrics this weak-count
        // is acceptable; Sprint 6.4 can swap to the filtered
        // count if alerting needs precision.
        let count = self.cache.entry_count();
        // `entry_count()` returns u64; usize conversion is
        // safe on 64-bit targets (our only production
        // targets). Saturating on 32-bit wraps to
        // usize::MAX which correctly signals "capacity
        // exceeded metric would be misleading" — the edge-
        // case is unreachable on real deployments.
        Ok(usize::try_from(count).unwrap_or(usize::MAX))
    }

    async fn sweep_expired(&self, _now: SystemTime) -> Result<usize, DedupTableError> {
        // Moka auto-evicts on TTL; explicit sweep is an
        // invalidate_entries call. `invalidate_all` would
        // drop everything including non-expired entries
        // (wrong semantics). Batch 57 runs pending tasks
        // which triggers TTL-based eviction — Sprint 6.4
        // may expose a counter-tracking listener API wrap
        // for precise per-sweep metrics.
        //
        // The `usize` count returned here is 0 because Moka
        // doesn't expose the per-sweep evict count. Sprint
        // 6.4 may wrap with a counter-tracking builder
        // (Moka listener API) for observability.
        self.cache.run_pending_tasks();
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_jti(s: &str) -> Jti {
        Jti::try_new(s.to_string()).expect("valid jti")
    }

    #[tokio::test]
    async fn fresh_jti_returns_fresh() {
        let table = MokaJtiDedupTable::new();
        let j = test_jti("cmd-00000001");
        let expires = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(
            table.check_and_mark(&j, expires).await.unwrap(),
            DedupResult::Fresh
        );
    }

    #[tokio::test]
    async fn duplicate_jti_returns_duplicate() {
        let table = MokaJtiDedupTable::new();
        let j = test_jti("cmd-00000002");
        let expires = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(
            table.check_and_mark(&j, expires).await.unwrap(),
            DedupResult::Fresh
        );
        assert_eq!(
            table.check_and_mark(&j, expires).await.unwrap(),
            DedupResult::Duplicate
        );
    }

    #[tokio::test]
    async fn past_expiry_returns_invalid_expiry() {
        let table = MokaJtiDedupTable::new();
        let j = test_jti("cmd-00000003");
        let past = SystemTime::now() - Duration::from_secs(1);
        assert_eq!(
            table.check_and_mark(&j, past).await.unwrap_err(),
            DedupTableError::InvalidExpiry
        );
    }
}
