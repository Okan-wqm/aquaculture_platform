//! Multi-task scheduler primitives — Batch 184 Faz 4
//! (plan R-3 + plan D-11).
//!
//! ## WHY
//!
//! Plan §5 Faz 4 + plan §3 R-3 specify a PLC-class task
//! scheduler on top of the Faz 3 bytecode runtime.
//! Real aquaculture control runs multiple programs at
//! different tempos:
//!
//! - 500 ms safety-critical (pH / DO / temp alarm
//!   evaluation).
//! - 1200 ms routine (feeding schedule, trend writes,
//!   setpoint adjustment).
//! - 5000 ms low-priority (audit rotation, RFID sweep,
//!   environmental averaging).
//!
//! A single-cadence loop (Batch 170) serves the common
//! case but cannot honor mixed-priority SLO tiers
//! simultaneously without starving fast tasks behind
//! slow ones. Batch 184 lands the CORE TYPES:
//!
//! - `SloTier` — plan D-11 tier enum with canonical
//!   target cycle times.
//! - `TaskKind` — Cyclic / Freewheeling / Event-driven.
//! - `TaskConfig` — full per-task configuration.
//! - `TaskStats` — per-task jitter + overrun telemetry.
//!
//! Batch 185+ adds the multi-task runtime that
//! dispatches tasks according to these configs. Keeping
//! the primitives in a separate module lets callers
//! (config parser, metrics endpoint, admin UI) consume
//! the types without pulling in the runtime.
//!
//! ## Architectural position
//!
//! - Types are serde-enabled so config.yaml can declare
//!   tasks directly.
//! - `TaskStats` is a plain struct with owned data —
//!   metrics collectors clone it cheaply under a read-
//!   guard without holding the runtime lock.
//! - Jitter computation uses an online-algorithm
//!   p99-approximation (exponentially weighted) so the
//!   stats struct stays a small fixed size regardless
//!   of scan-cycle count (cardinality safe per Batch
//!   164 observability baseline).

#![allow(dead_code)]

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Plan D-11 SLO tier classification. The tier maps to
/// a canonical target cycle time + drives priority
/// ordering when the scheduler decides which task to
/// run next (SafetyCritical > Routine > LowPriority).
///
/// Target cycle times (`target_cycle_ms`) match plan
/// §3 R-12 + plan D-11:
/// - SafetyCritical: 500 ms (FDA / EU Machinery
///   alignment for life-safety alarm paths).
/// - Routine: 1200 ms (operational control loops).
/// - LowPriority: 5000 ms (audit flush, RFID trend
///   sampling).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash,
    Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum SloTier {
    /// Life-safety programs. Highest scheduling
    /// priority; watchdog timeout should NEVER kill
    /// these silently.
    SafetyCritical,
    /// Routine operational control. Standard PLC
    /// cadence for feeding schedules, setpoints,
    /// alarm triggers that aren't life-safety.
    Routine,
    /// Low-urgency maintenance work that can tolerate
    /// longer latencies.
    LowPriority,
}

impl SloTier {
    /// Canonical target cycle time for this tier.
    pub const fn target_cycle_ms(self) -> u64 {
        match self {
            Self::SafetyCritical => 500,
            Self::Routine => 1200,
            Self::LowPriority => 5000,
        }
    }

    /// Target cycle time as `Duration` — convenience for
    /// tokio timer arithmetic in the future scheduler.
    pub fn target_cycle(self) -> Duration {
        Duration::from_millis(self.target_cycle_ms())
    }

    /// Priority value (higher = more urgent) for simple
    /// schedulers that compare tiers directly. Matches
    /// the enum ordering so `tier_a > tier_b` means
    /// `tier_a` preempts.
    pub const fn priority(self) -> u8 {
        match self {
            Self::SafetyCritical => 200,
            Self::Routine => 100,
            Self::LowPriority => 50,
        }
    }
}

/// What triggers this task to run.
///
/// Batch 184 introduces the type shapes; the scheduler
/// (Batch 185+) interprets each at runtime.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize,
)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskKind {
    /// Run periodically at `period_ms` intervals.
    /// Matches PLC-style cyclic scan tasks.
    Cyclic { period_ms: u64 },
    /// Run continuously as fast as the scheduler can
    /// dispatch. Used for high-speed trend
    /// accumulation or event-loop-style programs.
    Freewheeling,
    /// Run on tag-change events. `event_tag` is the
    /// ProcessImage tag whose value change wakes the
    /// task.
    Event { event_tag: String },
}

/// Full per-task configuration. Declared in
/// config.yaml + loaded at boot; one config drives one
/// task instance owned by the scheduler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskConfig {
    /// Human-readable operator-facing identifier.
    pub name: String,
    /// How + when this task runs.
    pub kind: TaskKind,
    /// SLO tier — drives priority + canonical cycle
    /// time when the Cyclic kind doesn't override.
    pub slo_tier: SloTier,
    /// Per-tick watchdog (milliseconds). If a task
    /// tick exceeds this, the scheduler kills the
    /// program + emits a watchdog alarm. Set to 0 to
    /// disable (operator opt-out — not recommended
    /// for safety_critical tier).
    pub watchdog_ms: u64,
    /// Program IDs this task executes each tick, in
    /// sort order. Matches the Batch 164 scan-tick
    /// deterministic-ordering invariant, scoped to the
    /// task's own program set.
    pub programs: Vec<String>,
}

impl TaskConfig {
    /// Sanity-check the config shape. Operator configs
    /// with contradictory fields reject at boot.
    pub fn validate(&self) -> Result<(), TaskConfigError> {
        if self.name.trim().is_empty() {
            return Err(TaskConfigError::EmptyName);
        }
        if let TaskKind::Cyclic { period_ms } = &self.kind {
            if *period_ms == 0 {
                return Err(TaskConfigError::ZeroCyclicPeriod {
                    name: self.name.clone(),
                });
            }
        }
        if let TaskKind::Event { event_tag } = &self.kind {
            if event_tag.trim().is_empty() {
                return Err(TaskConfigError::EmptyEventTag {
                    name: self.name.clone(),
                });
            }
        }
        // Watchdog=0 is the explicit-opt-out value;
        // warn for safety_critical but don't reject
        // (operators sometimes disable watchdog during
        // debugging).
        Ok(())
    }
}

/// Config-level failure taxonomy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskConfigError {
    EmptyName,
    ZeroCyclicPeriod { name: String },
    EmptyEventTag { name: String },
}

impl std::fmt::Display for TaskConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyName => write!(f, "task config: name is empty"),
            Self::ZeroCyclicPeriod { name } => write!(
                f,
                "task `{}`: Cyclic period_ms cannot be 0",
                name
            ),
            Self::EmptyEventTag { name } => write!(
                f,
                "task `{}`: Event task requires a non-empty event_tag",
                name
            ),
        }
    }
}

impl std::error::Error for TaskConfigError {}

/// Per-task runtime telemetry. Updated after every
/// tick; metrics endpoint + health dashboard read a
/// cloned snapshot.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TaskStats {
    /// Total ticks observed (success + failure).
    pub ticks_executed: u64,
    /// Ticks whose wall-clock elapsed exceeded the
    /// configured period / target cycle.
    pub overrun_count: u64,
    /// Watchdog kills (tick elapsed > watchdog_ms).
    pub watchdog_kill_count: u64,
    /// Most recent tick's wall-clock elapsed ms.
    pub last_cycle_ms: u64,
    /// Minimum observed cycle time across all ticks.
    pub cycle_ms_min: u64,
    /// Maximum observed cycle time across all ticks.
    pub cycle_ms_max: u64,
    /// Running average cycle time (online algorithm;
    /// updated per tick as
    /// `avg = avg + (sample - avg) / ticks`).
    pub cycle_ms_avg: f64,
    /// Last tick's jitter vs target cycle (absolute
    /// value in ms).
    pub last_jitter_ms: u64,
    /// Running maximum jitter observed.
    pub jitter_ms_max: u64,
    /// Exponentially-weighted p99 approximation of
    /// jitter. Updated via the EWMA rule
    /// `p99 = max(p99 * 0.95, last_jitter)` so sudden
    /// spikes dominate + slowly decay. Cardinality-safe
    /// per Batch 164 observability invariant.
    pub jitter_ms_p99_approx: u64,
}

impl TaskStats {
    /// Record a completed tick. Updates all derived
    /// stats in place; caller takes the runtime lock
    /// only for this one mutation.
    ///
    /// `target_cycle_ms` drives overrun + jitter
    /// calculations. For Cyclic tasks, pass the
    /// configured period_ms; for Freewheeling, pass
    /// the SLO tier's target_cycle_ms.
    pub fn record_tick(&mut self, actual_ms: u64, target_cycle_ms: u64) {
        self.ticks_executed += 1;
        self.last_cycle_ms = actual_ms;

        if self.ticks_executed == 1 {
            self.cycle_ms_min = actual_ms;
            self.cycle_ms_max = actual_ms;
            self.cycle_ms_avg = actual_ms as f64;
        } else {
            self.cycle_ms_min = self.cycle_ms_min.min(actual_ms);
            self.cycle_ms_max = self.cycle_ms_max.max(actual_ms);
            // Online mean: new_avg = avg + (sample -
            // avg) / n.
            let n = self.ticks_executed as f64;
            self.cycle_ms_avg += (actual_ms as f64 - self.cycle_ms_avg) / n;
        }

        // Jitter = |actual - target|.
        let jitter = actual_ms.abs_diff(target_cycle_ms);
        self.last_jitter_ms = jitter;
        self.jitter_ms_max = self.jitter_ms_max.max(jitter);

        // EWMA p99 approximation. Decay factor 0.95
        // means a one-off spike survives ~20 ticks
        // before returning to the smoothed baseline —
        // appropriate for operator-visible p99 signal
        // without being noise-dominated.
        let decayed = (self.jitter_ms_p99_approx as f64 * 0.95) as u64;
        self.jitter_ms_p99_approx = decayed.max(jitter);

        if actual_ms > target_cycle_ms {
            self.overrun_count += 1;
        }
    }

    /// Record a watchdog kill. Increments the kill
    /// counter + recordTick with `actual_ms` set to
    /// `watchdog_ms` so the overrun counter still
    /// reflects the event.
    pub fn record_watchdog_kill(
        &mut self,
        watchdog_ms: u64,
        target_cycle_ms: u64,
    ) {
        self.watchdog_kill_count += 1;
        self.record_tick(watchdog_ms, target_cycle_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slo_tier_target_cycle_matches_plan() {
        assert_eq!(SloTier::SafetyCritical.target_cycle_ms(), 500);
        assert_eq!(SloTier::Routine.target_cycle_ms(), 1200);
        assert_eq!(SloTier::LowPriority.target_cycle_ms(), 5000);
    }

    #[test]
    fn slo_tier_priority_ordering_matches_enum_order() {
        assert!(
            SloTier::SafetyCritical.priority() > SloTier::Routine.priority()
        );
        assert!(
            SloTier::Routine.priority() > SloTier::LowPriority.priority()
        );
    }

    #[test]
    fn slo_tier_target_cycle_as_duration() {
        assert_eq!(
            SloTier::SafetyCritical.target_cycle(),
            Duration::from_millis(500)
        );
    }

    #[test]
    fn task_kind_serde_roundtrip_cyclic() {
        let kind = TaskKind::Cyclic { period_ms: 500 };
        let j = serde_json::to_string(&kind).expect("ser");
        let back: TaskKind = serde_json::from_str(&j).expect("de");
        assert_eq!(kind, back);
    }

    #[test]
    fn task_kind_serde_roundtrip_event() {
        let kind = TaskKind::Event {
            event_tag: "water_temp".into(),
        };
        let j = serde_json::to_string(&kind).expect("ser");
        let back: TaskKind = serde_json::from_str(&j).expect("de");
        assert_eq!(kind, back);
    }

    #[test]
    fn task_config_validate_ok() {
        let cfg = TaskConfig {
            name: "safety_alarms".into(),
            kind: TaskKind::Cyclic { period_ms: 500 },
            slo_tier: SloTier::SafetyCritical,
            watchdog_ms: 400,
            programs: vec!["o2_guard".into(), "ph_guard".into()],
        };
        cfg.validate().expect("ok");
    }

    #[test]
    fn task_config_validate_empty_name_rejects() {
        let cfg = TaskConfig {
            name: "   ".into(),
            kind: TaskKind::Cyclic { period_ms: 500 },
            slo_tier: SloTier::Routine,
            watchdog_ms: 400,
            programs: vec![],
        };
        assert_eq!(cfg.validate(), Err(TaskConfigError::EmptyName));
    }

    #[test]
    fn task_config_validate_zero_cyclic_period_rejects() {
        let cfg = TaskConfig {
            name: "bad_task".into(),
            kind: TaskKind::Cyclic { period_ms: 0 },
            slo_tier: SloTier::Routine,
            watchdog_ms: 400,
            programs: vec![],
        };
        assert!(matches!(
            cfg.validate(),
            Err(TaskConfigError::ZeroCyclicPeriod { .. })
        ));
    }

    #[test]
    fn task_config_validate_empty_event_tag_rejects() {
        let cfg = TaskConfig {
            name: "event_task".into(),
            kind: TaskKind::Event {
                event_tag: "".into(),
            },
            slo_tier: SloTier::Routine,
            watchdog_ms: 400,
            programs: vec![],
        };
        assert!(matches!(
            cfg.validate(),
            Err(TaskConfigError::EmptyEventTag { .. })
        ));
    }

    #[test]
    fn task_stats_first_tick_seeds_min_max_avg() {
        let mut s = TaskStats::default();
        s.record_tick(450, 500);
        assert_eq!(s.ticks_executed, 1);
        assert_eq!(s.last_cycle_ms, 450);
        assert_eq!(s.cycle_ms_min, 450);
        assert_eq!(s.cycle_ms_max, 450);
        assert_eq!(s.cycle_ms_avg, 450.0);
        assert_eq!(s.last_jitter_ms, 50);
        assert_eq!(s.jitter_ms_max, 50);
        assert_eq!(s.overrun_count, 0);
    }

    #[test]
    fn task_stats_multi_tick_updates_min_max_avg() {
        let mut s = TaskStats::default();
        s.record_tick(450, 500);
        s.record_tick(550, 500);
        s.record_tick(500, 500);
        assert_eq!(s.ticks_executed, 3);
        assert_eq!(s.cycle_ms_min, 450);
        assert_eq!(s.cycle_ms_max, 550);
        // Online avg = (450 + 550 + 500) / 3 = 500.
        assert!((s.cycle_ms_avg - 500.0).abs() < 1e-9);
    }

    #[test]
    fn task_stats_overrun_counted_when_actual_exceeds_target() {
        let mut s = TaskStats::default();
        s.record_tick(600, 500); // overrun
        s.record_tick(400, 500); // no overrun
        s.record_tick(700, 500); // overrun
        assert_eq!(s.overrun_count, 2);
    }

    #[test]
    fn task_stats_p99_approx_tracks_spikes_then_decays() {
        let mut s = TaskStats::default();
        // Burst of 100 ms jitter ticks.
        for _ in 0..5 {
            s.record_tick(600, 500); // jitter 100
        }
        let p99_after_burst = s.jitter_ms_p99_approx;
        assert!(p99_after_burst >= 90); // stays high

        // Followed by calm ticks (jitter 0).
        for _ in 0..20 {
            s.record_tick(500, 500);
        }
        let p99_after_calm = s.jitter_ms_p99_approx;
        // EWMA decays over many ticks; should drop
        // substantially (< half the burst value).
        assert!(
            p99_after_calm < p99_after_burst / 2,
            "expected EWMA decay: burst={} calm={}",
            p99_after_burst,
            p99_after_calm
        );
    }

    #[test]
    fn task_stats_watchdog_kill_increments_counter() {
        let mut s = TaskStats::default();
        s.record_watchdog_kill(1000, 500);
        assert_eq!(s.watchdog_kill_count, 1);
        assert_eq!(s.ticks_executed, 1);
        // The watchdog kill counts as a tick with
        // actual=1000 vs target=500 → overrun.
        assert_eq!(s.overrun_count, 1);
    }
}
