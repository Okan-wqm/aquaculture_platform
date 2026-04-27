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

// ===================================================================
// Batch #313 D-9 — MonotonicDeadline primitive
// ===================================================================
//
// `MonotonicDeadline` is a typed wrapper that solves the operator
// clock rollback problem for TTL paths. The pattern shipped before
// this batch:
//
//   if expires_at_unix < SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() {
//       // expired — reject
//   }
//
// is vulnerable: an operator who rolls the wall clock back to T-1h
// makes every deadline appear NOT-yet-expired again. Force-value
// expiry, JWT exp gate, jti TTL, session timeout, rotation deadline
// — all break.
//
// Architectural fix (Tier 1, type-system-enforced):
//
// 1. Construct `MonotonicDeadline::from_wallclock_target(target,
//    clock)` once at the moment the deadline is established (e.g.,
//    when a force command is registered with TTL=N).
// 2. The ctor captures the equivalent monotonic anchor at
//    construction time: `monotonic_target = monotonic_now +
//    (target_wallclock - wallclock_now)`.
// 3. is_past_now(clock) compares `clock.monotonic_now()` against
//    the captured `monotonic_target`. CLOCK_MONOTONIC NEVER
//    moves backward (POSIX guarantee + ClockAuthority's
//    MonotonicBackward error catches kernel bugs).
//
// Operator clock rollback after construction CANNOT extend the
// deadline because the captured monotonic_target is decoupled from
// the wall clock.
//
// Construction MUST be careful about wallclock-NOW reading: we use
// `clock.trustworthy_wall_clock()` so a stale-NTS reading at
// construction is rejected with NtsSyncStale before we capture the
// anchor. The deadline is only valid if the construction-time wall
// clock was trustworthy.

use std::time::Duration as StdDuration;

/// Monotonic deadline — captures a wall-clock target as a monotonic
/// anchor at construction so subsequent past-now checks are immune
/// to operator clock rollback.
///
/// **Construction is FALLIBLE** — a stale-NTS clock at construction
/// time, a target SystemTime that is BEFORE the current wall clock
/// (already-past at construction), or an arithmetic overflow on the
/// anchor calculation all return structured errors.
///
/// **`is_past_now(clock)` is INFALLIBLE except for `MonotonicBackward` /
/// `MonotonicOverflow`** propagated from the clock authority — those
/// are kernel-bug signals. The wall clock is NEVER consulted in
/// the past-now path; that is the architectural property.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MonotonicDeadline {
    /// Captured monotonic anchor representing the deadline. The
    /// past-now check compares `clock.monotonic_now()` against
    /// this value.
    monotonic_target: MonotonicAnchor,
}

/// Errors specific to `MonotonicDeadline` construction. Distinct
/// from `ClockError` so callers can discriminate "couldn't
/// construct deadline" from "clock authority broken".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonotonicDeadlineError {
    /// Underlying clock authority error (NTS stale, monotonic
    /// backward, pre-epoch wallclock). Propagated verbatim.
    Clock(ClockError),
    /// The target SystemTime is BEFORE the current wallclock — the
    /// deadline is already past at construction. Caller decides:
    /// some paths reject (cannot register an already-past deadline);
    /// others accept (e.g., immediate-expire is meaningful).
    ///
    /// Carries the by-how-much value so audit can correlate "clock
    /// drifted N seconds during registration" cases.
    AlreadyPastAtConstruction { by_secs: u64 },
    /// Target - wallclock_now exceeds u64::MAX nanoseconds (~584
    /// years). Unreachable under normal operation; catches malformed
    /// JWT exp claims (e.g. `exp = i64::MAX`).
    DurationOverflow,
}

impl std::fmt::Display for MonotonicDeadlineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Clock(e) => write!(f, "monotonic_deadline_clock_error: {}", e),
            Self::AlreadyPastAtConstruction { by_secs } => write!(
                f,
                "monotonic_deadline_already_past_at_construction_by_{}s",
                by_secs
            ),
            Self::DurationOverflow => f.write_str("monotonic_deadline_duration_overflow"),
        }
    }
}

impl std::error::Error for MonotonicDeadlineError {}

impl From<ClockError> for MonotonicDeadlineError {
    fn from(e: ClockError) -> Self {
        Self::Clock(e)
    }
}

impl MonotonicDeadline {
    /// Construct from a wallclock target + a clock authority that
    /// gives us a trustworthy wallclock reading + a monotonic
    /// anchor at the SAME moment.
    ///
    /// **Why async:** `trustworthy_wall_clock` is async per the
    /// ClockAuthority trait (the chrony query is potentially
    /// async). Construction is on cold-path (registration time),
    /// so the async cost is acceptable.
    pub async fn from_wallclock_target(
        target_wallclock: SystemTime,
        clock: &dyn ClockAuthority,
    ) -> Result<Self, MonotonicDeadlineError> {
        // Pull a trustworthy reading — this fails-closed on stale
        // NTS, propagating ClockError verbatim.
        let now_reading = clock.trustworthy_wall_clock().await?;

        // Compute target - wallclock_now as a Duration. If target
        // is before now_reading.system_time, the subtraction
        // returns Err — the deadline is already past at
        // construction.
        match target_wallclock.duration_since(now_reading.system_time) {
            Ok(delta_to_target) => {
                let delta_nanos = delta_to_target.as_nanos();
                // Add to the captured monotonic anchor.
                let target_nanos = now_reading
                    .monotonic_anchor
                    .nanos_since_process_epoch()
                    .checked_add(delta_nanos)
                    .ok_or(MonotonicDeadlineError::DurationOverflow)?;
                Ok(Self {
                    monotonic_target:
                        MonotonicAnchor::from_nanos_since_process_epoch(target_nanos),
                })
            }
            Err(e) => {
                // The system time is AFTER the target — already past.
                let by_secs = e.duration().as_secs();
                Err(MonotonicDeadlineError::AlreadyPastAtConstruction {
                    by_secs,
                })
            }
        }
    }

    /// Construct from a duration-from-now. Convenience for the
    /// common pattern "TTL=N seconds" where the caller knows the
    /// duration but doesn't have a SystemTime to anchor against.
    ///
    /// Uses the same trustworthy_wall_clock() fail-closed gate at
    /// construction — keeps the architectural property that a
    /// stale-NTS clock cannot mint a deadline.
    pub async fn from_duration_now(
        duration_from_now: StdDuration,
        clock: &dyn ClockAuthority,
    ) -> Result<Self, MonotonicDeadlineError> {
        let now_reading = clock.trustworthy_wall_clock().await?;
        let delta_nanos = duration_from_now.as_nanos();
        let target_nanos = now_reading
            .monotonic_anchor
            .nanos_since_process_epoch()
            .checked_add(delta_nanos)
            .ok_or(MonotonicDeadlineError::DurationOverflow)?;
        Ok(Self {
            monotonic_target:
                MonotonicAnchor::from_nanos_since_process_epoch(target_nanos),
        })
    }

    /// Test-only ctor — mints a deadline directly from a
    /// monotonic anchor. Used by unit tests + by the no-op
    /// migration path where a caller has already converted to
    /// monotonic.
    #[cfg(test)]
    pub fn from_monotonic_anchor_for_test(target: MonotonicAnchor) -> Self {
        Self {
            monotonic_target: target,
        }
    }

    /// Captured monotonic anchor accessor — for audit + metrics.
    /// Does NOT consult any clock; pure getter.
    pub fn monotonic_target(&self) -> MonotonicAnchor {
        self.monotonic_target
    }

    /// Is the deadline past NOW per the clock authority's monotonic
    /// reading? Wallclock is NEVER consulted — operator clock
    /// rollback after construction has NO effect on this answer.
    ///
    /// Returns `Err(ClockError::MonotonicBackward)` if the kernel /
    /// emulator monotonic clock is broken (caller fail-closed:
    /// reject the time-sensitive operation).
    pub fn is_past_now(
        &self,
        clock: &dyn ClockAuthority,
    ) -> Result<bool, ClockError> {
        let now = clock.monotonic_now()?;
        Ok(now >= self.monotonic_target)
    }

    /// Remaining duration until the deadline. Returns
    /// `Ok(Duration::ZERO)` when already past. Returns
    /// `Err(ClockError::MonotonicBackward)` on broken clock.
    pub fn remaining_now(
        &self,
        clock: &dyn ClockAuthority,
    ) -> Result<StdDuration, ClockError> {
        let now = clock.monotonic_now()?;
        if now >= self.monotonic_target {
            return Ok(StdDuration::ZERO);
        }
        // monotonic_target > now → subtraction is forward.
        self.monotonic_target.saturating_duration_since(now)
    }
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

    // ===============================================================
    // Batch #313 D-9 — MonotonicDeadline tests
    // ===============================================================
    //
    // Driven by a programmable mock clock so the wallclock target +
    // monotonic anchor can be controlled deterministically. Mock
    // implements ClockAuthority + lets the test specify what
    // `monotonic_now` and `trustworthy_wall_clock` return.

    use std::sync::Mutex;

    struct ProgrammableMockClock {
        state: Mutex<MockClockState>,
    }

    struct MockClockState {
        wallclock: SystemTime,
        monotonic_nanos: u128,
        nts_sync_age_secs: u64,
        threshold: u64,
        force_pre_epoch: bool,
        force_nts_stale: bool,
    }

    impl ProgrammableMockClock {
        fn new(wallclock: SystemTime, monotonic_nanos: u128) -> Self {
            Self {
                state: Mutex::new(MockClockState {
                    wallclock,
                    monotonic_nanos,
                    nts_sync_age_secs: 0,
                    threshold: 3600,
                    force_pre_epoch: false,
                    force_nts_stale: false,
                }),
            }
        }
        fn advance_monotonic(&self, by_nanos: u128) {
            let mut s = self.state.lock().unwrap();
            s.monotonic_nanos = s.monotonic_nanos.saturating_add(by_nanos);
        }
        fn set_wallclock(&self, t: SystemTime) {
            self.state.lock().unwrap().wallclock = t;
        }
        fn set_force_nts_stale(&self, v: bool) {
            self.state.lock().unwrap().force_nts_stale = v;
        }
    }

    #[async_trait]
    impl ClockAuthority for ProgrammableMockClock {
        fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
            let s = self.state.lock().unwrap();
            Ok(MonotonicAnchor::from_nanos_since_process_epoch(
                s.monotonic_nanos,
            ))
        }
        async fn trustworthy_wall_clock(
            &self,
        ) -> Result<WallClockReading, ClockError> {
            let s = self.state.lock().unwrap();
            if s.force_pre_epoch {
                return Err(ClockError::PreEpochWallClock);
            }
            if s.force_nts_stale {
                return Err(ClockError::NtsSyncStale {
                    last_sync_age_secs: s.nts_sync_age_secs,
                    threshold_secs: s.threshold,
                });
            }
            Ok(WallClockReading {
                system_time: s.wallclock,
                monotonic_anchor: MonotonicAnchor::from_nanos_since_process_epoch(
                    s.monotonic_nanos,
                ),
                nts_sync_age_secs: s.nts_sync_age_secs,
            })
        }
        fn nts_sync_max_skew_secs(&self) -> u64 {
            self.state.lock().unwrap().threshold
        }
    }

    /// Construction captures the monotonic anchor at the
    /// SAME instant as the wallclock reading — subsequent
    /// wallclock changes do NOT shift the deadline.
    #[tokio::test]
    async fn monotonic_deadline_constructs_from_wallclock_target() {
        let now_wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = ProgrammableMockClock::new(now_wall, 1_000_000_000);
        let target = now_wall + Duration::from_secs(60);
        let deadline = MonotonicDeadline::from_wallclock_target(target, &clock)
            .await
            .expect("ctor succeeds");
        // Captured monotonic = mock_monotonic + 60s in nanos.
        let expected_monotonic_nanos = 1_000_000_000u128 + 60 * 1_000_000_000;
        assert_eq!(
            deadline.monotonic_target().nanos_since_process_epoch(),
            expected_monotonic_nanos,
        );
    }

    /// Architectural property: clock rollback AFTER construction
    /// does NOT extend the deadline. Wallclock moves backward by
    /// 1 hour; monotonic clock advances forward by 30s; deadline
    /// originally 60s in the future is still NOT past after 30s
    /// of monotonic advance, regardless of wallclock state.
    #[tokio::test]
    async fn clock_rollback_after_construction_does_not_extend_deadline() {
        let now_wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = ProgrammableMockClock::new(now_wall, 1_000_000_000);
        let target = now_wall + Duration::from_secs(60);
        let deadline = MonotonicDeadline::from_wallclock_target(target, &clock)
            .await
            .expect("ctor succeeds");

        // Operator rolls wallclock backward by 1 hour.
        clock.set_wallclock(now_wall - Duration::from_secs(3600));
        // Monotonic advances 30s.
        clock.advance_monotonic(30 * 1_000_000_000);
        // Not past yet (60s deadline, 30s elapsed monotonic).
        assert!(!deadline.is_past_now(&clock).expect("ok"));

        // Monotonic advances another 31s — past total.
        clock.advance_monotonic(31 * 1_000_000_000);
        assert!(deadline.is_past_now(&clock).expect("ok"));

        // Even if wallclock stays rolled-back, the monotonic
        // deadline's past status is unchanged. Wallclock state
        // is irrelevant after construction.
    }

    /// Already-past target at construction returns the structured
    /// error with by_secs populated.
    #[tokio::test]
    async fn already_past_target_returns_structured_error() {
        let now_wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = ProgrammableMockClock::new(now_wall, 1_000_000_000);
        let target = now_wall - Duration::from_secs(120);
        let err = MonotonicDeadline::from_wallclock_target(target, &clock)
            .await
            .expect_err("already-past must error");
        match err {
            MonotonicDeadlineError::AlreadyPastAtConstruction { by_secs } => {
                assert_eq!(by_secs, 120);
            }
            _ => panic!("expected AlreadyPastAtConstruction, got {:?}", err),
        }
    }

    /// NTS-stale clock at construction propagates as Clock(NtsSyncStale)
    /// — the deadline cannot be minted with an untrustworthy clock.
    #[tokio::test]
    async fn nts_stale_clock_at_construction_rejects_deadline() {
        let now_wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = ProgrammableMockClock::new(now_wall, 1_000_000_000);
        clock.set_force_nts_stale(true);
        let target = now_wall + Duration::from_secs(60);
        let err = MonotonicDeadline::from_wallclock_target(target, &clock)
            .await
            .expect_err("NTS stale must error");
        assert!(matches!(
            err,
            MonotonicDeadlineError::Clock(ClockError::NtsSyncStale { .. })
        ));
    }

    /// from_duration_now mints a deadline N nanos ahead of the
    /// current monotonic anchor; is_past_now returns false until
    /// monotonic advances past N.
    #[tokio::test]
    async fn from_duration_now_anchors_to_monotonic() {
        let now_wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = ProgrammableMockClock::new(now_wall, 1_000_000_000);
        let deadline = MonotonicDeadline::from_duration_now(
            Duration::from_secs(10),
            &clock,
        )
        .await
        .expect("ctor succeeds");
        assert!(!deadline.is_past_now(&clock).expect("ok"));
        clock.advance_monotonic(11 * 1_000_000_000);
        assert!(deadline.is_past_now(&clock).expect("ok"));
    }

    /// remaining_now returns Duration::ZERO past deadline.
    #[tokio::test]
    async fn remaining_now_is_zero_past_deadline() {
        let now_wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = ProgrammableMockClock::new(now_wall, 1_000_000_000);
        let deadline = MonotonicDeadline::from_duration_now(
            Duration::from_secs(5),
            &clock,
        )
        .await
        .expect("ctor succeeds");
        clock.advance_monotonic(10 * 1_000_000_000);
        assert_eq!(
            deadline.remaining_now(&clock).expect("ok"),
            Duration::ZERO
        );
    }

    /// remaining_now returns positive Duration before deadline.
    #[tokio::test]
    async fn remaining_now_is_positive_before_deadline() {
        let now_wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = ProgrammableMockClock::new(now_wall, 1_000_000_000);
        let deadline = MonotonicDeadline::from_duration_now(
            Duration::from_secs(60),
            &clock,
        )
        .await
        .expect("ctor succeeds");
        clock.advance_monotonic(20 * 1_000_000_000);
        let r = deadline.remaining_now(&clock).expect("ok");
        // 40 seconds remaining give-or-take stack noise (mock is
        // exact; equality holds).
        assert_eq!(r, Duration::from_secs(40));
    }

    /// MonotonicDeadlineError Display strings pinned (audit-stable).
    #[test]
    fn monotonic_deadline_error_display_strings_pinned() {
        assert_eq!(
            format!("{}", MonotonicDeadlineError::DurationOverflow),
            "monotonic_deadline_duration_overflow"
        );
        assert_eq!(
            format!(
                "{}",
                MonotonicDeadlineError::AlreadyPastAtConstruction { by_secs: 42 }
            ),
            "monotonic_deadline_already_past_at_construction_by_42s"
        );
        assert!(format!(
            "{}",
            MonotonicDeadlineError::Clock(ClockError::MonotonicBackward)
        )
        .contains("monotonic_backward"));
    }

    #[test]
    fn monotonic_deadline_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<MonotonicDeadlineError>();
    }

    /// Ord on MonotonicDeadline preserves insertion order — used
    /// by force_registry-style sorted-by-deadline scheduling.
    #[test]
    fn monotonic_deadline_ord_preserves_target_order() {
        let a = MonotonicDeadline::from_monotonic_anchor_for_test(
            MonotonicAnchor::for_test(100),
        );
        let b = MonotonicDeadline::from_monotonic_anchor_for_test(
            MonotonicAnchor::for_test(200),
        );
        let c = MonotonicDeadline::from_monotonic_anchor_for_test(
            MonotonicAnchor::for_test(150),
        );
        let mut v = vec![b, a, c];
        v.sort();
        assert_eq!(v, vec![a, c, b]);
    }
}
