//! Keystore rotation deadline (Batch #315 D-1b primitive).
//!
//! ## Why
//!
//! ADR-018 §6 + Plan §5 Faz 2 D-1b mandate a 180-day
//! rotation cadence for the file-backed master key.
//! Argon2id-derived masters bound to a fixed passphrase +
//! salt accumulate cryptographic exposure over time:
//! attacker brute-force feasibility grows as compute
//! cheapens; legitimate operator turnover means the
//! pre-rotation passphrase may have been observed by
//! more eyes than the current threat model assumes.
//!
//! Pre-Batch-#315 the `FileBackedKeystore` had a working
//! `rotate_master_from_files` primitive (Batch 98) but
//! NO architectural notion of "this master is overdue
//! for rotation". Operators relied on calendar reminders
//! + manual checklist discipline — a process gap that
//! ICS regulatory frameworks (IEC 62443 SL-2 4.6.5
//! Cryptographic Key Management) flag as a non-conformity.
//!
//! ## Architectural fix (Tier 3 — make-it-detectable)
//!
//! `KeystoreRotationDeadline` captures three facts:
//!
//! 1. WHEN the master was last rotated (wall-clock seconds
//!    since UNIX_EPOCH — persisted to disk so the deadline
//!    survives reboots; the wall-clock anchor is the
//!    correct semantic for cross-restart scheduling
//!    because the operator ceremony is a wall-clock event,
//!    not a process-bound event).
//! 2. The rotation PERIOD (default 180 days per ADR-018 §6).
//! 3. The alarm LEAD TIME — how far in advance to start
//!    raising the structured audit event (default 30 days
//!    so operators have a full month to plan the ceremony).
//!
//! `evaluate(&dyn ClockAuthority)` returns one of three
//! `RotationStatus` variants:
//!
//! - `WithinPolicy { remaining }` — period - elapsed >
//!   alarm_lead_time. No alarm. Operator may rotate
//!   electively but is not required to.
//! - `LeadTimeExceeded { remaining }` — 0 < period -
//!   elapsed <= alarm_lead_time. Audit emits a STRUCTURED
//!   `keystore_rotation_lead_time_exceeded` event;
//!   operator dashboard surfaces the countdown. NOT
//!   fail-closed — the master is still cryptographically
//!   valid until the period elapses.
//! - `Overdue { by }` — elapsed > period. Audit emits a
//!   STRUCTURED `keystore_rotation_overdue` event;
//!   `config.security.keystore_rotation_overdue_fail_closed`
//!   gate (future Sprint 6.7 wire) decides whether the
//!   agent refuses keystore-derived operations until
//!   rotation lands.
//!
//! ## Why wall-clock + clock authority (not MonotonicDeadline)
//!
//! The rotation deadline is INHERENTLY a calendar-time
//! event: the operator scheduling team plans the ceremony
//! against a wall-clock date ("rotate before Q4 close").
//! Operator clock rollback is a separate concern handled
//! by ClockAuthority's NTS-stale gate — `evaluate` calls
//! `clock.trustworthy_wall_clock()` so a rolled-back NTS-
//! unsynced clock returns Err(ClockError::NtsSyncStale)
//! and the alarm runner fail-skips the tick. This is the
//! correct architectural shape for cross-restart calendar
//! events; using a process-bound MonotonicDeadline would
//! lose the rotation timestamp on every reboot.
//!
//! ## Persistence shape
//!
//! `last_rotation_at_unix_secs: i64` is persisted under
//! `$SUDERRA_DATA_DIR/keystore_rotation_marker.json` as a
//! single JSON record with the timestamp + a magic
//! version tag for future schema evolution. The file is
//! rewritten atomically (temp file + rename) on every
//! successful `rotate_master_from_files` call. Read at
//! boot to construct the runtime `KeystoreRotationDeadline`.
//!
//! ## Scope of THIS batch
//!
//! Primitive-only batch matching the project's primitive-
//! first discipline (Batch 4b types-first split for
//! keystore; Batch #305 wire-only for CommandEnvelope v3;
//! Batch #308 TpmDevice trait without RealTpmDevice;
//! Batch #313 MonotonicDeadline without consumer wiring).
//!
//! This batch lands:
//!
//! - `KeystoreRotationDeadline` type + ctor + `evaluate`.
//! - `RotationStatus` enum.
//! - `RotationDeadlineError` taxonomy.
//! - 8+ unit tests pinning the boundary semantics
//!   (within-policy / lead-time / overdue) + clock
//!   authority error propagation.
//!
//! What this batch DOES NOT include (the D-1b arc
//! continues toward UH ULTRA-MEDIUM-007 closure):
//!
//! - Persistence layer (atomic-write JSON marker file +
//!   load-at-boot).
//! - FileBackedKeystore integration:
//!   `rotate_master_from_files` updates the marker;
//!   `open` constructs the deadline from the marker;
//!   `rotation_status()` accessor on the keystore.
//! - Background alarm runner task (1-hour interval +
//!   audit event emission + `config.security.
//!   keystore_rotation_overdue_fail_closed` gate).
//! - Operator runbook entry for the rotation ceremony.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::runtime_safety::clock::{ClockAuthority, ClockError};

/// Default rotation period — 180 days per ADR-018 §6.
/// Operator-tunable via `config.security.keystore_rotation_period_days`.
pub const DEFAULT_ROTATION_PERIOD_DAYS: u64 = 180;

/// Default alarm lead time — 30 days. Means the
/// `LeadTimeExceeded` status starts firing 30 days before
/// the period elapses, giving the operator team a full
/// month to schedule the ceremony.
pub const DEFAULT_ALARM_LEAD_TIME_DAYS: u64 = 30;

/// Errors returned by `KeystoreRotationDeadline::evaluate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RotationDeadlineError {
    /// Underlying ClockAuthority error — NtsSyncStale,
    /// MonotonicBackward, PreEpochWallClock — propagated
    /// verbatim. Caller (alarm runner) skips the tick +
    /// retries on the next interval.
    Clock(ClockError),
    /// `last_rotation_at_unix_secs` is in the future
    /// (later than the current trustworthy wallclock
    /// reading). Indicates a corrupted marker file or an
    /// operator clock disaster scenario; operator must
    /// reconcile manually before the deadline subsystem
    /// can proceed.
    LastRotationInFuture {
        last_unix_secs: i64,
        now_unix_secs: i64,
    },
    /// Configuration invalid — alarm_lead_time exceeds
    /// rotation_period (would make every freshly-rotated
    /// master immediately Overdue). Caught at construction
    /// time.
    LeadTimeExceedsPeriod { lead_secs: u64, period_secs: u64 },
}

impl std::fmt::Display for RotationDeadlineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Clock(e) => write!(f, "rotation_deadline_clock_error: {}", e),
            Self::LastRotationInFuture {
                last_unix_secs,
                now_unix_secs,
            } => write!(
                f,
                "rotation_deadline_last_rotation_in_future: last={} now={}",
                last_unix_secs, now_unix_secs
            ),
            Self::LeadTimeExceedsPeriod {
                lead_secs,
                period_secs,
            } => write!(
                f,
                "rotation_deadline_lead_time_{}s_exceeds_period_{}s",
                lead_secs, period_secs
            ),
        }
    }
}

impl std::error::Error for RotationDeadlineError {}

impl From<ClockError> for RotationDeadlineError {
    fn from(e: ClockError) -> Self {
        Self::Clock(e)
    }
}

/// Three-state evaluation outcome. Each state carries the
/// relevant duration so audit/dashboard consumers can
/// display the remaining-time / overdue-by countdown
/// directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationStatus {
    /// `period - elapsed > alarm_lead_time`. No alarm.
    WithinPolicy { remaining: Duration },
    /// `0 < period - elapsed <= alarm_lead_time`. Audit
    /// emits structured event; operator dashboard
    /// surfaces countdown.
    LeadTimeExceeded { remaining: Duration },
    /// `elapsed >= period`. Audit emits structured event;
    /// fail-closed gate (future config flag) blocks
    /// keystore-derived operations.
    Overdue { by: Duration },
}

impl RotationStatus {
    /// Operator-readable one-line summary. Used by
    /// boot-log / audit-event / dashboard rendering.
    pub fn summary_string(&self) -> String {
        match self {
            Self::WithinPolicy { remaining } => {
                format!("within_policy_{}d_remaining", remaining.as_secs() / 86_400)
            }
            Self::LeadTimeExceeded { remaining } => format!(
                "lead_time_exceeded_{}d_remaining",
                remaining.as_secs() / 86_400
            ),
            Self::Overdue { by } => {
                format!("overdue_by_{}d", by.as_secs() / 86_400)
            }
        }
    }

    /// True when the status carries an alarm signal — used
    /// by the alarm runner to gate audit emission.
    pub fn is_alarm(&self) -> bool {
        matches!(self, Self::LeadTimeExceeded { .. } | Self::Overdue { .. })
    }
}

/// Rotation deadline tracker. Constructed at boot from
/// the persisted marker file + the operator-configured
/// rotation period + alarm lead time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeystoreRotationDeadline {
    last_rotation_at_unix_secs: i64,
    rotation_period: Duration,
    alarm_lead_time: Duration,
}

impl KeystoreRotationDeadline {
    /// Construct with explicit period + lead time. Validates
    /// `lead <= period` at construction; rejects with
    /// `LeadTimeExceedsPeriod` otherwise (would make every
    /// freshly-rotated master immediately Overdue).
    pub fn new(
        last_rotation_at_unix_secs: i64,
        rotation_period: Duration,
        alarm_lead_time: Duration,
    ) -> Result<Self, RotationDeadlineError> {
        if alarm_lead_time > rotation_period {
            return Err(RotationDeadlineError::LeadTimeExceedsPeriod {
                lead_secs: alarm_lead_time.as_secs(),
                period_secs: rotation_period.as_secs(),
            });
        }
        Ok(Self {
            last_rotation_at_unix_secs,
            rotation_period,
            alarm_lead_time,
        })
    }

    /// Construct with the ADR-018 §6 defaults — 180-day
    /// period + 30-day lead time.
    pub fn new_with_defaults(
        last_rotation_at_unix_secs: i64,
    ) -> Result<Self, RotationDeadlineError> {
        Self::new(
            last_rotation_at_unix_secs,
            Duration::from_secs(DEFAULT_ROTATION_PERIOD_DAYS * 86_400),
            Duration::from_secs(DEFAULT_ALARM_LEAD_TIME_DAYS * 86_400),
        )
    }

    /// Audit accessor — last rotation timestamp (Unix secs).
    pub fn last_rotation_at_unix_secs(&self) -> i64 {
        self.last_rotation_at_unix_secs
    }

    /// Audit accessor — rotation period.
    pub fn rotation_period(&self) -> Duration {
        self.rotation_period
    }

    /// Audit accessor — alarm lead time.
    pub fn alarm_lead_time(&self) -> Duration {
        self.alarm_lead_time
    }

    /// Evaluate the deadline against the current trustworthy
    /// wallclock. Returns a `RotationStatus` discriminating
    /// the three policy bands or an error class.
    ///
    /// **Why async:** matches `ClockAuthority::trustworthy_wall_clock`
    /// signature. The alarm runner is a 1-hour-interval
    /// background task; async cost is negligible.
    pub async fn evaluate(
        &self,
        clock: &dyn ClockAuthority,
    ) -> Result<RotationStatus, RotationDeadlineError> {
        let now_reading = clock.trustworthy_wall_clock().await?;
        let now_unix_secs = now_reading
            .system_time
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RotationDeadlineError::Clock(ClockError::PreEpochWallClock))?
            .as_secs() as i64;

        if self.last_rotation_at_unix_secs > now_unix_secs {
            return Err(RotationDeadlineError::LastRotationInFuture {
                last_unix_secs: self.last_rotation_at_unix_secs,
                now_unix_secs,
            });
        }

        let elapsed_secs = (now_unix_secs - self.last_rotation_at_unix_secs) as u64;
        let elapsed = Duration::from_secs(elapsed_secs);

        if elapsed >= self.rotation_period {
            let by = elapsed - self.rotation_period;
            return Ok(RotationStatus::Overdue { by });
        }

        let remaining = self.rotation_period - elapsed;
        if remaining <= self.alarm_lead_time {
            return Ok(RotationStatus::LeadTimeExceeded { remaining });
        }

        Ok(RotationStatus::WithinPolicy { remaining })
    }

    /// Update `last_rotation_at` to the current trustworthy
    /// wallclock. Called by `FileBackedKeystore::rotate_master_from_files`
    /// (D-1b consumer wiring batch) after a successful
    /// rotation.
    pub async fn record_rotation_now(
        &mut self,
        clock: &dyn ClockAuthority,
    ) -> Result<(), RotationDeadlineError> {
        let reading = clock.trustworthy_wall_clock().await?;
        let now_unix_secs = reading
            .system_time
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RotationDeadlineError::Clock(ClockError::PreEpochWallClock))?
            .as_secs() as i64;
        self.last_rotation_at_unix_secs = now_unix_secs;
        Ok(())
    }
}

/// Convenience: convert a SystemTime to its Unix-secs
/// representation. `i64` shape matches the persistence
/// schema. Returns `None` on pre-epoch SystemTime values
/// (caught explicitly so callers can route to the
/// PreEpochWallClock error class).
pub fn system_time_to_unix_secs(t: SystemTime) -> Option<i64> {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_safety::clock::{MonotonicAnchor, WallClockReading};
    use async_trait::async_trait;
    use std::sync::Mutex;

    /// Programmable mock clock — tests inject specific
    /// wallclock + monotonic readings. Mirrors the
    /// MonotonicDeadline test pattern (Batch #313) for
    /// uniformity.
    struct MockClock {
        state: Mutex<MockState>,
    }

    struct MockState {
        wallclock: SystemTime,
        monotonic_nanos: u128,
        nts_sync_age_secs: u64,
        threshold: u64,
        force_pre_epoch: bool,
        force_nts_stale: bool,
    }

    impl MockClock {
        fn new(wallclock: SystemTime) -> Self {
            Self {
                state: Mutex::new(MockState {
                    wallclock,
                    monotonic_nanos: 0,
                    nts_sync_age_secs: 0,
                    threshold: 3600,
                    force_pre_epoch: false,
                    force_nts_stale: false,
                }),
            }
        }
        fn set_wallclock(&self, t: SystemTime) {
            self.state.lock().unwrap().wallclock = t;
        }
        fn set_force_nts_stale(&self, v: bool) {
            self.state.lock().unwrap().force_nts_stale = v;
        }
    }

    #[async_trait]
    impl ClockAuthority for MockClock {
        fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
            let s = self.state.lock().unwrap();
            Ok(MonotonicAnchor::for_test(s.monotonic_nanos))
        }
        async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
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
                monotonic_anchor: MonotonicAnchor::for_test(s.monotonic_nanos),
                nts_sync_age_secs: s.nts_sync_age_secs,
            })
        }
        fn nts_sync_max_skew_secs(&self) -> u64 {
            self.state.lock().unwrap().threshold
        }
    }

    fn unix_secs(epoch: SystemTime) -> i64 {
        system_time_to_unix_secs(epoch).expect("post-epoch")
    }

    /// Lead time greater than period is rejected at ctor.
    #[test]
    fn ctor_rejects_lead_time_exceeding_period() {
        let err = KeystoreRotationDeadline::new(
            0,
            Duration::from_secs(86_400),     // 1 day
            Duration::from_secs(2 * 86_400), // 2 days lead
        )
        .unwrap_err();
        assert!(matches!(
            err,
            RotationDeadlineError::LeadTimeExceedsPeriod { .. }
        ));
    }

    /// Default ctor uses 180-day period + 30-day lead.
    #[test]
    fn default_ctor_uses_adr_018_section_6_values() {
        let d = KeystoreRotationDeadline::new_with_defaults(0).unwrap();
        assert_eq!(d.rotation_period(), Duration::from_secs(180 * 86_400));
        assert_eq!(d.alarm_lead_time(), Duration::from_secs(30 * 86_400));
    }

    /// Within-policy band: just rotated, plenty of
    /// time before lead-time alarm triggers.
    #[tokio::test]
    async fn evaluate_returns_within_policy_for_fresh_rotation() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        let last_unix = unix_secs(now); // just rotated
        let d = KeystoreRotationDeadline::new_with_defaults(last_unix).unwrap();
        let status = d.evaluate(&clock).await.unwrap();
        match status {
            RotationStatus::WithinPolicy { remaining } => {
                // ~180 days remaining (give-or-take a second of
                // mock-clock noise).
                assert!(remaining >= Duration::from_secs(180 * 86_400 - 60));
                assert!(remaining <= Duration::from_secs(180 * 86_400));
            }
            other => panic!("expected WithinPolicy, got {:?}", other),
        }
        assert!(!status.is_alarm(), "WithinPolicy must not be alarm");
    }

    /// Lead-time band: rotation was 155 days ago (within
    /// 30-day lead window). Alarm triggers.
    #[tokio::test]
    async fn evaluate_returns_lead_time_exceeded_within_window() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        // Rotation 155 days ago: 25 days remaining.
        let last_unix = unix_secs(now) - (155 * 86_400);
        let d = KeystoreRotationDeadline::new_with_defaults(last_unix).unwrap();
        let status = d.evaluate(&clock).await.unwrap();
        match status {
            RotationStatus::LeadTimeExceeded { remaining } => {
                let days = remaining.as_secs() / 86_400;
                assert!(
                    (24..=25).contains(&days),
                    "expected ~25 days remaining, got {} days",
                    days
                );
            }
            other => panic!("expected LeadTimeExceeded, got {:?}", other),
        }
        assert!(status.is_alarm(), "LeadTimeExceeded MUST be alarm");
    }

    /// Overdue: rotation 200 days ago (20 days past
    /// 180-day period).
    #[tokio::test]
    async fn evaluate_returns_overdue_past_period() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        let last_unix = unix_secs(now) - (200 * 86_400);
        let d = KeystoreRotationDeadline::new_with_defaults(last_unix).unwrap();
        let status = d.evaluate(&clock).await.unwrap();
        match status {
            RotationStatus::Overdue { by } => {
                let days = by.as_secs() / 86_400;
                assert!(
                    (19..=20).contains(&days),
                    "expected ~20 days overdue, got {} days",
                    days
                );
            }
            other => panic!("expected Overdue, got {:?}", other),
        }
        assert!(status.is_alarm(), "Overdue MUST be alarm");
    }

    /// Last-rotation-in-future returns the structured error
    /// (corrupt marker file scenario).
    #[tokio::test]
    async fn evaluate_rejects_last_rotation_in_future() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        // Last rotation is 1 day in the future — corrupted
        // marker.
        let last_unix = unix_secs(now) + 86_400;
        let d = KeystoreRotationDeadline::new_with_defaults(last_unix).unwrap();
        let err = d.evaluate(&clock).await.unwrap_err();
        match err {
            RotationDeadlineError::LastRotationInFuture {
                last_unix_secs,
                now_unix_secs,
            } => {
                assert!(last_unix_secs > now_unix_secs);
            }
            other => panic!("expected LastRotationInFuture, got {:?}", other),
        }
    }

    /// NTS-stale clock at evaluate-time propagates verbatim.
    #[tokio::test]
    async fn evaluate_propagates_nts_sync_stale() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        clock.set_force_nts_stale(true);
        let d = KeystoreRotationDeadline::new_with_defaults(0).unwrap();
        let err = d.evaluate(&clock).await.unwrap_err();
        assert!(matches!(
            err,
            RotationDeadlineError::Clock(ClockError::NtsSyncStale { .. })
        ));
    }

    /// `record_rotation_now` advances the deadline to the
    /// current wallclock; subsequent evaluate returns
    /// WithinPolicy.
    #[tokio::test]
    async fn record_rotation_now_resets_deadline() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        // Initial deadline pretends we're already overdue.
        let mut d =
            KeystoreRotationDeadline::new_with_defaults(unix_secs(now) - (200 * 86_400)).unwrap();
        // Record rotation now.
        d.record_rotation_now(&clock).await.unwrap();
        // Subsequent evaluate is WithinPolicy.
        let status = d.evaluate(&clock).await.unwrap();
        assert!(matches!(status, RotationStatus::WithinPolicy { .. }));
    }

    /// RotationStatus summary strings are pinned for
    /// audit-stable emission.
    #[test]
    fn rotation_status_summary_strings_pinned() {
        let within = RotationStatus::WithinPolicy {
            remaining: Duration::from_secs(150 * 86_400),
        };
        assert_eq!(within.summary_string(), "within_policy_150d_remaining");
        let lead = RotationStatus::LeadTimeExceeded {
            remaining: Duration::from_secs(15 * 86_400),
        };
        assert_eq!(lead.summary_string(), "lead_time_exceeded_15d_remaining");
        let overdue = RotationStatus::Overdue {
            by: Duration::from_secs(7 * 86_400),
        };
        assert_eq!(overdue.summary_string(), "overdue_by_7d");
    }

    /// RotationDeadlineError Display strings pinned.
    #[test]
    fn rotation_deadline_error_display_strings_pinned() {
        assert!(
            format!(
                "{}",
                RotationDeadlineError::LeadTimeExceedsPeriod {
                    lead_secs: 100,
                    period_secs: 50
                }
            )
            .contains("lead_time_100s_exceeds_period_50s")
        );
        assert!(
            format!(
                "{}",
                RotationDeadlineError::LastRotationInFuture {
                    last_unix_secs: 5,
                    now_unix_secs: 1
                }
            )
            .contains("last_rotation_in_future")
        );
        assert!(
            format!(
                "{}",
                RotationDeadlineError::Clock(ClockError::MonotonicBackward)
            )
            .contains("monotonic_backward")
        );
    }

    /// Implements std::error::Error.
    #[test]
    fn rotation_deadline_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<RotationDeadlineError>();
    }
}
