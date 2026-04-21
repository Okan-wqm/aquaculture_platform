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
//! ## Bootloader coordination (Batch 112 Sprint 6.5)
//!
//! Rollback now pairs the software `apply_roll(Rollback)`
//! with a call on `BootloaderHandle::rollback_next_boot` —
//! the layer-2 side of partition-state coordination.
//! NoopBootloaderHandle is the zero-cost non-RPi default
//! (WARN-log + Ok); TrybootBootloaderHandle (real RPi,
//! pending hardware) flips the actual /boot/tryboot.cfg
//! flag so the next boot follows the restored slot.
//!
//! If the bootloader call fails, the software state is
//! ALREADY committed. The tick returns `RolledBackBootloaderFailed`
//! — a distinct outcome so the caller / tests can observe
//! that the split-brain window opened. Next tick is a no-op
//! (deadline already consumed); operator intervention via
//! --confirm-active or manual reboot restores sync.
//!
//! ## Audit emit on rollback
//!
//! Batch 113 lands audit-emit wiring that consumes the
//! Batch 79 `audit_sink` pre+post pattern across updater
//! transitions. Today the watchdog ERROR-logs the
//! transition — already captured by the observability
//! pipeline (Prometheus counter + structured log).

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing::{error, info, warn};

use super::bootloader::BootloaderHandle;
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
    /// Deadline expired + rollback applied successfully
    /// (both PartitionStore + BootloaderHandle reached Ok).
    RolledBack,
    /// Deadline expired + PartitionStore rollback applied
    /// successfully BUT `BootloaderHandle::rollback_next_boot`
    /// returned Err. The software state is correct
    /// (restored_active is now Active in the JSON); the
    /// hardware side may still point at the failed slot.
    /// Logged as ERROR; operator runs `--confirm-active` or
    /// reboots via recovery to resync. Next tick is a no-op
    /// (deadline consumed). Batch 112 Sprint 6.5.
    RolledBackBootloaderFailed,
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
///
/// `bootloader` coordinates the layer-2 (hardware) side of
/// the rollback. NoopBootloaderHandle (non-RPi) WARN-logs +
/// returns Ok. TrybootBootloaderHandle (real RPi) flips
/// /boot/tryboot.cfg to the restored slot. A bootloader
/// failure returns `RolledBackBootloaderFailed` so the
/// software/hardware split-brain is observable.
pub fn watchdog_tick(
    store: &PartitionStore,
    cold_boot_budget_secs: u64,
    bootloader: &dyn BootloaderHandle,
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
                "cold-boot watchdog: FIRED — rolled back failed={:?} restored_active={:?} new_state={:?} bootloader_backend={}",
                failed, restored_active, new_state, bootloader.backend_name()
            );

            // Batch 112 Sprint 6.5: pair software rollback
            // with bootloader-flag rollback. Noop backend
            // WARN-logs (operator-intervention signal);
            // Tryboot backend flips /boot/tryboot.cfg.
            match bootloader.rollback_next_boot(restored_active) {
                Ok(()) => {
                    info!(
                        "cold-boot watchdog: bootloader rollback_next_boot({:?}) OK (backend={})",
                        restored_active,
                        bootloader.backend_name()
                    );
                    WatchdogTickOutcome::RolledBack
                }
                Err(e) => {
                    // Software state is already committed.
                    // Hardware side may still point at the
                    // failed slot. Operator runs
                    // --confirm-active or reboots via
                    // recovery to resync. Next tick is a
                    // no-op (deadline consumed).
                    warn!(
                        "cold-boot watchdog: software rollback OK, bootloader rollback_next_boot({:?}) FAILED: {} (backend={}) — SPLIT-BRAIN: operator must resync",
                        restored_active,
                        e,
                        bootloader.backend_name()
                    );
                    WatchdogTickOutcome::RolledBackBootloaderFailed
                }
            }
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
///
/// `bootloader` is the layer-2 coordination handle (Batch
/// 112 wire). NoopBootloaderHandle is the zero-cost default
/// for non-RPi deployments.
pub async fn run_cold_boot_watchdog(
    store: Arc<PartitionStore>,
    poll_interval: Duration,
    cold_boot_budget_secs: u64,
    bootloader: Arc<dyn BootloaderHandle>,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) {
    info!(
        "cold-boot watchdog task started (poll={}s budget={}s bootloader_backend={})",
        poll_interval.as_secs(),
        cold_boot_budget_secs,
        bootloader.backend_name()
    );

    let mut interval = tokio::time::interval(poll_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // First tick fires immediately; capture the initial
    // state + then fall into the poll cadence.
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let _outcome = watchdog_tick(
                    &store,
                    cold_boot_budget_secs,
                    bootloader.as_ref(),
                );
                // Outcome logged inside watchdog_tick when
                // actionable (InconsistentState / RolledBack
                // / RolledBackBootloaderFailed /
                // RollbackFailed). NoPending + DeadlineFresh
                // are the common steady-state paths; not
                // logged to avoid noise.
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
    use super::super::bootloader::{BootloaderError, NoopBootloaderHandle};
    use super::super::partition::AbPartition;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn tmp_store() -> Arc<PartitionStore> {
        let path = std::env::temp_dir().join(format!(
            "suderra-watchdog-test-{}-{}.json",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_file(&path);
        Arc::new(PartitionStore::open(Some(&path)).expect("open"))
    }

    /// Test bootloader that records every call + lets
    /// tests assert the watchdog reached the hardware layer.
    struct RecordingBootloader {
        rollback_calls: AtomicUsize,
        last_rollback_slot: std::sync::Mutex<Option<AbPartition>>,
        fail_rollback: AtomicBool,
    }

    impl RecordingBootloader {
        fn new() -> Self {
            Self {
                rollback_calls: AtomicUsize::new(0),
                last_rollback_slot: std::sync::Mutex::new(None),
                fail_rollback: AtomicBool::new(false),
            }
        }

        fn with_rollback_failure() -> Self {
            let b = Self::new();
            b.fail_rollback.store(true, Ordering::SeqCst);
            b
        }
    }

    impl BootloaderHandle for RecordingBootloader {
        fn set_next_boot_slot(
            &self,
            _slot: AbPartition,
        ) -> Result<(), BootloaderError> {
            Ok(())
        }

        fn clear_pending_boot(
            &self,
            _slot: AbPartition,
        ) -> Result<(), BootloaderError> {
            Ok(())
        }

        fn rollback_next_boot(
            &self,
            to_slot: AbPartition,
        ) -> Result<(), BootloaderError> {
            self.rollback_calls.fetch_add(1, Ordering::SeqCst);
            *self.last_rollback_slot.lock().unwrap() = Some(to_slot);
            if self.fail_rollback.load(Ordering::SeqCst) {
                Err(BootloaderError::IoError(
                    "test-induced rollback failure".into(),
                ))
            } else {
                Ok(())
            }
        }

        fn active_slot_at_boot(&self) -> Option<AbPartition> {
            None
        }

        fn backend_name(&self) -> &'static str {
            "recording"
        }
    }

    #[test]
    fn no_pending_returns_no_pending() {
        let store = tmp_store();
        let outcome = watchdog_tick(&store, 90, &NoopBootloaderHandle);
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
        let outcome = watchdog_tick(&store, 3600, &NoopBootloaderHandle);
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
        let outcome = watchdog_tick(&store, 90, &NoopBootloaderHandle);
        assert_eq!(outcome, WatchdogTickOutcome::InconsistentState);
    }

    #[test]
    fn expired_deadline_after_swap_triggers_rollback() {
        // Set up Active=A + Standby absent → needs a full
        // install+confirm first, then swap to B which
        // enters PendingConfirm with A as Standby. THEN
        // expire the deadline.
        let store = tmp_store();
        let bootloader = RecordingBootloader::new();
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

        let outcome = watchdog_tick(&store, 90, &bootloader);
        assert_eq!(outcome, WatchdogTickOutcome::RolledBack);

        // Post-rollback: slot A Active + slot B Empty.
        let snap = store.snapshot().unwrap();
        assert_eq!(snap.active, AbPartition::A);
        assert_eq!(snap.slot_a_state, SlotState::Active);
        assert_eq!(snap.slot_b_state, SlotState::Empty);
        assert!(snap.pending_confirm_deadline_unix_secs.is_none());

        // Bootloader rollback_next_boot was called with the
        // restored slot (A).
        assert_eq!(bootloader.rollback_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            *bootloader.last_rollback_slot.lock().unwrap(),
            Some(AbPartition::A)
        );
    }

    #[test]
    fn bootloader_rollback_failure_surfaces_split_brain_outcome() {
        // Set up the same swap-then-expire scenario but with
        // a bootloader that fails rollback_next_boot. The
        // software side still rolls back (PartitionStore is
        // already committed); the outcome is the
        // RolledBackBootloaderFailed variant so the caller
        // can observe the split-brain window.
        let store = tmp_store();
        let bootloader = RecordingBootloader::with_rollback_failure();
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
                0,
            )
            .expect("swap");
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let outcome = watchdog_tick(&store, 90, &bootloader);
        assert_eq!(
            outcome,
            WatchdogTickOutcome::RolledBackBootloaderFailed
        );

        // Software state IS rolled back even though hardware
        // side failed — that's the split-brain the outcome
        // variant surfaces.
        let snap = store.snapshot().unwrap();
        assert_eq!(snap.active, AbPartition::A);
        assert_eq!(snap.slot_a_state, SlotState::Active);
        assert_eq!(snap.slot_b_state, SlotState::Empty);

        // Bootloader was called exactly once (no retry
        // loop — the design leaves resync to operator).
        assert_eq!(bootloader.rollback_calls.load(Ordering::SeqCst), 1);
    }
}
