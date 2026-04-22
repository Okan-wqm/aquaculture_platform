//! `cmd_confirm_slot` — operator-driven PartitionRoll::
//! Confirm transition (Batch 109 Sprint 6.5 orchestration;
//! Batch 122 thin-wrapper refactor over confirm_orchestrator).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 6 + ADR-019 §6 specify the post-
//! boot-confirmation step of the A/B firmware update
//! lifecycle: after the new firmware boots + passes N-
//! second health check, the PendingConfirm slot must
//! transition to Active. Without this step, the cold-boot-
//! budget watchdog (Batch 107) will fire Rollback when the
//! deadline expires — even if the new firmware is
//! perfectly healthy.
//!
//! ## Post-Batch-122 layering
//!
//! The command body is now a thin adapter that converts
//! MQTT params → `ConfirmSlotSelector` + calls
//! `updater::perform_confirm_slot` + maps the returned
//! `ConfirmOutcome` into the `(success, result, error)`
//! tuple the MQTT dispatch expects. The actual Confirm
//! orchestration (apply_roll + bootloader coord + audit-
//! relevant bookkeeping) lives in
//! `updater::confirm_orchestrator` so the HTTP lifecycle
//! endpoint (Batch 122) runs the SAME logic without
//! duplicating validation or bootloader-split-brain
//! handling.
//!
//! ## Authorization
//!
//! Gated by `Permission::UpdateFirmware` via
//! `required_permission`. Master-key rotation
//! (Permission::ManagePolicy) is STRICTER than firmware
//! lifecycle; confirm just advances the A/B slot state
//! machine. Firmware-update ops (deploy + rollback +
//! confirm) share the gate.

use serde_json::{Value, json};

use super::CommandHandler;
use crate::security::sanitize_for_log;
use crate::updater::{
    parse_slot_param, perform_confirm_slot, AbPartition, ConfirmOutcome,
};

impl CommandHandler {
    /// `confirm_slot` — mark a PendingConfirm slot as Active.
    ///
    /// Params (one of):
    /// - `slot: "a" | "b"` — explicit slot identifier.
    /// - (no param) → defaults to the CURRENT active slot
    ///   per PartitionStore snapshot (matches
    ///   post-boot-self-confirm semantic).
    ///
    /// Returns on success:
    ///   {
    ///     "confirmed_slot": "a" | "b",
    ///     "new_state": { ... PartitionState ... },
    ///     "bootloader_coordination": {
    ///       "backend": "...",
    ///       "cleared_pending_boot": bool
    ///     }
    ///   }
    pub(super) async fn cmd_confirm_slot(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let (partition_store, bootloader) = {
            let state = self.state.read().await;
            (state.partition_store.clone(), state.bootloader.clone())
        };

        let partition_store = match partition_store {
            Some(s) => s,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "confirm_slot rejected: partition_store not initialized. \
                         This indicates a boot-time init failure — see agent logs."
                            .to_string(),
                    ),
                );
            }
        };

        let raw_slot = params.get("slot").and_then(|v| v.as_str());
        let selector = match parse_slot_param(raw_slot) {
            Some(s) => s,
            None => {
                // raw_slot is Some(_) here because parse
                // returned None → invalid-slot-input path.
                // None input produces ActiveFromSnapshot, not
                // None output.
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "confirm_slot: invalid 'slot' param {:?}; expected 'a' or 'b'",
                        sanitize_for_log(raw_slot.unwrap_or(""))
                    )),
                );
            }
        };

        match perform_confirm_slot(&partition_store, &bootloader, selector) {
            ConfirmOutcome::Ok {
                confirmed_slot,
                new_state,
                bootloader_backend,
                bootloader_ok,
                bootloader_err: _,
            } => {
                let slot_str = match confirmed_slot {
                    AbPartition::A => "a",
                    AbPartition::B => "b",
                };
                (
                    true,
                    json!({
                        "confirmed_slot": slot_str,
                        "new_state": new_state,
                        "bootloader_coordination": {
                            "backend": bootloader_backend,
                            "cleared_pending_boot": bootloader_ok,
                        },
                    }),
                    None,
                )
            }
            ConfirmOutcome::SnapshotFailed(e) => (
                false,
                json!(null),
                Some(format!("confirm_slot: snapshot failed: {}", e)),
            ),
            ConfirmOutcome::ApplyRollRejected(e) => (
                false,
                json!({ "reason": e.clone() }),
                Some(format!("Partition confirm failed: {}", e)),
            ),
            ConfirmOutcome::InvalidSlotParam(raw) => (
                false,
                json!(null),
                Some(format!(
                    "confirm_slot: invalid slot parameter {:?}; expected 'a' or 'b'",
                    sanitize_for_log(&raw)
                )),
            ),
        }
    }
}
