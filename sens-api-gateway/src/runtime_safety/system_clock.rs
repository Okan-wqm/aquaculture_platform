//! `SystemClockAuthority` — concrete `ClockAuthority` impl for
//! production boot (Batch 55, Sprint 6.7 partial).
//!
//! Baseline production impl that uses `std::time::Instant` for
//! monotonic readings + `SystemTime::now()` for wall-clock. This
//! is the HC-1-backward-compat path: pre-Sprint-6.7 the agent
//! used bare `chrono::Utc::now()` at every time-reading site;
//! Batch 55 channels those reads through the trait so Sprint
//! 6.7 can swap to a `ChronyNtsClockAuthority` (queries
//! `chronyc tracking` for NTS sync age + rejects stale reads)
//! without touching consumer code.
//!
//! ## What this impl does NOT do (Sprint 6.7 target)
//!
//! - Query `/var/run/chrony/chronyd.sock` for NTS sync age.
//!   Today's `trustworthy_wall_clock` always reports
//!   `nts_sync_age_secs = 0` (trusting). Sprint 6.7 wires the
//!   real age.
//! - Fail-closed on stale NTS sync. Today's threshold check
//!   never fires (age always 0 < threshold). Sprint 6.7 adds
//!   the real fail-closed gate.
//! - PTP / IEEE 1588 sub-microsecond sync (plan Faz 11
//!   optional SL-3 upgrade).
//!
//! The trait surface is identical between `SystemClockAuthority`
//! and the future `ChronyNtsClockAuthority` — consumers route
//! through `Arc<dyn ClockAuthority>` and never care which impl
//! is active. Sprint 6.7 swaps the constructor in AppState.

use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use super::clock::{ClockAuthority, ClockError, MonotonicAnchor, WallClockReading};

/// Default NTS sync staleness threshold — 1 hour. Matches the
/// plan D-7 specification for chronyd re-sync cadence on a
/// field-deployed edge device.
pub const DEFAULT_NTS_SYNC_MAX_SKEW_SECS: u64 = 3600;

/// Lazy-initialized process-start Instant. Used as the
/// MonotonicAnchor reference point.
///
/// WHY: `MonotonicAnchor::from_nanos_since_process_epoch(n)`
/// requires a nanosecond count relative to a PROCESS-bound
/// epoch. `Instant` doesn't expose absolute nanos; we anchor
/// a reference Instant at first call + compute deltas from
/// there. The process-epoch is fixed per-process — two
/// anchors from the same process are safely subtractable.
fn process_epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

/// Concrete production `ClockAuthority` impl.
pub struct SystemClockAuthority {
    nts_threshold_secs: u64,
}

impl SystemClockAuthority {
    /// Construct with default 1-hour NTS staleness threshold.
    pub fn new() -> Self {
        Self {
            nts_threshold_secs: DEFAULT_NTS_SYNC_MAX_SKEW_SECS,
        }
    }

    /// Construct with operator-configurable threshold. Sprint
    /// 6.7 wires `config.clock.nts_sync_max_skew_secs` to this
    /// constructor.
    #[allow(dead_code)] // Sprint 6.7 config wire consumer.
    pub fn with_nts_threshold(nts_threshold_secs: u64) -> Self {
        Self {
            nts_threshold_secs,
        }
    }
}

impl Default for SystemClockAuthority {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ClockAuthority for SystemClockAuthority {
    fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
        // Batch 85 fix of ORPHAN-HIGH-013 #5: capture epoch
        // FIRST, then now. On the FIRST EVER call,
        // process_epoch() initializes its OnceLock by calling
        // Instant::now() internally. The pre-fix order
        // captured `now = Instant::now()` BEFORE calling
        // `process_epoch()` which on first call ALSO calls
        // Instant::now(); the OnceLock's Instant::now() ran
        // AFTER our `now`, so epoch > now -> checked_duration_
        // since returned None -> MonotonicBackward on the very
        // first call, making the first-anchor test flaky on
        // fast machines.
        //
        // Post-fix order: epoch is latched first (either read
        // from the OnceLock or freshly initialized). Any
        // subsequent Instant::now() call is guaranteed >=
        // epoch by POSIX CLOCK_MONOTONIC contract. Subtraction
        // cannot underflow.
        let epoch = process_epoch();
        let now = Instant::now();
        let elapsed = now
            .checked_duration_since(epoch)
            .ok_or(ClockError::MonotonicBackward)?;
        let nanos = elapsed.as_nanos();
        Ok(MonotonicAnchor::from_nanos_since_process_epoch(nanos))
    }

    async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
        let system_time = SystemTime::now();

        // Pre-Sprint-6.7 baseline: we don't actually know the
        // NTS sync age. Report 0 (trusting). Sprint 6.7 reads
        // `chronyc tracking` and fails-closed if > threshold.
        //
        // Clients consuming WallClockReading today see
        // nts_sync_age_secs=0 which is always < threshold, so
        // the stale-sync gate never fires — identical behavior
        // to pre-Batch-55 direct chrono::Utc::now() calls.
        let nts_sync_age_secs = 0u64;

        // Pre-epoch guard — catches RTC-drained power-on
        // scenarios where SystemTime returns a time before
        // UNIX_EPOCH. Fail-closed for regulated-action paths.
        if system_time
            .duration_since(UNIX_EPOCH)
            .is_err()
        {
            return Err(ClockError::PreEpochWallClock);
        }

        let monotonic_anchor = self.monotonic_now()?;

        Ok(WallClockReading {
            system_time,
            monotonic_anchor,
            nts_sync_age_secs,
        })
    }

    fn nts_sync_max_skew_secs(&self) -> u64 {
        self.nts_threshold_secs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotonic_now_returns_non_decreasing_anchors() {
        let c = SystemClockAuthority::new();
        let a = c.monotonic_now().expect("first anchor");
        let b = c.monotonic_now().expect("second anchor");
        // Must not go backward; may be equal on fast paths or
        // strictly increasing on slower paths.
        let delta = b
            .saturating_duration_since(a)
            .expect("forward-delta must be Ok");
        // Not asserting a specific duration — just that the
        // subtraction didn't error out (MonotonicBackward
        // would mean regression).
        let _ = delta;
    }

    #[tokio::test]
    async fn trustworthy_wall_clock_populates_all_fields() {
        let c = SystemClockAuthority::new();
        let r = c
            .trustworthy_wall_clock()
            .await
            .expect("system time must be post-epoch");
        assert_eq!(r.nts_sync_age_secs, 0); // pre-Sprint-6.7 trusting default
        // system_time populated (non-zero since_epoch).
        assert!(
            r.system_time.duration_since(UNIX_EPOCH).is_ok(),
            "system_time must be post-UNIX_EPOCH"
        );
    }

    #[test]
    fn nts_sync_max_skew_default_is_one_hour() {
        let c = SystemClockAuthority::new();
        assert_eq!(c.nts_sync_max_skew_secs(), 3600);
    }

    #[test]
    fn custom_nts_threshold_honored() {
        let c = SystemClockAuthority::with_nts_threshold(60);
        assert_eq!(c.nts_sync_max_skew_secs(), 60);
    }
}
