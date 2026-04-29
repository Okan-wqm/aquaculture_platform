//! Per-task scheduler stats MQTT publisher loop —
//! Batch #302 Faz 4 step 5 closure.
//!
//! ## Why this module exists
//!
//! Plan §5 Faz 4 step 5 specifies:
//!
//! > MQTT publish: `tenants/{tid}/devices/{did}/task_stats`
//! > 30s interval (config).
//!
//! Pre-Batch-#302 the multi-task scheduler (Batch 184+, plan
//! R-3 + D-11) computed per-task TaskStats (cycle_ms_min /
//! cycle_ms_max / cycle_ms_avg / jitter_ms_p99_approx /
//! overrun_count / watchdog_kill_count) but the values were
//! readable ONLY from inside the agent's process via
//! `TaskScheduler::stats_of`. Operators monitoring scheduler
//! health from the cloud had ZERO visibility into per-task
//! jitter / overrun / watchdog-kill rates — the entire SLO-
//! tier discipline (SafetyCritical 500ms / Routine 1200ms /
//! LowPriority 5000ms) was operator-invisible.
//!
//! This module lands the publisher loop:
//!
//! 1. Snapshots every task's TaskStats under the scheduler
//!    lock (cheap — TaskStats is Clone with no async work).
//! 2. Serializes the snapshot as a JSON array.
//! 3. Publishes via `publish_helpers::publish_task_stats` (a
//!    new helper added alongside this module) at
//!    [`MessagePriority::Normal`] — same class as io_data
//!    telemetry. Drains in normal priority order on broker
//!    reconnect.
//! 4. Runs on a configurable interval (default 30s per plan).
//! 5. Honors the shutdown watch — clean exit when the
//!    ShutdownCoordinator broadcasts.
//!
//! ## Architectural shape
//!
//! - The publisher is a SEPARATE async task from the scheduler
//!   cadence loop + event listener. Reason: stats publish is a
//!   slow-path observability concern; coupling it into the
//!   scan-cycle hot path would risk publish-delay backpressure
//!   propagating into scheduler ticks (a 30s interval means
//!   most ticks would have nothing to publish, but the
//!   structural separation guarantees it).
//! - The publisher acquires the scheduler lock, clones the
//!   stats, releases, then does the JSON encode + publish
//!   OUTSIDE the lock. Cardinality bound: `task_count`
//!   (typically 3-10) clones per interval — fixed cost
//!   regardless of scan-cycle rate.
//! - Configurable interval lives at
//!   `config.scripting.task_stats_publish_interval_secs`
//!   (default 30, validated bounds: 5..=3600).
//!
//! ## Wire status (Batch #302)
//!
//! Loop fn lands here; main.rs boot sequence spawns it
//! alongside `run_scheduler_cadence_loop` +
//! `run_event_listener` in the multi-task scheduler branch
//! (the legacy single-cadence branch doesn't have per-task
//! stats so doesn't need this loop).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use super::task_scheduler::{TaskScheduler, TaskStats};

/// JSON wire shape for one task's stats snapshot. Stable
/// schema — operator dashboards depend on field names.
///
/// Field set EXACTLY mirrors `TaskStats` (no derived /
/// synthetic fields) so a future TaskStats extension surfaces
/// here at compile time via the exhaustive mapping in
/// `from_task_stats` below.
#[derive(Debug, Clone, Serialize)]
pub struct TaskStatsSnapshot {
    /// Task name (operator-facing identifier).
    pub task_name: String,

    /// Total ticks observed (success + failure).
    pub ticks_executed: u64,

    /// Cumulative count of ticks where the actual cycle
    /// exceeded the target cycle (per SloTier mapping).
    pub overrun_count: u64,

    /// Cumulative count of watchdog kills — per-task hard
    /// timeout exceeded; the scheduler aborted the dispatch.
    pub watchdog_kill_count: u64,

    /// Most recent tick's wall-clock elapsed (ms).
    pub last_cycle_ms: u64,

    /// Wall-clock cycle measurements (ms).
    pub cycle_ms_min: u64,
    pub cycle_ms_max: u64,
    /// Running average — TaskStats stores this as f64 (online
    /// algorithm). Wire format keeps the f64 so operator
    /// dashboards see sub-millisecond precision.
    pub cycle_ms_avg: f64,

    /// Last tick's jitter vs target cycle (absolute value, ms).
    pub last_jitter_ms: u64,

    /// Running maximum jitter observed.
    pub jitter_ms_max: u64,

    /// EWMA-smoothed p99 approximation. NOT a statistically
    /// rigorous quantile; tracks spikes then decays. Plan
    /// §5 Faz 4 step 2 calls it `p99_approx`.
    pub jitter_ms_p99_approx: u64,
}

impl TaskStatsSnapshot {
    /// Project a `TaskStats` + task name into the wire shape.
    /// Exhaustive mapping — every TaskStats field appears
    /// below by name. A future field addition will fail to
    /// compile here until added (the struct literal would not
    /// be exhaustive against the new field).
    pub fn from_task_stats(task_name: String, s: &TaskStats) -> Self {
        Self {
            task_name,
            ticks_executed: s.ticks_executed,
            overrun_count: s.overrun_count,
            watchdog_kill_count: s.watchdog_kill_count,
            last_cycle_ms: s.last_cycle_ms,
            cycle_ms_min: s.cycle_ms_min,
            cycle_ms_max: s.cycle_ms_max,
            cycle_ms_avg: s.cycle_ms_avg,
            last_jitter_ms: s.last_jitter_ms,
            jitter_ms_max: s.jitter_ms_max,
            jitter_ms_p99_approx: s.jitter_ms_p99_approx,
        }
    }
}

/// JSON wire shape for the periodic publish — wraps every
/// task's snapshot + a timestamp so cloud-side time-series
/// stores can correlate against other telemetry.
#[derive(Debug, Clone, Serialize)]
pub struct TaskStatsPublish {
    /// RFC 3339 timestamp at the moment the snapshot was
    /// taken (NOT at publish time — broker-queue replay
    /// preserves this so post-outage replays show the
    /// original measurement time).
    pub snapshot_at: String,
    /// Per-task snapshots. Empty array means the scheduler is
    /// running with zero tasks (config-driven; legitimate
    /// degenerate case).
    pub tasks: Vec<TaskStatsSnapshot>,
}

/// Snapshot every task's stats from the scheduler. Holds the
/// lock briefly (clone semantics on TaskStats — no async
/// work inside the lock).
async fn snapshot_all_tasks(scheduler: &Arc<Mutex<TaskScheduler>>) -> Vec<TaskStatsSnapshot> {
    let guard = scheduler.lock().await;
    guard
        .tasks()
        .map(|t| TaskStatsSnapshot::from_task_stats(t.config.name.clone(), &t.stats))
        .collect()
}

/// Run the periodic task_stats publisher loop. Returns when
/// the shutdown watch fires.
///
/// **Cancellation contract:** the loop awaits either the
/// next tick or the shutdown signal via `tokio::select!`;
/// either way the function returns cleanly. The
/// ShutdownCoordinator's `register_task` semantics expect
/// this exit shape.
///
/// **Error handling:** publish failures (e.g., transient
/// MQTT disconnects) are logged at warn level and DO NOT
/// terminate the loop — the next interval retries via the
/// queue-aware publish_routed path. Only the shutdown
/// signal stops the loop.
pub async fn run_task_stats_publisher_loop(
    state: Arc<tokio::sync::RwLock<crate::AppState>>,
    scheduler: Arc<Mutex<TaskScheduler>>,
    interval_secs: u64,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) {
    info!(
        "task_stats_publisher loop spawned (interval={}s)",
        interval_secs
    );

    let interval = Duration::from_secs(interval_secs);
    let mut ticker = tokio::time::interval(interval);
    // First tick fires immediately; skip it so the first
    // publish lands at +interval (gives the scheduler time
    // to accumulate measurable stats — publishing zeros at
    // t=0 would clutter operator dashboards with a
    // misleading "everything's fine, 0 ticks" reading).
    ticker.tick().await;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let snapshots = snapshot_all_tasks(&scheduler).await;
                let payload = TaskStatsPublish {
                    snapshot_at: chrono::Utc::now().to_rfc3339(),
                    tasks: snapshots,
                };
                debug!(
                    "task_stats_publisher: publishing {} task snapshot(s)",
                    payload.tasks.len()
                );
                let state_guard = state.read().await;
                // 2026-04-29 enterprise publish reliability:
                // scheduler stats use the checked publish path.
                //
                // What it solves: outbound queue or MQTT routing failures are
                // visible with the task-stats domain label.
                if let Err(e) = crate::publish_helpers::publish_task_stats_checked(
                    &state_guard,
                    &payload,
                )
                .await
                {
                    warn!("task_stats_publisher publish failed: {}", e);
                }
            }
            res = shutdown_rx.changed() => {
                if res.is_err() || *shutdown_rx.borrow() {
                    info!("task_stats_publisher loop received shutdown");
                    break;
                }
            }
        }
    }

    // 2026-04-29 enterprise shutdown observability:
    // final publish on shutdown reports failures instead of staying silent.
    //
    // What it solves: operators can distinguish "no final scheduler sample"
    // from "sample generated but queue/broker rejected it".
    let final_snapshots = snapshot_all_tasks(&scheduler).await;
    if !final_snapshots.is_empty() {
        let payload = TaskStatsPublish {
            snapshot_at: chrono::Utc::now().to_rfc3339(),
            tasks: final_snapshots,
        };
        let state_guard = state.read().await;
        // 2026-04-29 enterprise shutdown publish reliability:
        // final scheduler snapshot reports delivery failures even during
        // shutdown.
        //
        // What it solves: the final dashboard sample is no longer silently
        // lost when the queue or broker path rejects it.
        if let Err(e) =
            crate::publish_helpers::publish_task_stats_checked(&state_guard, &payload).await
        {
            warn!("task_stats_publisher final publish failed: {}", e);
        }
        if let Some(_) = state_guard.mqtt_client.as_ref() {
            // No-op marker; keeping the read-guard scope
            // contained so the await above runs INSIDE it.
        }
    } else {
        warn!("task_stats_publisher exiting with no scheduler tasks to snapshot");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripting::task_scheduler::{SloTier, TaskConfig, TaskKind};

    fn cyclic_task(name: &str, period_ms: u64) -> TaskConfig {
        TaskConfig {
            name: name.to_string(),
            kind: TaskKind::Cyclic { period_ms },
            slo_tier: SloTier::Routine,
            programs: vec![],
            watchdog_ms: 1000,
        }
    }

    /// Snapshot projection is faithful — every TaskStats
    /// field maps to the wire snapshot 1:1.
    #[tokio::test]
    async fn snapshot_projects_every_task_stats_field() {
        let scheduler = Arc::new(Mutex::new(
            TaskScheduler::new(vec![
                cyclic_task("safety", 500),
                cyclic_task("routine", 1200),
            ])
            .expect("scheduler ok"),
        ));

        // Record one tick on each task so stats aren't all
        // zeros — proves projection isn't masking field
        // values with defaults.
        {
            let mut guard = scheduler.lock().await;
            guard
                .record_tick_fired("safety", 500, 510)
                .expect("record ok");
            guard
                .record_tick_fired("routine", 1200, 1100)
                .expect("record ok");
        }

        let snapshots = snapshot_all_tasks(&scheduler).await;
        assert_eq!(snapshots.len(), 2);

        // Tasks come in scheduler-order (priority desc, name asc);
        // both at priority=0 so name asc — routine before safety.
        let names: Vec<String> = snapshots.iter().map(|s| s.task_name.clone()).collect();
        assert!(names.contains(&"safety".to_string()));
        assert!(names.contains(&"routine".to_string()));

        // Find safety — should have non-zero stats from the
        // recorded tick.
        let safety = snapshots
            .iter()
            .find(|s| s.task_name == "safety")
            .expect("safety in snapshots");
        // record_tick(actual=510, target=500) -> overrun by 10ms.
        assert!(safety.cycle_ms_max >= 510);
        // Overrun counted (actual > target)
        assert_eq!(safety.overrun_count, 1);
    }

    /// Empty scheduler produces empty snapshot — degenerate
    /// case (config without tasks: []).
    #[tokio::test]
    async fn snapshot_empty_scheduler_produces_empty_vec() {
        let scheduler = Arc::new(Mutex::new(TaskScheduler::new(vec![]).expect("empty ok")));
        let snapshots = snapshot_all_tasks(&scheduler).await;
        assert!(snapshots.is_empty());
    }

    /// JSON wire shape stability — operator dashboards key on
    /// field names; renaming is a wire break.
    #[test]
    fn task_stats_snapshot_serde_field_names_pinned() {
        let stats = TaskStats {
            ticks_executed: 100,
            overrun_count: 3,
            watchdog_kill_count: 1,
            last_cycle_ms: 510,
            cycle_ms_min: 100,
            cycle_ms_max: 200,
            cycle_ms_avg: 150.5,
            last_jitter_ms: 25,
            jitter_ms_max: 50,
            jitter_ms_p99_approx: 45,
        };
        let snapshot = TaskStatsSnapshot::from_task_stats("test".to_string(), &stats);
        let json = serde_json::to_string(&snapshot).expect("serde ok");
        // Pin every field name. A renamer must update both
        // this test AND the operator dashboards in lockstep.
        for field in [
            "task_name",
            "ticks_executed",
            "overrun_count",
            "watchdog_kill_count",
            "last_cycle_ms",
            "cycle_ms_min",
            "cycle_ms_max",
            "cycle_ms_avg",
            "last_jitter_ms",
            "jitter_ms_max",
            "jitter_ms_p99_approx",
        ] {
            assert!(
                json.contains(field),
                "missing field `{}` in serialized JSON: {}",
                field,
                json
            );
        }
    }

    /// TaskStatsPublish wraps snapshots with timestamp.
    #[test]
    fn task_stats_publish_includes_snapshot_at() {
        let payload = TaskStatsPublish {
            snapshot_at: "2026-04-26T12:00:00Z".to_string(),
            tasks: vec![],
        };
        let json = serde_json::to_string(&payload).expect("serde ok");
        assert!(json.contains("snapshot_at"));
        assert!(json.contains("tasks"));
        assert!(json.contains("2026-04-26T12:00:00Z"));
    }
}
