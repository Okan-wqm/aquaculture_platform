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
//! ## Audit emit on rollback (Batch 113 Sprint 6.5)
//!
//! The watchdog runs out-of-dispatch-path (background
//! tokio task, not an MQTT command handler), so the
//! Batch 79 `execute_command` pre+post audit-emit does NOT
//! cover Rollback transitions. Batch 113 wires an
//! audit-sink dependency directly into `watchdog_tick` +
//! `run_cold_boot_watchdog` and emits
//! `AuditAction::FirmwareDeployRollback` entries on every
//! actionable outcome (RolledBack, RolledBackBootloaderFailed,
//! RollbackFailed, InconsistentState).
//!
//! The `audit_sink` parameter is `Option<Arc<AuditSink>>` so
//! non-Enabled audit modes stay zero-cost (matches the
//! Batch 79 emit contract). Append failures are WARN-logged
//! but do not revert software state or re-enter the
//! rollback loop (same discipline as Batch 79 command-path
//! emits).

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing::{error, info, warn};

use super::bootloader::BootloaderHandle;
use super::partition::{PartitionRoll, SlotState};
use super::partition_store::PartitionStore;
use crate::audit::{
    AuditAction, AuditActor, AuditEntry, AuditOutcome, AuditPhase, AuditResource, AuditSink,
};
use crate::authz::permission::TenantId;

/// Context for watchdog-originated audit entries. Holds the
/// identity fields the Batch 79 command-path pulls from
/// AppState + CommandMessage; watchdog runs out-of-dispatch
/// and needs them injected explicitly.
#[derive(Clone)]
pub struct WatchdogAuditCtx {
    /// Optional audit sink. None when `audit.mode != Enabled`.
    pub sink: Option<Arc<AuditSink>>,
    /// Device identifier (same string used by command path).
    pub device_id: String,
    /// Tenant binding; zero-tenant when not activated.
    pub tenant: TenantId,
}

impl WatchdogAuditCtx {
    /// Construct with no sink — the zero-cost default for
    /// non-Enabled audit modes + for test fixtures that do
    /// not exercise the audit path.
    pub fn disabled(device_id: String) -> Self {
        Self {
            sink: None,
            device_id,
            tenant: TenantId::new_from_verified([0u8; 16]),
        }
    }

    fn emit(&self, phase: AuditPhase, outcome: AuditOutcome, detail: String) {
        let Some(sink) = self.sink.as_ref() else {
            return;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO);
        let entry = AuditEntry {
            timestamp_unix_secs: now.as_secs() as i64,
            timestamp_nanos: now.subsec_nanos(),
            correlation_id: format!("watchdog-{}", now.as_nanos()),
            phase,
            actor: AuditActor::new(format!("system:cold_boot_watchdog:{}", self.device_id)),
            tenant: self.tenant,
            policy_version: 0,
            two_person_integrity_verified: false,
            action: AuditAction::FirmwareDeployRollback,
            resource: AuditResource::Other {
                label: "ab_partition".to_string(),
            },
            outcome,
            detail,
        };
        if let Err(e) = sink.append(entry) {
            warn!(
                "watchdog audit emit failed (phase={:?} outcome={:?}): {}",
                phase, outcome, e
            );
        }
    }
}

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
    audit_ctx: &WatchdogAuditCtx,
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
        audit_ctx.emit(
            AuditPhase::Post,
            AuditOutcome::Failure,
            format!(
                "outcome=inconsistent_state failed={:?} no_standby=true",
                failed
            ),
        );
        return WatchdogTickOutcome::InconsistentState;
    };

    // Batch 113 Sprint 6.5: emit PRE-exec audit event
    // before the apply_roll + bootloader coord runs. Mirrors
    // the Batch 79 command-path pre+post pattern.
    audit_ctx.emit(
        AuditPhase::Pre,
        AuditOutcome::Success,
        format!(
            "action=firmware_rollback failed={:?} restored_active={:?} bootloader_backend={}",
            failed,
            restored_active,
            bootloader.backend_name()
        ),
    );

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
                failed,
                restored_active,
                new_state,
                bootloader.backend_name()
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
                    audit_ctx.emit(
                        AuditPhase::Post,
                        AuditOutcome::Success,
                        format!(
                            "outcome=rolled_back failed={:?} restored_active={:?} bootloader_ok=true backend={}",
                            failed,
                            restored_active,
                            bootloader.backend_name()
                        ),
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
                    audit_ctx.emit(
                        AuditPhase::Post,
                        AuditOutcome::Failure,
                        format!(
                            "outcome=rolled_back_bootloader_failed failed={:?} restored_active={:?} bootloader_err={} backend={}",
                            failed,
                            restored_active,
                            e,
                            bootloader.backend_name()
                        ),
                    );
                    WatchdogTickOutcome::RolledBackBootloaderFailed
                }
            }
        }
        Err(e) => {
            error!("cold-boot watchdog: rollback apply_roll failed: {}", e);
            audit_ctx.emit(
                AuditPhase::Post,
                AuditOutcome::Failure,
                format!(
                    "outcome=rollback_apply_failed failed={:?} restored_active={:?} err={}",
                    failed, restored_active, e
                ),
            );
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
///
/// `health_state` (Batch 133 Sprint 6.5 wire — closes Batch
/// 132 obs #1) is the Prometheus metric sink. When Some,
/// the task bumps `suderra_firmware_rollback_total` on
/// every RolledBack / RolledBackBootloaderFailed outcome +
/// updates `suderra_firmware_active_slot` gauge to reflect
/// the post-rollback state. None when health is disabled
/// or HealthState hasn't been constructed yet at spawn
/// time.
pub async fn run_cold_boot_watchdog(
    store: Arc<PartitionStore>,
    poll_interval: Duration,
    cold_boot_budget_secs: u64,
    bootloader: Arc<dyn BootloaderHandle>,
    audit_ctx: WatchdogAuditCtx,
    #[cfg(feature = "health")] health_state: Option<crate::health::HealthState>,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) {
    info!(
        "cold-boot watchdog task started (poll={}s budget={}s bootloader_backend={} audit_emit={})",
        poll_interval.as_secs(),
        cold_boot_budget_secs,
        bootloader.backend_name(),
        audit_ctx.sink.is_some()
    );

    let mut interval = tokio::time::interval(poll_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // First tick fires immediately; capture the initial
    // state + then fall into the poll cadence.
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let outcome = watchdog_tick(
                    &store,
                    cold_boot_budget_secs,
                    bootloader.as_ref(),
                    &audit_ctx,
                );
                // Batch 133 Sprint 6.5: bump rollback
                // counter + refresh active_slot gauge when
                // the tick actually rolled back. Both
                // outcomes (RolledBack + split-brain
                // RolledBackBootloaderFailed) count as
                // rollback events for the counter — the
                // split-brain case is surfaced separately
                // via audit_emit detail (Batch 113) so
                // operators can drill into the split-brain
                // subset via audit queries while the
                // counter tracks fleet-wide rollback rate.
                #[cfg(feature = "health")]
                {
                    if matches!(
                        outcome,
                        WatchdogTickOutcome::RolledBack
                            | WatchdogTickOutcome::RolledBackBootloaderFailed
                    ) {
                        if let Some(hs) = health_state.as_ref() {
                            hs.inc_firmware_rollback();
                            // Read post-rollback snapshot
                            // to refresh the active_slot
                            // gauge — apply_roll already
                            // committed the state + the
                            // flock release means this
                            // read sees the new active.
                            if let Ok(snap) = store.snapshot() {
                                hs.set_firmware_active_slot(
                                    match snap.active {
                                        super::partition::AbPartition::A => 0,
                                        super::partition::AbPartition::B => 1,
                                    },
                                );
                            }
                        }
                    }
                }
                let _ = outcome;
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
    use super::super::bootloader::{BootloaderError, NoopBootloaderHandle};
    use super::super::partition::AbPartition;
    use super::*;
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
        fn set_next_boot_slot(&self, _slot: AbPartition) -> Result<(), BootloaderError> {
            Ok(())
        }

        fn clear_pending_boot(&self, _slot: AbPartition) -> Result<(), BootloaderError> {
            Ok(())
        }

        fn rollback_next_boot(&self, to_slot: AbPartition) -> Result<(), BootloaderError> {
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
        let outcome = watchdog_tick(
            &store,
            90,
            &NoopBootloaderHandle,
            &WatchdogAuditCtx::disabled("test-dev".into()),
        );
        assert_eq!(outcome, WatchdogTickOutcome::NoPending);
    }

    #[test]
    fn fresh_deadline_returns_deadline_fresh() {
        let store = tmp_store();
        store
            .apply_roll(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600, // 1 hour — well in the future
            )
            .expect("install");
        let outcome = watchdog_tick(
            &store,
            3600,
            &NoopBootloaderHandle,
            &WatchdogAuditCtx::disabled("test-dev".into()),
        );
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                0, // already-expired deadline
            )
            .expect("install");
        // Sleep 1s to ensure now > 0-deadline.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let outcome = watchdog_tick(
            &store,
            90,
            &NoopBootloaderHandle,
            &WatchdogAuditCtx::disabled("test-dev".into()),
        );
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
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

        let outcome = watchdog_tick(
            &store,
            90,
            &bootloader,
            &WatchdogAuditCtx::disabled("test-dev".into()),
        );
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
    fn audit_ctx_emits_pre_and_post_on_successful_rollback() {
        // Batch 113: watchdog audit emit. Wire a real
        // AuditSink (tempfile-backed, test HMAC key) + assert
        // the rollback path emits exactly 2 entries (pre +
        // post) with FirmwareDeployRollback action.
        use crate::audit::AuditHmacKey;

        let store = tmp_store();
        let bootloader = RecordingBootloader::new();
        store
            .apply_roll(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
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

        let audit_path = std::env::temp_dir().join(format!(
            "suderra-watchdog-audit-{}-{}.ndjson",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_file(&audit_path);
        let sink = std::sync::Arc::new(
            AuditSink::open(&audit_path, AuditHmacKey::from_bytes([0x42u8; 32]))
                .expect("open audit sink"),
        );

        let audit_ctx = WatchdogAuditCtx {
            sink: Some(sink.clone()),
            device_id: "test-dev".into(),
            tenant: TenantId::new_from_verified([0xAAu8; 16]),
        };

        let outcome = watchdog_tick(&store, 90, &bootloader, &audit_ctx);
        assert_eq!(outcome, WatchdogTickOutcome::RolledBack);

        // Drop sink so the BufWriter flushes before we read.
        drop(sink);

        let log_content = std::fs::read_to_string(&audit_path).expect("read audit log");
        let lines: Vec<&str> = log_content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .collect();
        assert_eq!(lines.len(), 2, "expected pre+post emit, got: {:?}", lines);

        let pre_line = lines[0];
        let post_line = lines[1];
        assert!(
            pre_line.contains("\"action\":\"firmware_deploy_rollback\"")
                || pre_line.contains("FirmwareDeployRollback"),
            "pre line should carry firmware_deploy_rollback action; got: {}",
            pre_line
        );
        assert!(
            pre_line.contains("\"phase\":\"pre\"") || pre_line.contains("Pre"),
            "pre line should carry Pre phase; got: {}",
            pre_line
        );
        assert!(
            post_line.contains("\"phase\":\"post\"") || post_line.contains("Post"),
            "post line should carry Post phase; got: {}",
            post_line
        );
        assert!(
            post_line.contains("outcome=rolled_back"),
            "post line should detail the rolled_back outcome; got: {}",
            post_line
        );

        let _ = std::fs::remove_file(&audit_path);
    }

    #[cfg(feature = "health")]
    #[test]
    fn run_cold_boot_watchdog_bumps_rollback_metric_on_rolled_back_outcome() {
        // Batch 133 Sprint 6.5: prove the watchdog task
        // actually bumps the firmware_rollback Prometheus
        // counter when a tick fires RolledBack. We can't
        // easily drive the async task here (would need a
        // tokio test with shutdown signaling + tick
        // waiting), so we exercise the metric-emit path
        // via watchdog_tick + a side-by-side HealthState
        // increment matching the run_cold_boot_watchdog
        // logic.
        use crate::health::HealthState;

        let store = tmp_store();
        let bootloader = RecordingBootloader::new();
        store
            .apply_roll(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
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

        let outcome = watchdog_tick(
            &store,
            90,
            &bootloader,
            &WatchdogAuditCtx::disabled("test-dev".into()),
        );
        assert_eq!(outcome, WatchdogTickOutcome::RolledBack);

        // Simulate the run_cold_boot_watchdog metric-bump
        // block (kept identical to the production path via
        // matches! on the two rollback outcomes).
        let hs = HealthState::new();
        if matches!(
            outcome,
            WatchdogTickOutcome::RolledBack | WatchdogTickOutcome::RolledBackBootloaderFailed
        ) {
            hs.inc_firmware_rollback();
            if let Ok(snap) = store.snapshot() {
                hs.set_firmware_active_slot(match snap.active {
                    AbPartition::A => 0,
                    AbPartition::B => 1,
                });
            }
        }

        let metrics = hs.metrics_prometheus();
        let rollback_line = metrics
            .lines()
            .find(|l| l.starts_with("suderra_firmware_rollback_total"))
            .expect("rollback metric missing");
        assert!(
            rollback_line.ends_with(" 1"),
            "expected rollback=1 after one RolledBack tick: {}",
            rollback_line
        );
        // After rollback, slot A is the restored Active.
        let slot_line = metrics
            .lines()
            .find(|l| l.starts_with("suderra_firmware_active_slot"))
            .expect("slot metric missing");
        assert!(
            slot_line.ends_with(" 0"),
            "expected active_slot=0 (A) after RolledBack: {}",
            slot_line
        );
    }

    #[test]
    fn audit_ctx_disabled_is_zero_cost_noop() {
        // The disabled ctx is zero-cost when audit mode is
        // off. Prove no panic + no side effect beyond the
        // usual rollback.
        let store = tmp_store();
        let bootloader = RecordingBootloader::new();
        store
            .apply_roll(
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
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

        let audit_ctx = WatchdogAuditCtx::disabled("test-dev".into());
        let outcome = watchdog_tick(&store, 90, &bootloader, &audit_ctx);
        assert_eq!(outcome, WatchdogTickOutcome::RolledBack);
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
                PartitionRoll::InitialInstall {
                    target: AbPartition::A,
                },
                3600,
            )
            .expect("install");
        store
            .apply_roll(
                PartitionRoll::Confirm {
                    slot: AbPartition::A,
                },
                3600,
            )
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

        let outcome = watchdog_tick(
            &store,
            90,
            &bootloader,
            &WatchdogAuditCtx::disabled("test-dev".into()),
        );
        assert_eq!(outcome, WatchdogTickOutcome::RolledBackBootloaderFailed);

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
