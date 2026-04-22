//! Reusable `Confirm` orchestrator (Batch 122 Sprint 6.5).
//!
//! ## WHY
//!
//! The Confirm transition in the A/B firmware lifecycle is
//! invoked from three separate entry points:
//!
//! 1. MQTT `cmd_confirm_slot` command (Batch 109) — remote
//!    operator + cloud-side health-check service.
//! 2. CLI `run_confirm_active` (Batch 110) — systemd post-
//!    boot-confirm timer, out-of-process path.
//! 3. HTTP `POST /lifecycle/confirm-active` (Batch 122,
//!    this module) — systemd timer + operator curl, in-
//!    process path that preserves the Batch 79/118 audit
//!    emit.
//!
//! Pre-Batch-122 the logic was inlined in (1). (2) had a
//! partial copy without audit emit. (3) would have
//! duplicated again. Root-cause fix: factor the core
//! orchestration into this module; all three entry points
//! call `perform_confirm_slot()` + share the same
//! validation, error taxonomy, and bootloader coordination
//! semantics.
//!
//! ## What this module owns
//!
//! - The `ConfirmOutcome` enum — success / validation
//!   errors / apply failures, all with enough shape for
//!   callers to build their own response JSON.
//! - `perform_confirm_slot` — pure async-free function
//!   that takes the `PartitionStore` + `BootloaderHandle`
//!   references + an optional slot param + runs the
//!   Confirm flow end-to-end.
//!
//! ## What this module deliberately does NOT do
//!
//! - Audit emit. Callers do that from their own audit
//!   context (MQTT path already emits via Batch 79
//!   dispatch; HTTP path calls into audit_emit directly;
//!   CLI path is out-of-process + has a separate tracked
//!   audit-gap finding).
//! - MQTT / HTTP response serialization. Each caller
//!   shapes the outcome into its own wire format.

use std::sync::Arc;

use tracing::{info, warn};

use super::bootloader::BootloaderHandle;
use super::partition::{AbPartition, PartitionRoll, SlotState};
use super::partition_store::{PartitionState, PartitionStore};

/// Operator-supplied slot selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmSlotSelector {
    /// Explicit slot — verified non-None operator intent.
    Explicit(AbPartition),
    /// Use the current snapshot's active slot. Matches the
    /// common post-boot-self-confirm flow: the active slot
    /// IS the PendingConfirm one right after SwapToPending
    /// and the newly-booted agent confirms itself.
    ActiveFromSnapshot,
}

/// Outcome of `perform_confirm_slot`. Success carries the
/// post-apply state + bootloader coordination result.
/// Failure variants carry enough shape that callers can
/// build their own JSON / HTTP status / MQTT error string.
#[derive(Debug)]
pub enum ConfirmOutcome {
    /// Happy path — partition state transitioned + bootloader
    /// call returned. `bootloader_ok == false` surfaces the
    /// split-brain window (software committed, hardware
    /// coord failed; operator resync path documented in
    /// Batch 112).
    Ok {
        confirmed_slot: AbPartition,
        new_state: PartitionState,
        bootloader_backend: &'static str,
        bootloader_ok: bool,
        /// Set when bootloader.clear_pending_boot returned
        /// Err — full error-string for logs / audit detail.
        bootloader_err: Option<String>,
    },
    /// Snapshot read failed (file IO / parse / lock
    /// poisoned).
    SnapshotFailed(String),
    /// apply_roll(Confirm) returned Err (typically
    /// InvalidTransition when the slot is not in
    /// PendingConfirm).
    ApplyRollRejected(String),
    /// Invalid slot parameter ("c", empty string, etc.).
    /// Kept distinct from ApplyRollRejected so callers
    /// can map to "operator-input-error" vs "partition-
    /// state-error" distinct response codes.
    InvalidSlotParam(String),
}

/// Orchestrator — verify + apply + bootloader coord.
///
/// Returns a `ConfirmOutcome` that callers wrap in their
/// own response shape (MQTT CommandResponse / HTTP JSON /
/// CLI stdout). All fallible steps surface structured
/// enum variants; no panics; no side-effects beyond the
/// PartitionStore + BootloaderHandle calls.
pub fn perform_confirm_slot(
    partition_store: &Arc<PartitionStore>,
    bootloader: &Arc<dyn BootloaderHandle>,
    selector: ConfirmSlotSelector,
) -> ConfirmOutcome {
    // Resolve target slot.
    let slot = match selector {
        ConfirmSlotSelector::Explicit(s) => s,
        ConfirmSlotSelector::ActiveFromSnapshot => {
            match partition_store.snapshot() {
                Ok(s) => s.active,
                Err(e) => return ConfirmOutcome::SnapshotFailed(e.to_string()),
            }
        }
    };

    let cold_boot_budget_secs =
        crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;

    let new_state = match partition_store.apply_roll(
        PartitionRoll::Confirm { slot },
        cold_boot_budget_secs,
    ) {
        Ok(s) => s,
        Err(e) => {
            warn!(
                "confirm_orchestrator REJECTED: slot={:?} err={}",
                slot, e
            );
            return ConfirmOutcome::ApplyRollRejected(e.to_string());
        }
    };

    info!(
        "confirm_orchestrator SUCCESS: slot={:?} new_state={:?}",
        slot, new_state
    );

    // Bootloader coord — split-brain discipline from Batch
    // 112 + Batch 116: log + surface; do NOT revert software
    // state on bootloader failure.
    let (bootloader_ok, bootloader_err) = match bootloader.clear_pending_boot(slot) {
        Ok(()) => {
            info!(
                "confirm_orchestrator: bootloader clear_pending_boot({:?}) OK (backend={})",
                slot,
                bootloader.backend_name()
            );
            (true, None)
        }
        Err(e) => {
            let err_str = e.to_string();
            warn!(
                "confirm_orchestrator: software Confirm OK, bootloader clear_pending_boot({:?}) FAILED: {} (backend={}) — SPLIT-BRAIN: operator must resync",
                slot,
                err_str,
                bootloader.backend_name()
            );
            (false, Some(err_str))
        }
    };

    ConfirmOutcome::Ok {
        confirmed_slot: slot,
        new_state,
        bootloader_backend: bootloader.backend_name(),
        bootloader_ok,
        bootloader_err,
    }
}

/// Parse a string slot parameter ("a" / "A" / "b" / "B")
/// into a ConfirmSlotSelector. Returns None on invalid
/// input — callers convert to InvalidSlotParam outcome
/// with the sanitized input attached.
pub fn parse_slot_param(raw: Option<&str>) -> Option<ConfirmSlotSelector> {
    match raw {
        None => Some(ConfirmSlotSelector::ActiveFromSnapshot),
        Some("a") | Some("A") => Some(ConfirmSlotSelector::Explicit(AbPartition::A)),
        Some("b") | Some("B") => Some(ConfirmSlotSelector::Explicit(AbPartition::B)),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::bootloader::NoopBootloaderHandle;

    fn tmp_store() -> Arc<PartitionStore> {
        let path = std::env::temp_dir().join(format!(
            "suderra-confirm-orch-{}-{}.json",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_file(&path);
        Arc::new(PartitionStore::open(Some(&path)).expect("open"))
    }

    #[test]
    fn parse_slot_param_accepts_both_cases_and_missing() {
        assert!(matches!(
            parse_slot_param(None),
            Some(ConfirmSlotSelector::ActiveFromSnapshot)
        ));
        assert!(matches!(
            parse_slot_param(Some("a")),
            Some(ConfirmSlotSelector::Explicit(AbPartition::A))
        ));
        assert!(matches!(
            parse_slot_param(Some("A")),
            Some(ConfirmSlotSelector::Explicit(AbPartition::A))
        ));
        assert!(matches!(
            parse_slot_param(Some("b")),
            Some(ConfirmSlotSelector::Explicit(AbPartition::B))
        ));
        assert!(matches!(
            parse_slot_param(Some("B")),
            Some(ConfirmSlotSelector::Explicit(AbPartition::B))
        ));
        assert!(parse_slot_param(Some("c")).is_none());
        assert!(parse_slot_param(Some("")).is_none());
    }

    #[test]
    fn perform_confirm_slot_happy_path_active_from_snapshot() {
        let store = tmp_store();
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                3600,
            )
            .expect("install");
        let bootloader: Arc<dyn BootloaderHandle> =
            Arc::new(NoopBootloaderHandle);

        let outcome = perform_confirm_slot(
            &store,
            &bootloader,
            ConfirmSlotSelector::ActiveFromSnapshot,
        );
        match outcome {
            ConfirmOutcome::Ok {
                confirmed_slot,
                new_state,
                bootloader_backend,
                bootloader_ok,
                bootloader_err,
            } => {
                assert_eq!(confirmed_slot, AbPartition::A);
                assert_eq!(new_state.active, AbPartition::A);
                assert_eq!(new_state.slot_a_state, SlotState::Active);
                assert_eq!(bootloader_backend, "noop");
                assert!(bootloader_ok);
                assert!(bootloader_err.is_none());
            }
            other => panic!("expected Ok outcome, got {:?}", other),
        }
    }

    #[test]
    fn perform_confirm_slot_rejects_when_slot_not_in_pending_confirm() {
        // Fresh store — both slots Empty. Confirm on any
        // slot must reject (state machine invariant: Confirm
        // requires PendingConfirm).
        let store = tmp_store();
        let bootloader: Arc<dyn BootloaderHandle> =
            Arc::new(NoopBootloaderHandle);

        let outcome = perform_confirm_slot(
            &store,
            &bootloader,
            ConfirmSlotSelector::Explicit(AbPartition::A),
        );
        assert!(matches!(outcome, ConfirmOutcome::ApplyRollRejected(_)));
    }

    #[test]
    fn perform_confirm_slot_explicit_slot_selects_b() {
        // Install + confirm A, swap to B to put slot B in
        // PendingConfirm, then explicit-B confirm.
        let store = tmp_store();
        store
            .apply_roll(
                PartitionRoll::InitialInstall { target: AbPartition::A },
                3600,
            )
            .expect("install");
        store
            .apply_roll(PartitionRoll::Confirm { slot: AbPartition::A }, 3600)
            .expect("confirm A");
        store
            .apply_roll(
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                3600,
            )
            .expect("swap");
        let bootloader: Arc<dyn BootloaderHandle> =
            Arc::new(NoopBootloaderHandle);

        let outcome = perform_confirm_slot(
            &store,
            &bootloader,
            ConfirmSlotSelector::Explicit(AbPartition::B),
        );
        match outcome {
            ConfirmOutcome::Ok {
                confirmed_slot,
                new_state,
                ..
            } => {
                assert_eq!(confirmed_slot, AbPartition::B);
                assert_eq!(new_state.active, AbPartition::B);
                assert_eq!(new_state.slot_b_state, SlotState::Active);
            }
            other => panic!("expected Ok, got {:?}", other),
        }
    }
}
