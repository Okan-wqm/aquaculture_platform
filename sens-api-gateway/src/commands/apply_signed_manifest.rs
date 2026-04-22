//! `cmd_apply_signed_manifest` — orchestrator for the
//! SignedFirmwareManifest deploy pipeline (Batch 116 Sprint
//! 6.5 Phase 2).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 6 + ADR-019 §2 specify the A/B
//! firmware update lifecycle. Batch 115 landed the verify-
//! preview primitive (`cmd_verify_signed_manifest`); this
//! batch lands the APPLY orchestrator that converts a
//! verified manifest into an actual partition-state
//! transition paired with bootloader coordination.
//!
//! ## Orchestration steps (software-only scope)
//!
//! 1. Pull required AppState slices under a single read-
//!    guard: pubkey, tenant, partition_store, bootloader,
//!    mode, current snapshot.
//! 2. Mode-gate: Disabled mode rejects (no trusted pubkey).
//! 3. Parse `manifest` param → SignedFirmwareManifest.
//! 4. Run the Batch 8 `verify_firmware_manifest` (8-gate
//!    fail-closed) with the cached VerifyingKey.
//! 5. Determine transition + target slot from the current
//!    snapshot:
//!    - Both slots Empty → `InitialInstall { target = active }`.
//!    - Active slot in Active state → `SwapToPending`
//!      (target = active.other()).
//!    - Any other state (PendingConfirm already open,
//!      Empty-active, etc.) → reject with structured error.
//! 6. Apply transition atomically with version bump via
//!    `apply_roll_with_version_bump(roll, budget,
//!    manifest.firmware_version)`. This closes the Batch
//!    115 observation #1 monotonic-floor gap:
//!    `active_firmware_version` now advances in the SAME
//!    disk-persisted operation as the state change.
//! 7. Call `BootloaderHandle::set_next_boot_slot(target)`
//!    — Noop backend is a zero-cost log on non-RPi; Tryboot
//!    backend flips /boot/tryboot.cfg. Same split-brain
//!    discipline as Batch 112: log + surface in response
//!    JSON + do NOT revert software state on bootloader
//!    failure (the apply is committed; operator resync via
//!    --confirm-active or recovery boot).
//!
//! ## Tracked for later batches (plan §5 Faz 2 item 6 continuation)
//!
//! - File streaming / download to standby partition —
//!   needs real A/B mount paths in config + hardware.
//!   Lands with the Tryboot real-RPi impl batch.
//! - TOCTOU re-verify (hash-after-fsync-before-rename):
//!   downstream of file-streaming.
//! - Per-file SHA-256 recompute: Batch 8 doc says this
//!   runs AFTER files land on standby.
//!
//! Until the hardware-layer batch lands, this orchestrator
//! is the software-layer truth for "the new manifest is
//! installed-as-pending + waiting for reboot-into-new-
//! slot". Operator physically reboots via external means
//! (ssh reboot, out-of-band trigger) to exercise the
//! cold-boot watchdog path.
//!
//! ## Authorization
//!
//! Gated by `Permission::UpdateFirmware` via
//! required_permission — same class as cmd_update_firmware
//! (legacy tarball), cmd_confirm_slot (Batch 109),
//! cmd_verify_signed_manifest (Batch 115).

use serde_json::{Value, json};
use std::time::SystemTime;
use tracing::{info, warn};

use super::CommandHandler;
use crate::authz::permission::TenantId;
use crate::security::sanitize_for_log;
use crate::updater::{
    AbPartition, BootloaderHandle, PartitionRoll, PartitionState, PartitionStore,
    SignedFirmwareManifest, SlotState,
};

impl CommandHandler {
    /// `apply_signed_manifest` — verify + apply_roll + bootloader coord.
    ///
    /// Params:
    /// - `manifest`: SignedFirmwareManifest JSON body (required).
    ///
    /// Returns on success:
    ///   {
    ///     "verified": true,
    ///     "applied_transition": "InitialInstall" | "SwapToPending",
    ///     "target_slot": "a" | "b",
    ///     "new_state": { ... PartitionState ... },
    ///     "bootloader_coordination": {
    ///       "backend": "noop" | "tryboot",
    ///       "set_next_boot_slot_ok": bool
    ///     }
    ///   }
    ///
    /// On verify failure: pass-through from
    /// cmd_verify_signed_manifest's structured gate labels.
    /// On apply failure: `apply_error` field with the
    /// PartitionStore error + the new_state is UNCHANGED.
    pub(super) async fn cmd_apply_signed_manifest(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing apply_signed_manifest command (Sprint 6.5 Phase 2)");

        // 1. Snapshot AppState slices under single read-guard.
        let (pubkey, tenant_str, mode, partition_store, bootloader) = {
            let state = self.state.read().await;
            (
                state.firmware_signing_pubkey.clone(),
                state.tenant_id.clone(),
                state.config.firmware_update.mode,
                state.partition_store.clone(),
                state.bootloader.clone(),
            )
        };

        // 2. Mode-gate + partition-store presence.
        let pubkey = match pubkey {
            Some(k) => k,
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "mode_disabled",
                        "mode": format!("{:?}", mode),
                    }),
                    Some(format!(
                        "apply_signed_manifest rejected: firmware_update.mode={:?} — pubkey not wired. \
                         Set mode=permissive|enforcing + signing_pubkey_hex.",
                        mode
                    )),
                );
            }
        };

        let partition_store = match partition_store {
            Some(s) => s,
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "partition_store_absent",
                    }),
                    Some(
                        "apply_signed_manifest rejected: partition_store not initialized. \
                         Boot-time init failure — see agent logs."
                            .to_string(),
                    ),
                );
            }
        };

        // 3. Parse + verify the manifest.
        let expected_tenant = match tenant_str {
            Some(t) => match uuid::Uuid::parse_str(&t) {
                Ok(u) => TenantId::new_from_verified(*u.as_bytes()),
                Err(e) => {
                    return (
                        false,
                        json!({
                            "verified": false,
                            "gate": "tenant_parse_failed",
                            "reason": sanitize_for_log(&e.to_string()),
                        }),
                        Some(format!(
                            "apply_signed_manifest: tenant_id on AppState is not a valid UUID: {}",
                            sanitize_for_log(&e.to_string())
                        )),
                    );
                }
            },
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "device_not_activated",
                    }),
                    Some(
                        "apply_signed_manifest rejected: device not activated (tenant_id is None)".to_string(),
                    ),
                );
            }
        };

        let manifest_value = match params.get("manifest") {
            Some(v) => v.clone(),
            None => {
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "missing_param",
                        "param": "manifest",
                    }),
                    Some(
                        "apply_signed_manifest rejected: missing required 'manifest' parameter".to_string(),
                    ),
                );
            }
        };

        let signed: SignedFirmwareManifest = match serde_json::from_value(manifest_value) {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    "apply_signed_manifest: manifest parse failed: {}",
                    sanitize_for_log(&e.to_string())
                );
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": "manifest_parse_failed",
                        "reason": sanitize_for_log(&e.to_string()),
                    }),
                    Some(format!(
                        "apply_signed_manifest rejected: manifest JSON parse failed: {}",
                        sanitize_for_log(&e.to_string())
                    )),
                );
            }
        };

        let snapshot = match partition_store.snapshot() {
            Ok(s) => s,
            Err(e) => {
                return (
                    false,
                    json!({
                        "gate": "snapshot_failed",
                        "reason": e.to_string(),
                    }),
                    Some(format!(
                        "apply_signed_manifest: partition snapshot failed: {}",
                        e
                    )),
                );
            }
        };
        let highest_seen = snapshot.active_firmware_version;

        let now = SystemTime::now();
        let manifest = match crate::updater::verify_firmware_manifest(
            &signed,
            &expected_tenant,
            highest_seen,
            now,
            |canonical, sig_bytes| {
                let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
                pubkey.verify_strict(canonical, &sig).is_ok()
            },
        ) {
            Ok(m) => m,
            Err(e) => {
                warn!("apply_signed_manifest VERIFY REJECTED: {:?}", e);
                return (
                    false,
                    json!({
                        "verified": false,
                        "gate": gate_label_for_err(&e),
                        "reason": e.to_string(),
                        "highest_seen_firmware_version": highest_seen,
                        "mode": format!("{:?}", mode),
                    }),
                    Some(format!("apply_signed_manifest rejected: {}", e)),
                );
            }
        };

        // 4. Determine transition + target slot from current
        //    snapshot. Pure function (no AppState read) —
        //    tested in unit tests below.
        let (roll, target_slot, transition_label) = match plan_transition(&snapshot) {
            Ok(plan) => plan,
            Err(reason) => {
                return (
                    false,
                    json!({
                        "verified": true,
                        "applied": false,
                        "gate": "invalid_initial_state",
                        "reason": reason,
                        "current_state": snapshot,
                    }),
                    Some(format!(
                        "apply_signed_manifest: current partition state does not permit apply: {}",
                        reason
                    )),
                );
            }
        };

        // 5. Apply transition atomically with version bump.
        let cold_boot_budget_secs =
            crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;

        let new_state = match partition_store.apply_roll_with_version_bump(
            roll,
            cold_boot_budget_secs,
            manifest.firmware_version,
        ) {
            Ok(s) => s,
            Err(e) => {
                warn!(
                    "apply_signed_manifest APPLY REJECTED: {}",
                    sanitize_for_log(&e.to_string())
                );
                return (
                    false,
                    json!({
                        "verified": true,
                        "applied": false,
                        "apply_error": e.to_string(),
                        "transition_attempted": transition_label,
                    }),
                    Some(format!("apply_signed_manifest apply_roll failed: {}", e)),
                );
            }
        };

        info!(
            "apply_signed_manifest APPLIED: transition={} target_slot={:?} version {}->{} new_state={:?}",
            transition_label,
            target_slot,
            highest_seen,
            manifest.firmware_version,
            new_state
        );

        // 6. Bootloader coordination — set next boot to
        //    target. Noop is zero-cost log; Tryboot flips
        //    /boot/tryboot.cfg. Same split-brain discipline
        //    as Batch 112 cmd_confirm_slot: log + surface;
        //    do NOT revert software state on failure.
        let (bootloader_ok, bootloader_err) =
            call_set_next_boot_slot(bootloader.as_ref(), target_slot);

        let slot_str = match target_slot {
            AbPartition::A => "a",
            AbPartition::B => "b",
        };

        (
            true,
            json!({
                "verified": true,
                "applied": true,
                "applied_transition": transition_label,
                "target_slot": slot_str,
                "firmware_version": manifest.firmware_version,
                "previous_firmware_version": highest_seen,
                "release_tag": manifest.release_tag,
                "file_count": manifest.files.len(),
                "new_state": new_state,
                "bootloader_coordination": {
                    "backend": bootloader.backend_name(),
                    "set_next_boot_slot_ok": bootloader_ok,
                    "error": bootloader_err,
                },
            }),
            None,
        )
    }
}

/// Determine the transition + target slot for the given
/// snapshot. Pure function — no AppState; testable without
/// fixtures.
///
/// Returns (PartitionRoll, target_slot, label_for_response).
/// Err(reason) when the snapshot state is NOT one the
/// orchestrator accepts — e.g. an already-open PendingConfirm
/// window MUST be resolved (via cmd_confirm_slot or the
/// watchdog Rollback) before a new apply runs.
pub(super) fn plan_transition(
    snapshot: &PartitionState,
) -> Result<(PartitionRoll, AbPartition, &'static str), String> {
    match (snapshot.slot_a_state, snapshot.slot_b_state) {
        // Both Empty — first-ever install path. Target the
        // configured initial-active slot (A by convention
        // per PartitionState::initial).
        (SlotState::Empty, SlotState::Empty) => {
            let target = snapshot.active;
            Ok((
                PartitionRoll::InitialInstall { target },
                target,
                "InitialInstall",
            ))
        }

        // One Active + one Empty/Standby — swap to the
        // other slot as new_pending.
        (SlotState::Active, SlotState::Empty)
        | (SlotState::Active, SlotState::Standby) => {
            if snapshot.active != AbPartition::A {
                return Err(format!(
                    "snapshot inconsistent: slot_a=Active but snapshot.active={:?}",
                    snapshot.active
                ));
            }
            Ok((
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::A,
                    new_pending: AbPartition::B,
                },
                AbPartition::B,
                "SwapToPending",
            ))
        }
        (SlotState::Empty, SlotState::Active)
        | (SlotState::Standby, SlotState::Active) => {
            if snapshot.active != AbPartition::B {
                return Err(format!(
                    "snapshot inconsistent: slot_b=Active but snapshot.active={:?}",
                    snapshot.active
                ));
            }
            Ok((
                PartitionRoll::SwapToPending {
                    old_active: AbPartition::B,
                    new_pending: AbPartition::A,
                },
                AbPartition::A,
                "SwapToPending",
            ))
        }

        // Any other combination — PendingConfirm is open,
        // both PendingConfirm (bug), both Standby (bug),
        // etc. Operator must close the window first.
        (a, b) => Err(format!(
            "partition state does not permit new apply: slot_a={:?} slot_b={:?} active={:?}. \
             Close any open PendingConfirm window via cmd_confirm_slot or wait for the \
             cold-boot watchdog to fire Rollback.",
            a, b, snapshot.active
        )),
    }
}

/// Call BootloaderHandle::set_next_boot_slot; return (ok,
/// error_string). Separated from the command body so the
/// happy-path flow is readable + the failure-log discipline
/// is centralized.
fn call_set_next_boot_slot(
    bootloader: &dyn BootloaderHandle,
    target: AbPartition,
) -> (bool, Option<String>) {
    match bootloader.set_next_boot_slot(target) {
        Ok(()) => {
            info!(
                "apply_signed_manifest: bootloader set_next_boot_slot({:?}) OK (backend={})",
                target,
                bootloader.backend_name()
            );
            (true, None)
        }
        Err(e) => {
            warn!(
                "apply_signed_manifest: software apply OK, bootloader set_next_boot_slot({:?}) FAILED: {} (backend={}) — SPLIT-BRAIN: operator must resync via --confirm-active or recovery boot",
                target,
                e,
                bootloader.backend_name()
            );
            (false, Some(e.to_string()))
        }
    }
}

/// Map ManifestVerifyError variants to stable string labels
/// suitable for the audit detail + response JSON. Kept in
/// sync with the Batch 115 `gate_label_for_err` function —
/// the same stability contract applies to both commands
/// (operator UIs rely on the identifiers being consistent
/// between verify-preview + apply paths).
fn gate_label_for_err(e: &crate::updater::ManifestVerifyError) -> &'static str {
    use crate::updater::ManifestVerifyError as M;
    match e {
        M::TargetArchMismatch => "target_arch_mismatch",
        M::InvalidValidityWindow { .. } => "invalid_validity_window",
        M::InvalidNow => "invalid_now",
        M::TenantMismatch => "tenant_mismatch",
        M::StaleFirmwareVersion { .. } => "stale_firmware_version",
        M::NotYetValid { .. } => "not_yet_valid",
        M::Expired { .. } => "expired",
        M::CanonicalBytesFailure(_) => "canonical_bytes_failure",
        M::InvalidSignature => "invalid_signature",
        M::FileDigestMismatch { .. } => "file_digest_mismatch",
        M::FileSizeMismatch { .. } => "file_size_mismatch",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::{PartitionState, SlotState};

    fn snap(
        active: AbPartition,
        slot_a: SlotState,
        slot_b: SlotState,
        version: u64,
    ) -> PartitionState {
        PartitionState {
            active,
            slot_a_state: slot_a,
            slot_b_state: slot_b,
            pending_confirm_deadline_unix_secs: None,
            active_firmware_version: version,
        }
    }

    #[test]
    fn plan_transition_both_empty_uses_initial_install() {
        let s = snap(AbPartition::A, SlotState::Empty, SlotState::Empty, 0);
        let (roll, target, label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::InitialInstall {
                target: AbPartition::A
            }
        ));
        assert_eq!(target, AbPartition::A);
        assert_eq!(label, "InitialInstall");
    }

    #[test]
    fn plan_transition_a_active_b_empty_swaps_to_b() {
        let s = snap(AbPartition::A, SlotState::Active, SlotState::Empty, 5);
        let (roll, target, label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::SwapToPending {
                old_active: AbPartition::A,
                new_pending: AbPartition::B
            }
        ));
        assert_eq!(target, AbPartition::B);
        assert_eq!(label, "SwapToPending");
    }

    #[test]
    fn plan_transition_a_active_b_standby_swaps_to_b() {
        // Post-confirm-rollback-retry scenario: slot A is
        // Active + slot B retains Standby from the prior
        // cycle. Orchestrator reuses B for the new deploy.
        let s = snap(AbPartition::A, SlotState::Active, SlotState::Standby, 5);
        let (roll, target, _label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::SwapToPending {
                old_active: AbPartition::A,
                new_pending: AbPartition::B
            }
        ));
        assert_eq!(target, AbPartition::B);
    }

    #[test]
    fn plan_transition_b_active_a_empty_swaps_to_a() {
        let s = snap(AbPartition::B, SlotState::Empty, SlotState::Active, 5);
        let (roll, target, _label) = plan_transition(&s).expect("plan");
        assert!(matches!(
            roll,
            PartitionRoll::SwapToPending {
                old_active: AbPartition::B,
                new_pending: AbPartition::A
            }
        ));
        assert_eq!(target, AbPartition::A);
    }

    #[test]
    fn plan_transition_rejects_pending_confirm_open() {
        // Slot B is in PendingConfirm — cannot start a new
        // deploy until that window closes.
        let s = snap(
            AbPartition::B,
            SlotState::Standby,
            SlotState::PendingConfirm,
            5,
        );
        let err = plan_transition(&s).expect_err("reject");
        assert!(err.contains("slot_b=PendingConfirm"));
    }

    #[test]
    fn plan_transition_rejects_both_pending_confirm() {
        // Impossible-in-normal-flow but defensive — reject
        // any non-clean starting state.
        let s = snap(
            AbPartition::A,
            SlotState::PendingConfirm,
            SlotState::PendingConfirm,
            5,
        );
        let err = plan_transition(&s).expect_err("reject");
        assert!(err.contains("PendingConfirm"));
    }

    #[test]
    fn plan_transition_rejects_inconsistent_active_flag() {
        // slot_a says Active but snapshot.active says B —
        // corruption signal; orchestrator refuses.
        let s = snap(AbPartition::B, SlotState::Active, SlotState::Empty, 5);
        let err = plan_transition(&s).expect_err("reject");
        assert!(err.contains("inconsistent"));
    }

    #[test]
    fn gate_label_pins_stable_identifiers() {
        use crate::updater::ManifestVerifyError as M;
        // Mirrors Batch 115's test — if either command's
        // label drifts, both tests drift together +
        // surface the contract break loudly.
        assert_eq!(
            gate_label_for_err(&M::TargetArchMismatch),
            "target_arch_mismatch"
        );
        assert_eq!(
            gate_label_for_err(&M::InvalidSignature),
            "invalid_signature"
        );
        assert_eq!(
            gate_label_for_err(&M::StaleFirmwareVersion {
                claimed: 1,
                highest_seen: 2
            }),
            "stale_firmware_version"
        );
    }
}

// Suppress unused warning for the imports the test module
// does not need; the `use` statements at module top are
// required by the non-test code paths.
#[cfg(not(test))]
#[allow(dead_code)]
fn _keep_imports_used(store: &PartitionStore) {
    let _ = store;
}
