//! `cmd_confirm_slot` — operator-driven PartitionRoll::
//! Confirm transition (Batch 109 Sprint 6.5 orchestration).
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
//! Three invocation paths land in the full Sprint 6.5:
//! 1. **MQTT `confirm_slot` command** (this batch): operator
//!    or cloud-side health-check service invokes via an
//!    envelope-signed command. Immediate confirmation.
//! 2. **systemd post-boot-confirm unit** (Batch 110): local
//!    systemd timer runs `suderra-agent --confirm-active`
//!    after N seconds of the new firmware running. Avoids
//!    requiring MQTT connectivity for confirmation.
//! 3. **Agent-self-health-check** — Phase 2 design batch
//!    schedules this path. The agent itself calls the same
//!    confirm path after its own internal health checks
//!    pass. Requires careful design — running agent
//!    confirming its own firmware has circular-trust
//!    implications (a compromised firmware could self-
//!    confirm). Phase 2 review decides whether to land
//!    this path at all or keep operator/systemd as the
//!    only confirm sources.
//!
//! ## Authorization
//!
//! Gated by `Permission::UpdateFirmware` via
//! required_permission. Master-key rotation
//! (Permission::ManagePolicy) is STRICTER than firmware
//! lifecycle — rotating master affects every key; confirm
//! just advances a slot state machine. Firmware-update
//! ops (deploy + rollback + confirm) share the gate.

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::security::sanitize_for_log;
use crate::updater::{AbPartition, PartitionRoll};

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
    ///     "new_state": { ... PartitionState ... }
    ///   }
    pub(super) async fn cmd_confirm_slot(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing confirm_slot command (Sprint 6.5 Phase 2)");

        let partition_store = {
            let state = self.state.read().await;
            state.partition_store.clone()
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

        // Resolve target slot: explicit param → parse;
        // absent → use current snapshot.active.
        let slot = match params.get("slot").and_then(|v| v.as_str()) {
            Some("a") | Some("A") => AbPartition::A,
            Some("b") | Some("B") => AbPartition::B,
            Some(other) => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "confirm_slot: invalid 'slot' param {:?}; expected 'a' or 'b'",
                        sanitize_for_log(other)
                    )),
                );
            }
            None => {
                // Default to the active slot. This matches
                // the common "post-boot self-confirm" flow:
                // the active slot IS the PendingConfirm one
                // right after a SwapToPending, and the
                // newly-booted agent confirms itself.
                match partition_store.snapshot() {
                    Ok(s) => s.active,
                    Err(e) => {
                        return (
                            false,
                            json!(null),
                            Some(format!(
                                "confirm_slot: snapshot failed: {}",
                                e
                            )),
                        );
                    }
                }
            }
        };

        let cold_boot_budget_secs =
            crate::updater::partition::DEFAULT_COLD_BOOT_BUDGET_SECS;

        match partition_store.apply_roll(
            PartitionRoll::Confirm { slot },
            cold_boot_budget_secs,
        ) {
            Ok(new_state) => {
                info!(
                    "confirm_slot SUCCESS: slot={:?} new_state={:?}",
                    slot, new_state
                );
                let slot_str = match slot {
                    AbPartition::A => "a",
                    AbPartition::B => "b",
                };
                (
                    true,
                    json!({
                        "confirmed_slot": slot_str,
                        "new_state": new_state,
                    }),
                    None,
                )
            }
            Err(e) => {
                warn!(
                    "confirm_slot REJECTED: slot={:?} err={}",
                    slot,
                    sanitize_for_log(&e.to_string())
                );
                (
                    false,
                    json!({
                        "reason": e.to_string(),
                    }),
                    Some(format!("Partition confirm failed: {}", e)),
                )
            }
        }
    }
}
