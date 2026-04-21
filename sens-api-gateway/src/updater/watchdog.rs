//! Cold-boot-budget watchdog task (Batch 107 Sprint 6.5
//! runtime).
//!
//! ## WHY
//!
//! Plan §2 HC-11 + ADR-019 §6 mandate a cold-boot budget:
//! when a firmware update promotes a slot to
//! `SlotState::PendingConfirm`, the new agent has exactly
//! `cold_boot_budget_secs` (default 90s, RevPi 120s) to
//! boot successfully + transition to Active via the Batch
//! 110 post-boot-confirm service. If the deadline elapses
//! without Confirm, THIS watchdog triggers a Rollback —
//! the old Standby slot restores as Active, the failed
//! PendingConfirm slot is marked Empty.
//!
//! This closes the "broken firmware could brick the device"
//! attack + operational-error class by giving rollback a
//! deterministic time bound.
//!
//! ## WHAT
//!
//! `run_cold_boot_watchdog(store, poll_interval)`:
//! - Loops forever (tokio task) polling `store.snapshot()`
//!   every `poll_interval`.
//! - If `pending_confirm_deadline_unix_secs` is Some AND
//!   `now > deadline`:
//!   1. Identify the failed slot (state == PendingConfirm).
//!   2. Identify the restored-active slot (state == Standby).
//!   3. Apply `PartitionRoll::Rollback { failed,
//!      restored_active }`.
//!   4. ERROR-log + (future Batch 109 orchestrator) emit
//!      audit event.
//! - If deadline is None OR not yet expired: no-op.
//!
//! ## Poll interval discipline
//!
//! Default 10 seconds. A faster interval (say 1s) would
//! give tighter rollback latency but wastes CPU on a
//! largely-idle path. The cold-boot budget is itself
//! measured in tens of seconds; the watchdog firing
//! within 10s of the deadline is more than accurate enough
//! for the operator-visible outcome ("rollback happened").
//!
//! ## Shutdown behavior
//!
//! The caller owns the task's JoinHandle + signals
//! shutdown via tokio::select! recv — same pattern as
//! Batch 93 jti_dedup_sweep task.
//!
//! ## What this batch DOES NOT do
//!
//! - Actual bootloader flag write (RPi tryboot overlay):
//!   Batch 108. Until that lands, Rollback mutates the
//!   PartitionStore state ONLY. On next reboot the
//!   bootloader still boots the PendingConfirm partition
//!   (because its flag is still set). Batch 108 coordinates
//!   PartitionStore with /boot/tryboot.cfg so a Rollback
//!   here actually results in the OLD slot booting next.
//! - Audit event emit on rollback. That's Batch 109 when
//!   the updater command handler lands + we have a clean
//!   audit-emit site.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing::{error, info};

use super::partition::{PartitionRoll, SlotState};
use super::partition_store::PartitionStore;

/// Default watchdog poll interval. 10s gives ~10s
/// rollback-latency bound on top of the cold-boot budget.
pub const DEFAULT_WATCHDOG_POLL_INTERVAL_SECS: u64 = 10;

/// Outcome of a single watchdog tick. Returned for test +
/// observability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogTickOutcome {
    /// No PendingConfirm window open — nothing to check.
    NoPending,
    /// Deadline not yet reached — keep waiting.
    DeadlineFresh,
    /// Deadline expired + rollback applied successfully.
    RolledBack,
    /// Deadline expired BUT state shape was inconsistent
    /// (no slot in PendingConfirm, or no slot in Standby).
    /// Logged as error; next tick will re-check.
    InconsistentState,
    /// Rollback apply failed (mutex poisoned, disk write).
    /// Logged as error; next tick will retry.
    RollbackFailed,
}

/// Single-tick logic (extracted for unit test). Returns
/// the outcome so callers can observe + tests can assert.
///
/// `cold_boot_budget_secs` is forwarded to `apply_roll` but
/// doesn't affect rollback behavior (deadline check
/// already decided we're expiring). Kept as a parameter
/// so a future batch that swaps the budget mid-update
/// doesn't hardcode here.
pub fn watchdog_tick(
    store: &PartitionStore,
    cold_boot_budget_secs: u64,
) -> WatchdogTickOutcome {
    let snap = match store.snapshot() {
        Ok(s) => s,
        Err(e) => {
            error!("cold-boot watchdog: snapshot failed: {} — skipping tick", e);
            return WatchdogTickOutcome::InconsistentState;
        }
    };

    let Some(deadline) = snap.pending_confirm_deadline_unix_secs else {
        return WatchdogTickOutcome::NoPending;
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    if now <= deadline {
        return WatchdogTickOutcome::DeadlineFresh;
    }

    // Deadline expired. Identify failed + restored slots.
    let failed = if snap.slot_a_state == SlotState::PendingConfirm {
        super::partition::AbPartition::A
    } else if snap.slot_b_state == SlotState::PendingConfirm {
        super::partition::AbPartition::B
    } else {
        error!(
            "cold-boot watchdog: deadline expired but no slot in PendingConfirm state. \
             snapshot={:?}",
            snap
        );
        return WatchdogTickOutcome::InconsistentState;
    };

    let restored_active = if snap.slot_a_state == SlotState::Standby {
        super::partition::AbPartition::A
    } else if snap.slot_b_state == SlotState::Standby {
        super::partition::AbPartition::B
    } else {
        // First-ever install can't roll back — there's no
        // Standby to restore. Operator must boot into
        // recovery + re-flash. Log + leave state; the
        // PendingConfirm slot is already the active booted
        // one (if the agent is running, boot succeeded
        // functionally; the Confirm-on-health-check step
        // is what's missing, not the firmware itself).
        //
        // Batch 109 orchestrator + platform UI will expose
        // this state for manual operator intervention.
        error!(
            "cold-boot watchdog: deadline expired but no Standby slot (first-install path?). \
             snapshot={:?} — NOT rolling back, operator intervention required",
            snap
        );
        return WatchdogTickOutcome::InconsistentState;
    };

    match store.apply_roll(
        PartitionRoll::Rollback {
            failed,
            restored_active,
        },
        cold_boot_budget_secs,
    ) {
        Ok(new_state) => {
            error!(
                "cold-boot watchdog: FIRED — rolled back failed={:?} restored_active={:?} new_state={:?}",
                failed, restored_active, new_state
            );
            WatchdogTickOutcome::RolledBack
        }
        Err(e) => {
            error!("cold-boot watchdog: rollback apply_roll failed: {}", e);
            WatchdogTickOutcome::RollbackFailed
        }
    }
}

/// Run the watchdog loop until shutdown signal.
///
/// Call from a spawned tokio task; register the handle
/// with ShutdownCoordinator.
pub async fn run_cold_boot_watchdog(
    store: Arc<PartitionStore>,
    poll_interval: Duration,
    cold_boot_budget_secs: u64,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) {
    info!(
        "cold-boot watchdog task started (poll={}s budget={}s)",
        poll_interval.as_secs(),
        cold_boot_budget_secs
    );

    let mut interval = tokio::time::interval(poll_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // First tick fires immediately; capture the initial
    // state + then fall into the poll cadence.
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let _outcome = watchdog_tick(&store, cold_boot_budget_secs);
                // Outcome logged inside watchdog_tick when
                // actionable (InconsistentState / RolledBack
                // / RollbackFailed). NoPending +
                // DeadlineFresh are the common steady-state
                // paths; not logged to avoid noise.
            }
            _ = shutdown.recv() => {
                info!("cold-boot watchdog task shutting down");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::partition::AbPartition;

    fn tmp_store() -> Arc<PartitionStore> {
        let path = std::env::temp_dir().join(format!(
            "suderra-watchdog-test-{}-{}.json",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_file(&path);
        Arc::new(PartitionStore::open(Some(&path)).expect("open"))
    }

    #[test]
    fn no_pending_returns_no_pending() {
        let store = tmp_store();
        let outcome = watchdog_tick(&store, 90);
        assert_eq!(outcome, WatchdogTickOutcome::NoPending);
    }

    #[test]
    fn fresh_deadline_returns_deadline_fresh() {
        let store = tmp_store();
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                3600, // 1 hour — well in the future
            )
            .expect("install");
        let outcome = watchdog_tick(&store, 3600);
        assert_eq!(outcome, WatchdogTickOutcome::DeadlineFresh);
    }

    #[test]
    fn expired_deadline_on_first_install_returns_inconsistent() {
        // First install -> only one slot in PendingConfirm,
        // no Standby. Watchdog refuses to roll back
        // (nowhere to go) and logs error.
        let store = tmp_store();
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                0, // already-expired deadline
            )
            .expect("install");
        // Sleep 1s to ensure now > 0-deadline.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let outcome = watchdog_tick(&store, 90);
        assert_eq!(outcome, WatchdogTickOutcome::InconsistentState);
    }

    #[test]
    fn expired_deadline_after_swap_triggers_rollback() {
        // Set up Active=A + Standby absent → needs a full
        // install+confirm first, then swap to B which
        // enters PendingConfirm with A as Standby. THEN
        // expire the deadline.
        let store = tmp_store();
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                3600,
            )
            .expect("install");
        store
            .apply_roll(PartitionRoll::Confirm { slot: AbPartition::A }, 3600)
            .expect("confirm");
        store
            .apply_roll(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                0, // expired instantly
            )
            .expect("swap");
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let outcome = watchdog_tick(&store, 90);
        assert_eq!(outcome, WatchdogTickOutcome::RolledBack);

        // Post-rollback: slot A Active + slot B Empty.
        let snap = store.snapshot().unwrap();
        assert_eq!(snap.active, AbPartition::A);
        assert_eq!(snap.slot_a_state, SlotState::Active);
        assert_eq!(snap.slot_b_state, SlotState::Empty);
        assert!(snap.pending_confirm_deadline_unix_secs.is_none());
    }
}
