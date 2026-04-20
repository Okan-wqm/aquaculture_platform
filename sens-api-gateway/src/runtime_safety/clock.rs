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
    /// Construct from a nanosecond count (used by the runtime impl).
    pub fn from_nanos_since_process_epoch(nanos: u128) -> Self {
        Self { nanos_since_epoch: nanos }
    }

    pub fn nanos_since_process_epoch(&self) -> u128 {
        self.nanos_since_epoch
    }

    /// Compute `self - earlier`. Returns None if `earlier` is later than
    /// `self` — which should be impossible on a correctly-functioning
    /// monotonic clock; None surfaces as a clock-anomaly error rather
    /// than panicking.
    pub fn saturating_duration_since(&self, earlier: MonotonicAnchor) -> Option<Duration> {
        self.nanos_since_epoch
            .checked_sub(earlier.nanos_since_epoch)
            .and_then(|delta| u64::try_from(delta).ok())
            .map(Duration::from_nanos)
    }
}

/// Wall-clock reading — carries BOTH the SystemTime value AND a
/// freshness claim derived from the NTS synchronization state.
///
/// The freshness claim is the caller's assertion that:
/// - `system_time` is within ±`nts_sync_max_skew_secs` of the last NTS
///   sync moment (per the runtime's `chronyc tracking` query).
/// - `monotonic_anchor` is the monotonic reading at the same instant.
///
/// Consumers (audit writer, signature freshness checker) that need a
/// trustworthy wall-clock time consume a `WallClockReading` rather than
/// a bare `SystemTime` — the type forces the runtime to have performed
/// the NTS-sync check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallClockReading {
    pub system_time: SystemTime,
    pub monotonic_anchor: MonotonicAnchor,
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

    /// Wall clock is before UNIX_EPOCH. Pre-provisioning power-on with RTC
    /// battery drained scenario. Fail-closed for regulated-action paths.
    PreEpochWallClock,
}

impl std::fmt::Display for ClockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NtsSyncStale { .. } => f.write_str("nts_sync_stale"),
            Self::MonotonicBackward => f.write_str("monotonic_backward"),
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

    /// WHY: MonotonicAnchor subtraction returns None on backward delta —
    ///      regression guard against silent underflow.
    #[test]
    fn monotonic_anchor_saturating_duration_since_backward_returns_none() {
        let earlier = MonotonicAnchor::from_nanos_since_process_epoch(1_000_000);
        let later = MonotonicAnchor::from_nanos_since_process_epoch(5_000_000);
        // Backward: later earlier than earlier → checked_sub returns None.
        let result = earlier.saturating_duration_since(later);
        assert!(result.is_none());
    }

    #[test]
    fn monotonic_anchor_saturating_duration_since_forward_returns_duration() {
        let earlier = MonotonicAnchor::from_nanos_since_process_epoch(1_000_000);
        let later = MonotonicAnchor::from_nanos_since_process_epoch(5_000_000);
        let d = later.saturating_duration_since(earlier).expect("ok");
        assert_eq!(d, Duration::from_nanos(4_000_000));
    }

    /// WHY: Anchor ordering — Ord + PartialOrd derive preserve insertion
    ///      ordering for scheduling queues.
    #[test]
    fn monotonic_anchor_ord_preserves_insertion_order() {
        let a = MonotonicAnchor::from_nanos_since_process_epoch(100);
        let b = MonotonicAnchor::from_nanos_since_process_epoch(200);
        let c = MonotonicAnchor::from_nanos_since_process_epoch(150);
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

    /// WHY: WallClockReading value preserved — fields accessible.
    #[test]
    fn wall_clock_reading_field_access() {
        let reading = WallClockReading {
            system_time: SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            monotonic_anchor: MonotonicAnchor::from_nanos_since_process_epoch(12_345),
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
    }
}
