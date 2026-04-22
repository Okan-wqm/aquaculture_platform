//! # ClockAuthority — NTS-authenticated wall clock + monotonic anchor (D-7)
//!
//! The edge agent needs TWO distinct clock readings for different purposes:
//!
//! 1. **Wall clock** for audit timestamps, signature freshness windows,
//!    operator-facing log timestamps — human-meaningful calendar time.
//! 2. **Monotonic clock** for TTL enforcement, per-task scan-cycle budgets,
//!    force-value expiry, HMAC dedup windows — immune to system clock
//!    adjustment.
//!
//! Plan D-7 mandates:
//!
//! - `chrony` + NTS baseline (or PTP for SIL path in Faz 11).
//! - Wall clock MUST NOT be trusted for TTL enforcement — always use
//!   `CLOCK_MONOTONIC`.
//! - Wall clock is trusted for audit timestamps ONLY AFTER a freshness
//!   check against monotonic anchor confirms no skew > ±N seconds since
//!   the last NTS synchronization.
//!
//! This module provides the TYPE SURFACE for those invariants. Sprint 6.7
//! wires the real implementation using `std::time::Instant` + `SystemTime`
//! + a `chronyc tracking`-based NTS-sync freshness query.
//!
//! ## Why a trait (not a struct)
//!
//! The supervisor owns `Arc<dyn ClockAuthority>`. Tests plug a
//! `MockClockAuthority`; production plugs `ChronyClockAuthority`. Trait
//! object dispatch is O(1) with one vtable indirection — acceptable
//! overhead at clock-read-per-command rate.

use std::time::{Duration, SystemTime};

use async_trait::async_trait;

/// Monotonic anchor — a `std::time::Instant`-equivalent point-in-time
/// reference that is GUARANTEED to never move backward. Produced by
/// [`ClockAuthority::monotonic_now`]; compared via subtraction to produce
/// a `Duration`.
///
/// **Why newtype over raw `Instant`:** prevents accidental mixing with
/// `SystemTime` at call sites. A function that takes `MonotonicAnchor`
/// cannot be called with a `SystemTime` by mistake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MonotonicAnchor {
    /// Nanoseconds since an arbitrary process-bound epoch (matches
    /// `std::time::Instant` semantics). Direct subtraction yields a
    /// `Duration` in nanoseconds.
    nanos_since_epoch: u128,
}

impl MonotonicAnchor {
    /// Construct from a nanosecond count. `pub(crate)` so only the
    /// `ClockAuthority` runtime impl (inside this crate) can mint an
    /// anchor; external callers + unrelated edge modules get the
    /// newtype seal — they receive anchors from `ClockAuthority::
    /// monotonic_now()` exclusively.
    ///
    /// EDGE-LOW-002 closure: demoted from `pub` to `pub(crate)` to
    /// enforce the seal. Tests use `for_test` below.
    pub(crate) fn from_nanos_since_process_epoch(nanos: u128) -> Self {
        Self { nanos_since_epoch: nanos }
    }

    /// Test-only ctor — mints an anchor from arbitrary nanos for use in
    /// unit tests. `#[cfg(test)]`-gated so it is NOT available in
    /// production builds.
    #[cfg(test)]
    pub fn for_test(nanos: u128) -> Self {
        Self { nanos_since_epoch: nanos }
    }

    pub fn nanos_since_process_epoch(&self) -> u128 {
        self.nanos_since_epoch
    }

    /// Compute `self - earlier`. Returns structured errors:
    /// - `Err(MonotonicBackward)` if `earlier` is later than `self` (clock
    ///   anomaly — kernel/emulator bug signal).
    /// - `Err(MonotonicOverflow)` if delta exceeds `u64::MAX` nanoseconds
    ///   (~584 years — impossible on real uptime, catches VM clock drift).
    ///
    /// EDGE-MEDIUM-001 closure: previously returned `Option<Duration>`
    /// collapsing both failure classes to None. Result<_, ClockError>
    /// gives operators the telemetry signal they need.
    pub fn saturating_duration_since(
        &self,
        earlier: MonotonicAnchor,
    ) -> Result<Duration, ClockError> {
        let delta = self
            .nanos_since_epoch
            .checked_sub(earlier.nanos_since_epoch)
            .ok_or(ClockError::MonotonicBackward)?;
        let delta_u64 = u64::try_from(delta).map_err(|_| ClockError::MonotonicOverflow)?;
        Ok(Duration::from_nanos(delta_u64))
    }
}

/// Wall-clock reading — carries the SystemTime value, the monotonic
/// anchor at the same instant, AND the NTS synchronization age (EDGE-
/// HIGH-001 closure).
///
/// **Why the NTS sync age is a first-class field:** without it, a
/// consumer stashing a `WallClockReading` for 10 minutes cannot tell
/// "fresh-when-read, stale-now" from "fresh-now". Making the sync age
/// explicit lets consumers (audit writer, signature freshness checker)
/// gate on `nts_sync_age_secs <= threshold` at USE time, not at
/// READ time.
///
/// **Invariants enforced by the runtime impl** (Sprint 6.7):
/// - `nts_sync_age_secs` <= `ClockAuthority::nts_sync_max_skew_secs()`
///   at the moment this reading was produced; `trustworthy_wall_clock`
///   returns `Err(NtsSyncStale)` otherwise.
/// - `system_time` is within the NTS-sync skew window.
/// - `monotonic_anchor` is the monotonic reading at the same instant
///   as `system_time`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallClockReading {
    pub system_time: SystemTime,
    pub monotonic_anchor: MonotonicAnchor,
    /// Age of the last NTS synchronization at the moment this reading
    /// was produced. Consumers compare against a policy threshold to
    /// gate stale-reading reuse.
    pub nts_sync_age_secs: u64,
}

/// Errors from clock authority operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClockError {
    /// NTS sync is stale beyond the policy threshold. The wall clock
    /// cannot be trusted for audit timestamps or signature freshness
    /// windows. Fail-closed — caller must reject time-sensitive operations
    /// until sync recovers.
    NtsSyncStale { last_sync_age_secs: u64, threshold_secs: u64 },

    /// Monotonic anchor went backward — impossible on a correct clock.
    /// Indicates kernel bug or emulator/VM quirk. Fail-closed.
    MonotonicBackward,

    /// Monotonic delta exceeded `u64::MAX` nanoseconds (~584 years).
    /// Unreachable on real uptime; catches VM clock-drift scenarios
    /// where the monotonic counter is bogus. EDGE-MEDIUM-001 closure —
    /// previously collapsed into the `None` return of
    /// `saturating_duration_since` alongside the backward case.
    MonotonicOverflow,

    /// Wall clock is before UNIX_EPOCH. Pre-provisioning power-on with RTC
    /// battery drained scenario. Fail-closed for regulated-action paths.
    PreEpochWallClock,
}

impl std::fmt::Display for ClockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NtsSyncStale { .. } => f.write_str("nts_sync_stale"),
            Self::MonotonicBackward => f.write_str("monotonic_backward"),
            Self::MonotonicOverflow => f.write_str("monotonic_overflow"),
            Self::PreEpochWallClock => f.write_str("pre_epoch_wall_clock"),
        }
    }
}

impl std::error::Error for ClockError {}

/// Clock authority trait — the one surface for time-reading in the edge
/// agent. Direct `SystemTime::now()` / `Instant::now()` calls in new code
/// bypass the NTS-sync guard and the monotonic-coherence checks; Sprint
/// 6.7 wires a clippy lint to flag them.
#[async_trait]
pub trait ClockAuthority: Send + Sync + 'static {
    /// Return a monotonic anchor. Infallible per POSIX CLOCK_MONOTONIC
    /// contract, but the trait returns Result for runtime-verification
    /// (detecting the MonotonicBackward error class).
    fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError>;

    /// Return a trustworthy wall-clock reading. Runs the NTS-sync freshness
    /// check; Err(NtsSyncStale) if the last sync is older than the
    /// configured threshold. Consumers pass the returned `WallClockReading`
    /// to audit/signature code.
    async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError>;

    /// The NTS-sync threshold the authority currently enforces. Sprint
    /// 6.7 defaults to 3600 seconds (hourly re-sync); MQTT heartbeat
    /// metric publishes this value.
    fn nts_sync_max_skew_secs(&self) -> u64;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// WHY (EDGE-MEDIUM-001 regression guard): backward delta returns
    ///      structured MonotonicBackward error.
    #[test]
    fn monotonic_anchor_saturating_duration_since_backward_returns_error() {
        let earlier = MonotonicAnchor::for_test(1_000_000);
        let later = MonotonicAnchor::for_test(5_000_000);
        let err = earlier
            .saturating_duration_since(later)
            .expect_err("backward must error");
        assert_eq!(err, ClockError::MonotonicBackward);
    }

    #[test]
    fn monotonic_anchor_saturating_duration_since_forward_returns_duration() {
        let earlier = MonotonicAnchor::for_test(1_000_000);
        let later = MonotonicAnchor::for_test(5_000_000);
        let d = later.saturating_duration_since(earlier).expect("ok");
        assert_eq!(d, Duration::from_nanos(4_000_000));
    }

    /// WHY (EDGE-MEDIUM-001): delta > u64::MAX nanos returns overflow
    ///      error (distinct from backward).
    #[test]
    fn monotonic_anchor_saturating_duration_since_overflow_returns_error() {
        let earlier = MonotonicAnchor::for_test(0);
        // delta = u128::MAX exceeds u64::MAX → MonotonicOverflow.
        let later = MonotonicAnchor::for_test(u128::MAX);
        let err = later
            .saturating_duration_since(earlier)
            .expect_err("overflow must error");
        assert_eq!(err, ClockError::MonotonicOverflow);
    }

    /// WHY: Anchor ordering — Ord + PartialOrd derive preserve insertion
    ///      ordering for scheduling queues.
    #[test]
    fn monotonic_anchor_ord_preserves_insertion_order() {
        let a = MonotonicAnchor::for_test(100);
        let b = MonotonicAnchor::for_test(200);
        let c = MonotonicAnchor::for_test(150);
        let mut v = vec![a, b, c];
        v.sort();
        assert_eq!(v, vec![a, c, b]);
    }

    /// WHY: ClockError Display format for audit surface.
    #[test]
    fn clock_error_display_snake_case() {
        assert_eq!(
            format!(
                "{}",
                ClockError::NtsSyncStale { last_sync_age_secs: 7200, threshold_secs: 3600 }
            ),
            "nts_sync_stale"
        );
        assert_eq!(
            format!("{}", ClockError::MonotonicBackward),
            "monotonic_backward"
        );
        assert_eq!(
            format!("{}", ClockError::MonotonicOverflow),
            "monotonic_overflow"
        );
        assert_eq!(
            format!("{}", ClockError::PreEpochWallClock),
            "pre_epoch_wall_clock"
        );
    }

    #[test]
    fn clock_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<ClockError>();
    }

    /// WHY: ClockAuthority trait is object-safe (`Arc<dyn ClockAuthority>`).
    #[test]
    fn clock_authority_trait_is_object_safe() {
        struct Mock {
            counter: AtomicU64,
        }

        #[async_trait]
        impl ClockAuthority for Mock {
            fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
                let n = self.counter.fetch_add(1, Ordering::Relaxed);
                Ok(MonotonicAnchor::from_nanos_since_process_epoch(n as u128))
            }

            async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
                Err(ClockError::NtsSyncStale {
                    last_sync_age_secs: 0,
                    threshold_secs: 3600,
                })
            }

            fn nts_sync_max_skew_secs(&self) -> u64 {
                3600
            }
        }

        fn assert_object_safe(_: &dyn ClockAuthority) {}
        let m = Mock { counter: AtomicU64::new(0) };
        assert_object_safe(&m);
    }

    /// WHY: WallClockReading value preserved — fields accessible, including
    ///      the nts_sync_age_secs field added for EDGE-HIGH-001 closure.
    #[test]
    fn wall_clock_reading_field_access() {
        let reading = WallClockReading {
            system_time: SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            monotonic_anchor: MonotonicAnchor::for_test(12_345),
            nts_sync_age_secs: 42,
        };
        assert_eq!(
            reading
                .system_time
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("ok")
                .as_secs(),
            1_700_000_000
        );
        assert_eq!(reading.monotonic_anchor.nanos_since_process_epoch(), 12_345);
        assert_eq!(reading.nts_sync_age_secs, 42);
    }

    /// WHY (EDGE-HIGH-001 regression guard): `nts_sync_age_secs` is a
    ///      first-class field. A consumer gates trust on this value at
    ///      USE time (not at READ time), closing the "stash a reading
    ///      and reuse past freshness" attack surface.
    #[test]
    fn wall_clock_reading_carries_nts_sync_age_for_consumer_gating() {
        // Policy: audit writer accepts readings with sync age < 3600s.
        let policy_threshold = 3600u64;
        let fresh = WallClockReading {
            system_time: SystemTime::UNIX_EPOCH,
            monotonic_anchor: MonotonicAnchor::for_test(0),
            nts_sync_age_secs: 60,
        };
        let stale = WallClockReading {
            system_time: SystemTime::UNIX_EPOCH,
            monotonic_anchor: MonotonicAnchor::for_test(0),
            nts_sync_age_secs: 7200,
        };
        assert!(fresh.nts_sync_age_secs < policy_threshold);
        assert!(stale.nts_sync_age_secs >= policy_threshold);
    }
}
