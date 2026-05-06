//! LayeredJtiDedupTable — Moka hot-tier + SQLCipher persistent
//! tier composite (Batch 92 Sprint 6.4 full wire final).
//!
//! ## WHY
//!
//! Plan §4.10 72-hour dedup window is not met by either tier
//! alone:
//!
//! - `MokaJtiDedupTable` (Batch 57): in-memory, fast
//!   (microseconds), resets on restart.
//! - `SqlCipherJtiDedupTable` (Batch 91): persistent across
//!   restart, slower (SQLite roundtrip ~100μs).
//!
//! This composite gives both benefits:
//! 1. **Hot path** (~microseconds) — Moka check first.
//!    99.9%+ of replay attempts are within the Moka TTL and
//!    short-circuit without touching SQLite.
//! 2. **Cold path** (~100μs) — on Moka miss, query SQLCipher.
//!    Catches cross-restart replays.
//! 3. **Write fan-out** — on Fresh, write to BOTH tiers so
//!    subsequent hot-path checks hit Moka.
//!
//! ## Architecture
//!
//! Each operation runs against both tiers with
//! composite-specific result merging:
//!
//! - `check_and_mark`:
//!   1. Probe Moka first.
//!   2. If Duplicate → return Duplicate (no SQLite touch).
//!   3. If Fresh (or Moka InvalidExpiry fails-closed) →
//!      probe SQLCipher.
//!   4. If SQLCipher Duplicate → return Duplicate (seen in a
//!      prior process lifetime).
//!   5. If SQLCipher Fresh → return Fresh. Both tiers now
//!      have the entry.
//!
//! - `live_entry_count` — returns the SQLCipher count (the
//!   authoritative 72h window); Moka is just a subset cache.
//!
//! - `sweep_expired` — runs both sweeps; returns the sum.
//!
//! ## Fail-closed discipline
//!
//! If EITHER tier returns StoreIoError, the composite
//! returns StoreIoError. A partial tier failure = the whole
//! dedup subsystem fails-closed. Consumer (envelope verify
//! Gate 4) treats StoreIoError as REJECT — an attacker who
//! can induce one tier's failure cannot slip a replay past
//! the other.
//!
//! ## Write consistency (eventual)
//!
//! Because check_and_mark runs the two tiers sequentially
//! rather than transactionally, there is a narrow window
//! where Moka has a Fresh record and SQLCipher doesn't (or
//! vice versa):
//!
//! - Process crashes between Moka insert and SQLCipher
//!   insert: restart sees only Moka's zero state +
//!   SQLCipher's pre-crash state. The jti is treated as
//!   Fresh (NOT replayed) — matches the intended behavior
//!   because the command whose insert didn't complete also
//!   didn't execute (no replay risk to cover).
//!
//! - A concurrent check_and_mark for the SAME jti races on
//!   the window: both might see Fresh in Moka, then BOTH
//!   try to insert into SQLCipher. SQLCipher's PRIMARY KEY
//!   constraint serializes them — second INSERT returns
//!   our "Duplicate" path.
//!
//! These semantics match the security contract: at-least-
//! once acceptance of a jti is fine; replay of an already-
//! ACCEPTED jti is the thing being prevented.

use std::sync::Arc;
use std::time::SystemTime;

use async_trait::async_trait;

use super::jti::{DedupResult, DedupTableError, Jti, JtiDedupTable};

/// Moka hot-tier + SQLCipher persistent tier composite.
pub struct LayeredJtiDedupTable {
    moka: Arc<dyn JtiDedupTable>,
    sqlcipher: Arc<dyn JtiDedupTable>,
}

impl LayeredJtiDedupTable {
    /// Construct with two tier implementations. Caller is
    /// responsible for passing a Moka impl first + SQLCipher
    /// second (or equivalent fast-then-persistent ordering).
    pub fn new(moka: Arc<dyn JtiDedupTable>, sqlcipher: Arc<dyn JtiDedupTable>) -> Self {
        Self { moka, sqlcipher }
    }
}

#[async_trait]
impl JtiDedupTable for LayeredJtiDedupTable {
    async fn check_and_mark(
        &self,
        jti: &Jti,
        expires_at: SystemTime,
    ) -> Result<DedupResult, DedupTableError> {
        // Tier 1: Moka (in-memory, microseconds). 99.9%+ of
        // replay attempts short-circuit here.
        let moka_result = self.moka.check_and_mark(jti, expires_at).await;
        match moka_result {
            Ok(DedupResult::Duplicate) => {
                return Ok(DedupResult::Duplicate);
            }
            Ok(DedupResult::Fresh) => {
                // Continue to tier 2.
            }
            Err(DedupTableError::InvalidExpiry) => {
                // InvalidExpiry is a contract-violation
                // error (expires_at <= now). Both tiers
                // would reject; return immediately.
                return Err(DedupTableError::InvalidExpiry);
            }
            Err(e) => {
                // StoreIoError on Moka is extremely rare
                // (memory allocation failure) but fail-closed.
                return Err(e);
            }
        }

        // Tier 2: SQLCipher (persistent, ~100μs). Catches
        // cross-restart replays.
        let sqlcipher_result = self.sqlcipher.check_and_mark(jti, expires_at).await;
        sqlcipher_result
    }

    async fn live_entry_count(&self) -> Result<usize, DedupTableError> {
        // SQLCipher is the authoritative 72h window;
        // Moka is a subset cache.
        self.sqlcipher.live_entry_count().await
    }

    async fn sweep_expired(&self, now: SystemTime) -> Result<usize, DedupTableError> {
        // Sweep both tiers; return sum. Moka sweeps via its
        // TTL eviction (mostly no-op) + SQLCipher sweeps
        // via DELETE.
        let moka_swept = self.moka.sweep_expired(now).await?;
        let sql_swept = self.sqlcipher.sweep_expired(now).await?;
        Ok(moka_swept + sql_swept)
    }
}

#[cfg(test)]
mod tests {
    use super::super::moka_dedup::MokaJtiDedupTable;
    use super::super::sqlcipher_dedup::SqlCipherJtiDedupTable;
    use super::*;
    use std::time::Duration;

    fn future(secs: u64) -> SystemTime {
        SystemTime::now() + Duration::from_secs(secs)
    }

    fn make_layered() -> LayeredJtiDedupTable {
        let moka = Arc::new(MokaJtiDedupTable::with_capacity_and_ttl(
            1000,
            Duration::from_secs(60),
        ));
        let sqlcipher = Arc::new(SqlCipherJtiDedupTable::in_memory().expect("sqlcipher"));
        LayeredJtiDedupTable::new(moka, sqlcipher)
    }

    fn jti(s: &str) -> Jti {
        Jti::try_new(s.to_string()).expect("valid")
    }

    #[tokio::test]
    async fn first_time_is_fresh_across_both_tiers() {
        let l = make_layered();
        let r = l
            .check_and_mark(&jti("abc"), future(72 * 3600))
            .await
            .expect("ok");
        assert_eq!(r, DedupResult::Fresh);
    }

    #[tokio::test]
    async fn second_time_is_duplicate_via_moka_short_circuit() {
        let l = make_layered();
        l.check_and_mark(&jti("abc"), future(72 * 3600))
            .await
            .expect("1");
        let r = l
            .check_and_mark(&jti("abc"), future(72 * 3600))
            .await
            .expect("2");
        assert_eq!(r, DedupResult::Duplicate);
    }

    #[tokio::test]
    async fn duplicate_detected_when_only_sqlcipher_has_record() {
        // Simulate cross-restart attack: SQLCipher has the
        // jti from a "prior process", Moka doesn't (empty
        // after "restart").
        let moka: Arc<dyn JtiDedupTable> = Arc::new(MokaJtiDedupTable::with_capacity_and_ttl(
            1000,
            Duration::from_secs(60),
        ));
        let sqlcipher: Arc<dyn JtiDedupTable> =
            Arc::new(SqlCipherJtiDedupTable::in_memory().expect("sqlcipher"));

        // Pre-populate SQLCipher (simulates pre-restart state).
        sqlcipher
            .check_and_mark(&jti("captured"), future(72 * 3600))
            .await
            .expect("prime");

        // Compose composite AFTER SQLCipher prime, with
        // FRESH Moka — simulates post-restart state.
        let l = LayeredJtiDedupTable::new(moka, sqlcipher);

        // Replay attempt — Moka says Fresh (not seen this
        // process), SQLCipher says Duplicate. Composite
        // result: Duplicate → attack blocked.
        let r = l
            .check_and_mark(&jti("captured"), future(72 * 3600))
            .await
            .expect("ok");
        assert_eq!(r, DedupResult::Duplicate);
    }

    #[tokio::test]
    async fn invalid_expiry_fails_closed_at_moka_short_circuit() {
        let l = make_layered();
        let now_minus_10 = SystemTime::now() - Duration::from_secs(10);
        let err = l
            .check_and_mark(&jti("abc"), now_minus_10)
            .await
            .expect_err("past expiry rejected");
        assert_eq!(err, DedupTableError::InvalidExpiry);
    }

    #[tokio::test]
    async fn live_entry_count_reflects_sqlcipher_authority() {
        let l = make_layered();
        l.check_and_mark(&jti("a"), future(72 * 3600))
            .await
            .unwrap();
        l.check_and_mark(&jti("b"), future(72 * 3600))
            .await
            .unwrap();
        assert_eq!(l.live_entry_count().await.unwrap(), 2);
    }

    #[tokio::test]
    async fn sweep_expired_accumulates_across_tiers() {
        let l = make_layered();
        l.check_and_mark(&jti("a"), future(72 * 3600))
            .await
            .unwrap();
        // sweep_expired on fresh entries returns 0 from both
        // tiers.
        assert_eq!(
            l.sweep_expired(SystemTime::now()).await.unwrap(),
            0,
            "fresh entries not swept"
        );
    }
}
