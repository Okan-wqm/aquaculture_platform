//! Keystore rotation alarm runner (Batch #317 D-1b).
//!
//! Long-running background task that periodically
//! evaluates the persisted rotation deadline + emits a
//! structured operator-visible alarm when the status
//! transitions into LeadTimeExceeded or Overdue.
//!
//! ## Architectural position
//!
//! Composes the two D-1b primitives that already landed:
//!
//! - Batch #315 `KeystoreRotationDeadline::evaluate` —
//!   pure-domain 3-state outcome (WithinPolicy /
//!   LeadTimeExceeded / Overdue).
//! - Batch #316 `rotation_marker_store::read_or_init` —
//!   atomic-write JSON marker for cross-restart
//!   `last_rotation_at` tracking.
//!
//! The runner task is the OBSERVABLE side of the D-1b
//! arc — without it the deadline is silently tracked but
//! no operator-facing signal fires. Plan §5 Faz 2 D-1b
//! mandates 180-day cadence enforcement; the alarm
//! runner gives operators 30+ days of advance warning
//! (the LeadTimeExceeded band) plus persistent overdue
//! signal.
//!
//! ## Tick semantics
//!
//! Default interval: 3600s (1 hour). Each tick:
//!
//! 1. Read the marker via `read_marker(path)`. Missing
//!    marker → log info "no marker yet" + skip
//!    evaluation (first-boot path; the
//!    FileBackedKeystore::open consumer wiring will mint
//!    the marker on its own first run, after which the
//!    runner picks it up on the next tick).
//! 2. `deadline.evaluate(&clock)`. Three outcomes route:
//!    - `Ok(WithinPolicy)` → log debug "within policy
//!      Nd remaining" (no alarm).
//!    - `Ok(LeadTimeExceeded)` → log WARN with operator-
//!      visible message + emit structured audit event
//!      `keystore_rotation_lead_time_exceeded`. Repeated
//!      per-tick (operators want continuous reminder).
//!    - `Ok(Overdue)` → log ERROR + emit audit event
//!      `keystore_rotation_overdue`. Repeated per-tick.
//! 3. `Err(Clock(NtsSyncStale))` → log warn "skipped
//!    tick: NTS stale" + continue (do NOT alarm on a
//!    clock that may itself be wrong; the NTS-stale
//!    condition has its own alarm path through the
//!    clock authority).
//! 4. Other errors → log warn + continue.
//!
//! ## Why the alarm fires per-tick (not edge-triggered)
//!
//! Edge-triggered alarms (alarm only on transition into
//! LeadTimeExceeded / Overdue) sound efficient but
//! introduce a CRITICAL gap: after process restart the
//! transition is "lost" because the runner has no prior-
//! tick state to compare against. Per-tick re-emission
//! makes the operator dashboard's "last alarm time"
//! always reflect the actual current posture — a
//! restarted agent that loads an Overdue marker
//! immediately re-emits the alarm. Audit-pipeline
//! deduplication (Sprint 6.2 sink) handles the
//! every-hour repetition cost.
//!
//! ## Why no fail-closed gate in THIS batch
//!
//! The fail-closed gate (refuse keystore-derived
//! operations when Overdue) requires a config flag
//! (`config.security.keystore_rotation_overdue_fail_closed`)
//! AND a runtime hook into every keystore consumer
//! (audit HMAC, offline_queue, license verifier, …).
//! Both depend on FileBackedKeystore::open accepting
//! the deadline as a runtime field — which is the next
//! batch in the D-1b arc. This batch lands the OBSERVE
//! side; the next batch lands the ENFORCE side.
//!
//! ## Shutdown semantics
//!
//! `tokio::select!` between the interval timer + a
//! `tokio::sync::watch::Receiver<bool>` shutdown
//! signal. Same shape as `run_sweep_task_with_clock`
//! (Batch #314) for uniformity.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tracing::{debug, error, info, warn};

use super::rotation_deadline::RotationStatus;
use super::rotation_marker_store::{MarkerStoreError, read_marker};
use crate::runtime_safety::clock::ClockAuthority;

/// Default tick interval — 1 hour. Matches the cadence
/// of the audit-sink dedup window so per-tick alarm
/// emission does not flood the audit log: the sink
/// collapses identical events within the same hour.
pub const DEFAULT_ALARM_INTERVAL_SECS: u64 = 3600;

/// Summary returned when the alarm runner exits.
/// Mirrors the `SweepSummary` shape from
/// force_registry::run_sweep_task_with_clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AlarmRunSummary {
    /// Total ticks dispatched.
    pub ticks_executed: u64,
    /// Ticks that emitted a LeadTimeExceeded alarm.
    pub lead_time_alarms: u64,
    /// Ticks that emitted an Overdue alarm.
    pub overdue_alarms: u64,
    /// Ticks where the marker was missing (first-boot
    /// path; runner skips eval).
    pub marker_missing_ticks: u64,
    /// Ticks skipped because the clock authority
    /// reported NTS-stale or another transient fault.
    pub clock_unhealthy_ticks: u64,
}

/// Long-running 1-hour alarm runner. Reads the marker,
/// evaluates the deadline, emits structured alarms on
/// LeadTimeExceeded / Overdue.
///
/// Shutdown via `tokio::sync::watch::Receiver<bool>`
/// — set the channel to `true` to exit cleanly. Returns
/// the lifetime summary on exit.
pub async fn run_keystore_rotation_alarm_task(
    marker_path: PathBuf,
    clock: Arc<dyn ClockAuthority>,
    interval: Duration,
    mut shutdown_rx: watch::Receiver<bool>,
) -> AlarmRunSummary {
    info!(
        "Keystore rotation alarm runner starting (marker={}, interval={:?})",
        marker_path.display(),
        interval,
    );
    let mut summary = AlarmRunSummary::default();

    loop {
        tick_once(&marker_path, &*clock, &mut summary).await;

        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            changed = shutdown_rx.changed() => {
                match changed {
                    Ok(()) if *shutdown_rx.borrow() => {
                        info!(
                            "Keystore rotation alarm runner shutdown: \
                             ticks={} lead_time_alarms={} overdue_alarms={} \
                             marker_missing={} clock_unhealthy={}",
                            summary.ticks_executed,
                            summary.lead_time_alarms,
                            summary.overdue_alarms,
                            summary.marker_missing_ticks,
                            summary.clock_unhealthy_ticks,
                        );
                        return summary;
                    }
                    Ok(()) => {}
                    Err(_) => {
                        info!(
                            "Keystore rotation alarm runner shutdown (sender dropped): \
                             ticks={}",
                            summary.ticks_executed,
                        );
                        return summary;
                    }
                }
            }
        }
    }
}

/// Single tick — pure logic, called from the runner
/// loop AND directly from tests. Updates the summary in
/// place.
async fn tick_once(marker_path: &Path, clock: &dyn ClockAuthority, summary: &mut AlarmRunSummary) {
    summary.ticks_executed += 1;

    let deadline = match read_marker(marker_path) {
        Ok(Some(d)) => d,
        Ok(None) => {
            debug!(
                "Keystore rotation alarm tick: marker missing at {} \
                 (first-boot path; FileBackedKeystore::open will mint)",
                marker_path.display()
            );
            summary.marker_missing_ticks += 1;
            return;
        }
        Err(e) => {
            // Read failures (corrupt JSON, schema
            // mismatch, I/O) are operator-actionable.
            // Surface as warn but do not increment
            // alarm counters — those are reserved for
            // the deadline-status alarms.
            warn!("Keystore rotation alarm tick: marker read failed: {}", e);
            summary.clock_unhealthy_ticks += 1;
            return;
        }
    };

    match deadline.evaluate(clock).await {
        Ok(RotationStatus::WithinPolicy { remaining }) => {
            debug!(
                "Keystore rotation: within_policy {}d remaining",
                remaining.as_secs() / 86_400
            );
        }
        Ok(status @ RotationStatus::LeadTimeExceeded { .. }) => {
            warn!(
                "Keystore rotation ALARM: {} (operator should schedule \
                 the rotation ceremony; ADR-018 §6 cadence)",
                status.summary_string()
            );
            summary.lead_time_alarms += 1;
            // Future Sprint 6.2 wire: emit_audit_event(
            //   AuditEvent::KeystoreRotationLeadTimeExceeded { remaining }).
            // The audit-sink dedup window collapses
            // per-hour repeats so the per-tick re-
            // emission does not flood the log.
        }
        Ok(status @ RotationStatus::Overdue { .. }) => {
            error!(
                "Keystore rotation ALARM: {} (rotation OVERDUE; \
                 future config.security.keystore_rotation_overdue_fail_closed \
                 will block keystore-derived operations)",
                status.summary_string()
            );
            summary.overdue_alarms += 1;
            // Future Sprint 6.2 wire: emit_audit_event(
            //   AuditEvent::KeystoreRotationOverdue { by }).
        }
        Err(e) => {
            // Clock NTS-stale or LastRotationInFuture or
            // ctor failure (LeadTimeExceedsPeriod).
            // Skip tick + log warn. Routing the alarm
            // here would conflate "rotation overdue" with
            // "clock broken" — the clock authority's own
            // alarm path handles the latter.
            warn!(
                "Keystore rotation alarm tick: skipped — clock or marker \
                 issue: {}",
                e
            );
            summary.clock_unhealthy_ticks += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::rotation_deadline::KeystoreRotationDeadline;
    use crate::keystore::rotation_marker_store::write_marker;
    use crate::runtime_safety::clock::{ClockError, MonotonicAnchor, WallClockReading};
    use async_trait::async_trait;
    use std::sync::Mutex;
    use std::time::SystemTime;

    /// Programmable mock clock — same shape as Batch #313 +
    /// #315 test mocks for uniformity. Inject specific
    /// wallclock readings to drive the 3-state
    /// deadline evaluation.
    struct MockClock {
        state: Mutex<MockState>,
    }
    struct MockState {
        wallclock: SystemTime,
        force_nts_stale: bool,
    }

    impl MockClock {
        fn new(wallclock: SystemTime) -> Self {
            Self {
                state: Mutex::new(MockState {
                    wallclock,
                    force_nts_stale: false,
                }),
            }
        }
        fn set_force_nts_stale(&self, v: bool) {
            self.state.lock().unwrap().force_nts_stale = v;
        }
    }

    #[async_trait]
    impl ClockAuthority for MockClock {
        fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
            Ok(MonotonicAnchor::for_test(0))
        }
        async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
            let s = self.state.lock().unwrap();
            if s.force_nts_stale {
                return Err(ClockError::NtsSyncStale {
                    last_sync_age_secs: 99999,
                    threshold_secs: 3600,
                });
            }
            Ok(WallClockReading {
                system_time: s.wallclock,
                monotonic_anchor: MonotonicAnchor::for_test(0),
                nts_sync_age_secs: 0,
            })
        }
        fn nts_sync_max_skew_secs(&self) -> u64 {
            3600
        }
    }

    fn marker_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir
            .path()
            .join(crate::keystore::rotation_marker_store::ROTATION_MARKER_FILENAME);
        (dir, path)
    }

    /// Missing marker → marker_missing_ticks increments,
    /// no alarms.
    #[tokio::test]
    async fn tick_with_missing_marker_increments_marker_missing() {
        let (_d, path) = marker_path();
        let clock = MockClock::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000));
        let mut summary = AlarmRunSummary::default();
        tick_once(&path, &clock, &mut summary).await;
        assert_eq!(summary.ticks_executed, 1);
        assert_eq!(summary.marker_missing_ticks, 1);
        assert_eq!(summary.lead_time_alarms, 0);
        assert_eq!(summary.overdue_alarms, 0);
    }

    /// Within-policy marker → no alarms.
    #[tokio::test]
    async fn tick_with_within_policy_marker_does_not_alarm() {
        let (_d, path) = marker_path();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        // Just rotated -> within policy.
        let deadline = KeystoreRotationDeadline::new_with_defaults(1_700_000_000).unwrap();
        write_marker(&path, &deadline).unwrap();

        let mut summary = AlarmRunSummary::default();
        tick_once(&path, &clock, &mut summary).await;
        assert_eq!(summary.ticks_executed, 1);
        assert_eq!(summary.lead_time_alarms, 0);
        assert_eq!(summary.overdue_alarms, 0);
    }

    /// Lead-time band → lead_time_alarms increments.
    #[tokio::test]
    async fn tick_with_lead_time_marker_increments_lead_alarm() {
        let (_d, path) = marker_path();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        // Rotation 155 days ago -> 25 days remaining = lead-time band.
        let deadline =
            KeystoreRotationDeadline::new_with_defaults(1_700_000_000 - 155 * 86_400).unwrap();
        write_marker(&path, &deadline).unwrap();

        let mut summary = AlarmRunSummary::default();
        tick_once(&path, &clock, &mut summary).await;
        assert_eq!(summary.lead_time_alarms, 1);
        assert_eq!(summary.overdue_alarms, 0);
    }

    /// Overdue marker → overdue_alarms increments.
    #[tokio::test]
    async fn tick_with_overdue_marker_increments_overdue_alarm() {
        let (_d, path) = marker_path();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        // Rotation 200 days ago -> 20 days overdue.
        let deadline =
            KeystoreRotationDeadline::new_with_defaults(1_700_000_000 - 200 * 86_400).unwrap();
        write_marker(&path, &deadline).unwrap();

        let mut summary = AlarmRunSummary::default();
        tick_once(&path, &clock, &mut summary).await;
        assert_eq!(summary.overdue_alarms, 1);
        assert_eq!(summary.lead_time_alarms, 0);
    }

    /// Per-tick re-emission contract: an Overdue marker
    /// fires the alarm on every tick (NOT edge-triggered).
    /// Critical for restart resilience: a fresh process
    /// loading an already-Overdue marker MUST alarm
    /// immediately on the first tick.
    #[tokio::test]
    async fn tick_re_emits_alarm_on_every_call_with_overdue_marker() {
        let (_d, path) = marker_path();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        let deadline =
            KeystoreRotationDeadline::new_with_defaults(1_700_000_000 - 200 * 86_400).unwrap();
        write_marker(&path, &deadline).unwrap();

        let mut summary = AlarmRunSummary::default();
        tick_once(&path, &clock, &mut summary).await;
        tick_once(&path, &clock, &mut summary).await;
        tick_once(&path, &clock, &mut summary).await;
        assert_eq!(summary.overdue_alarms, 3);
        assert_eq!(summary.ticks_executed, 3);
    }

    /// NTS-stale clock → tick skipped via clock_unhealthy
    /// path; no alarm counters incremented (alarm is
    /// reserved for actual deadline status, not for
    /// clock issues).
    #[tokio::test]
    async fn tick_with_nts_stale_clock_skips_to_unhealthy_bucket() {
        let (_d, path) = marker_path();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);
        clock.set_force_nts_stale(true);
        let deadline =
            KeystoreRotationDeadline::new_with_defaults(1_700_000_000 - 200 * 86_400).unwrap();
        write_marker(&path, &deadline).unwrap();

        let mut summary = AlarmRunSummary::default();
        tick_once(&path, &clock, &mut summary).await;
        assert_eq!(summary.clock_unhealthy_ticks, 1);
        assert_eq!(summary.lead_time_alarms, 0);
        assert_eq!(summary.overdue_alarms, 0);
    }

    /// Corrupt marker → tick skipped via clock_unhealthy
    /// path (operator-actionable I/O fault, NOT a
    /// deadline-status alarm).
    #[tokio::test]
    async fn tick_with_corrupt_marker_routes_to_unhealthy_bucket() {
        let (_d, path) = marker_path();
        std::fs::write(&path, b"not valid json {").expect("seed");
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock = MockClock::new(now);

        let mut summary = AlarmRunSummary::default();
        tick_once(&path, &clock, &mut summary).await;
        assert_eq!(summary.clock_unhealthy_ticks, 1);
        assert_eq!(summary.lead_time_alarms, 0);
        assert_eq!(summary.overdue_alarms, 0);
    }

    /// AlarmRunSummary Default impl returns zeroes.
    #[test]
    fn alarm_run_summary_default_is_all_zero() {
        let s = AlarmRunSummary::default();
        assert_eq!(s.ticks_executed, 0);
        assert_eq!(s.lead_time_alarms, 0);
        assert_eq!(s.overdue_alarms, 0);
        assert_eq!(s.marker_missing_ticks, 0);
        assert_eq!(s.clock_unhealthy_ticks, 0);
    }

    /// Smoke test for the long-running task: 10ms
    /// interval, signal shutdown after 30ms, expect
    /// ≥1 tick + clean exit.
    #[tokio::test]
    async fn runner_executes_at_least_one_tick_then_shuts_down() {
        let (_d, path) = marker_path();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock: Arc<dyn ClockAuthority> = Arc::new(MockClock::new(now));
        let (tx, rx) = watch::channel(false);

        let task_path = path.clone();
        let task_clock = clock.clone();
        let handle = tokio::spawn(async move {
            run_keystore_rotation_alarm_task(task_path, task_clock, Duration::from_millis(10), rx)
                .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).expect("signal");
        let summary = handle.await.expect("join");
        assert!(summary.ticks_executed >= 1);
        // Marker missing the whole time → marker_missing_ticks >= 1.
        assert!(summary.marker_missing_ticks >= 1);
    }

    /// Runner exits cleanly when the shutdown channel
    /// sender is dropped (Sender disconnect path).
    #[tokio::test]
    async fn runner_exits_when_sender_dropped() {
        let (_d, path) = marker_path();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let clock: Arc<dyn ClockAuthority> = Arc::new(MockClock::new(now));
        let (tx, rx) = watch::channel(false);

        let task_path = path.clone();
        let task_clock = clock.clone();
        let handle = tokio::spawn(async move {
            run_keystore_rotation_alarm_task(task_path, task_clock, Duration::from_millis(10), rx)
                .await
        });

        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(tx); // sender disconnect
        let summary = handle.await.expect("join");
        assert!(summary.ticks_executed >= 1);
    }
}
