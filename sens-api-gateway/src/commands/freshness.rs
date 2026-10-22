//! The instant a command's freshness is judged at (ADR-048 DEC-7.5,
//! EDGE-MEDIUM-077).
//!
//! A command envelope is valid between its `iat` and `exp`; an RBAC manifest and
//! a role carry validity windows too. Every one of those decisions compares a
//! signed time with "now". A "now" read straight from the system clock says
//! nothing about whether anyone disciplined that clock: a device that booted
//! without an RTC starts at the epoch, and a clock stepped back makes an expired
//! command valid again — with physical actuation as the consequence.
//!
//! So the command path reads "now" in one place, from the agent's
//! [`ClockAuthority`]. On Suderra OS that is root's time document: while it does
//! not report a synchronized clock the authority returns an error, the command
//! is refused with the retryable `clock-unsynced` before any signature is
//! verified (the work is spent on nothing), and the check is never skipped.
//! Local control, safe-state and alarms never come through here and run in every
//! state.
//!
//! `tests/invariants/clock_gated_freshness.rs` pins that the command path reads
//! no other clock.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime_safety::{ClockAuthority, ClockError};

/// A wall-clock instant the clock authority vouches for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FreshNow {
    /// Seconds since the Unix epoch: what an envelope's `iat`/`exp` are.
    pub unix_secs: i64,
    /// The same instant, for the RBAC manifest and role windows.
    pub system_time: SystemTime,
}

impl FreshNow {
    /// The same instant as a calendar time, for the replay window of a command
    /// that carries an RFC 3339 timestamp. An instant chrono cannot represent
    /// saturates to the latest one, which makes every command stale: fail closed.
    pub(super) fn utc(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp(self.unix_secs, 0)
            .unwrap_or(chrono::DateTime::<chrono::Utc>::MAX_UTC)
    }

    /// An instant of the wall clock the authority vouched for; a clock before
    /// the epoch is not one.
    fn from_system_time(system_time: SystemTime) -> Result<Self, ClockError> {
        let since_epoch = system_time
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ClockError::PreEpochWallClock)?;
        Ok(Self {
            unix_secs: saturating_unix_secs(since_epoch),
            system_time,
        })
    }
}

/// Seconds since the epoch as the `i64` an envelope's `iat`/`exp` are. A clock
/// past `i64::MAX` seconds makes every envelope expired: the saturation fails
/// closed.
fn saturating_unix_secs(since_epoch: std::time::Duration) -> i64 {
    i64::try_from(since_epoch.as_secs()).unwrap_or(i64::MAX)
}

/// "Now" for a freshness decision, or why the authority will not give one.
pub(super) async fn fresh_now(clock: &dyn ClockAuthority) -> Result<FreshNow, ClockError> {
    let reading = clock.trustworthy_wall_clock().await?;
    FreshNow::from_system_time(reading.system_time)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use async_trait::async_trait;

    use super::*;
    use crate::runtime_safety::{MonotonicAnchor, UnsyncedCause, WallClockReading};

    /// A clock authority that answers with a fixed result.
    struct FixedClock(Result<SystemTime, ClockError>);

    #[async_trait]
    impl ClockAuthority for FixedClock {
        fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
            Ok(MonotonicAnchor::for_test(0))
        }

        async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
            self.0.clone().map(|system_time| WallClockReading {
                system_time,
                monotonic_anchor: MonotonicAnchor::for_test(0),
                nts_sync_age_secs: 0,
            })
        }

        fn nts_sync_max_skew_secs(&self) -> u64 {
            3600
        }
    }

    #[tokio::test]
    async fn now_is_the_authority_s_reading_not_the_system_clock() {
        let instant = UNIX_EPOCH + Duration::from_secs(1_700_000_123);
        let now = fresh_now(&FixedClock(Ok(instant)))
            .await
            .expect("a reading");
        assert_eq!(now.unix_secs, 1_700_000_123);
        assert_eq!(now.system_time, instant);
    }

    #[test]
    fn a_clock_beyond_the_i64_seconds_saturates_closed() {
        assert_eq!(
            saturating_unix_secs(Duration::from_secs(u64::MAX)),
            i64::MAX
        );
        assert_eq!(
            saturating_unix_secs(Duration::from_secs(1_700_000_000)),
            1_700_000_000
        );
    }

    #[test]
    fn the_calendar_time_is_the_same_instant_and_saturates_closed() {
        let now = FreshNow::from_system_time(UNIX_EPOCH + Duration::from_secs(1_700_000_123))
            .expect("a reading");
        assert_eq!(now.utc().timestamp(), 1_700_000_123);
        let beyond = FreshNow {
            unix_secs: i64::MAX,
            system_time: UNIX_EPOCH,
        };
        assert_eq!(beyond.utc(), chrono::DateTime::<chrono::Utc>::MAX_UTC);
    }

    #[tokio::test]
    async fn an_authority_that_does_not_vouch_gives_no_now() {
        for error in [
            ClockError::Unsynced(UnsyncedCause::ReportedUnsynced),
            ClockError::NtsSyncStale {
                last_sync_age_secs: 7200,
                threshold_secs: 3600,
            },
            ClockError::PreEpochWallClock,
            ClockError::MonotonicBackward,
        ] {
            assert_eq!(
                fresh_now(&FixedClock(Err(error.clone()))).await,
                Err(error.clone()),
                "{error:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_reading_before_the_epoch_is_no_now() {
        let before = UNIX_EPOCH - Duration::from_secs(1);
        assert_eq!(
            fresh_now(&FixedClock(Ok(before))).await,
            Err(ClockError::PreEpochWallClock)
        );
    }
}
