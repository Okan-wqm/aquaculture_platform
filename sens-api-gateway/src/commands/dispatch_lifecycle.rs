//! Per-command execute_command lifecycle for CommandHandler.
//!
//! ## Why this module exists (Batch #296 ULTRA-HIGH-013 closure)
//!
//! Pre-Batch-#296 the `execute_command` body lived inline in
//! `commands/mod.rs`, contributing ~345 lines to a 1279-line file
//! that violated the ULTRA-HIGH-013 ≤500-line ceiling. The body
//! orchestrates the per-command pipeline:
//!
//!   1. Start time + log entry.
//!   2. Shutdown-race gate (Batch #258 C-7) — reject inflight
//!      commands when `state.is_shutting_down` flipped.
//!   3. Snapshot `device_id` / `audit_sink` / `tenant_bytes` for
//!      the pre+post audit emit pair (single state-read).
//!   4. Pre-exec audit emit (Batch 79).
//!   5. Required-permission compute + safety-critical preview
//!      (Batch 33+35) + two-person-integrity preview (Batch 37).
//!   6. The dispatch table (`match command.command.as_str()`) —
//!      54+ command-name → handler arm. SSoT for command-name
//!      bindings; intentionally inline here (not extracted)
//!      because splitting it would lose the at-a-glance overview
//!      of what commands the agent serves.
//!   7. Completion logging (success / failure paths).
//!   8. Post-exec audit emit + `summarize_result` enrichment
//!      (Batch 79 + Batch 118).
//!   9. CommandResponse construction.
//!
//! ## Visibility
//!
//! `execute_command` is `pub(super)` (called by `handle_message`
//! in `mqtt_dispatch.rs` — same `commands::` tree); not exposed
//! externally because the call site assumes the upstream MQTT
//! pipeline already ran retain/replay/dedup gates.

use chrono::Utc;
use serde_json::json;
use tracing::{debug, info, warn};

use crate::mqtt::{CommandMessage, CommandResponse};
use crate::security::sanitize_for_log;

use super::{audit_emit, required_permission};

impl super::CommandHandler {
    /// Execute one fully-vetted `CommandMessage` (already passed
    /// MQTT-side gates: retained reject, parse, replay window,
    /// dedup) and return the serializable [`CommandResponse`] the
    /// MQTT publisher will send.
    pub(super) async fn execute_command(&mut self, command: &CommandMessage) -> CommandResponse {
        // v1.2.6: Track command execution time for observability
        let start_time = std::time::Instant::now();
        info!(
            "⚡ Command received: id='{}', command='{}', has_params={}",
            command.command_id,
            sanitize_for_log(&command.command),
            !command.params.is_null()
        );

        // Batch #258 C-7 fix — shutdown race gate.
        //
        // The agent's shutdown sequence flips
        // `state.is_shutting_down` to true BEFORE applying safe-
        // state + disconnecting MQTT. A command that arrives
        // AFTER the flag flip but BEFORE MQTT disconnect would
        // otherwise race the safe-state transition (e.g., a
        // WriteTag handler firing concurrent to the actuator-
        // class fail-safe rollback). Reject every such inflight
        // command with a structured ServiceShuttingDown response;
        // the cloud-side request-response loop will surface the
        // explicit gate rather than appear to time out.
        let is_shutting_down = {
            let state = self.state.read().await;
            state
                .is_shutting_down
                .load(std::sync::atomic::Ordering::Acquire)
        };
        if is_shutting_down {
            warn!(
                "Command '{}' rejected: agent is shutting down (id='{}')",
                sanitize_for_log(&command.command),
                command.command_id
            );
            return CommandResponse {
                command_id: command.command_id.clone(),
                device_id: {
                    let state = self.state.read().await;
                    state.config.device_id.clone()
                },
                success: false,
                result: serde_json::json!({
                    "rejected": "service_shutting_down"
                }),
                timestamp: chrono::Utc::now().to_rfc3339(),
                error: Some(
                    "Agent is shutting down — command rejected to avoid \
                     racing the safe-state transition. Retry after the \
                     agent has restarted."
                        .to_string(),
                ),
            };
        }

        // Batch 79 Sprint 6.2 Phase 2: snapshot the
        // device_id, audit sink Arc, and tenant bytes under
        // the read-guard so pre+post audit emit can run
        // without re-acquiring the state lock.
        let (device_id, audit_sink, tenant_bytes) = {
            let state = self.state.read().await;
            let tid = state
                .tenant_id
                .as_deref()
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
                .map(|u| *u.as_bytes())
                .unwrap_or([0u8; 16]);
            (
                state.config.device_id.clone(),
                state.audit_sink.clone(),
                tid,
            )
        };
        let tenant = crate::authz::permission::TenantId::new_from_verified(tenant_bytes);

        // Batch 79: emit PRE-exec audit event. No-op when
        // audit_sink is None (audit.mode=Disabled).
        audit_emit::emit_pre_event(
            audit_sink.as_ref(),
            &command.command,
            &command.command_id,
            &device_id,
            tenant,
        );

        // Batch 33+35 Sprint 6.1 partial: compute required-
        // permission ONCE and reuse for:
        //   (a) the IEC 62443 SL-2 safety-critical audit log
        //       (was a hardcoded command-name list; now derived
        //       from the canonical Permission::is_mutating()
        //       classifier — eliminates the 3rd parallel
        //       commands list after MUTATING_COMMANDS +
        //       required_permission_for_command).
        //   (b) the RBAC-gate-preview debug log.
        //
        // Pre-Batch-35 is_safety_critical was a bespoke match
        // that drifted from the Permission enum — a new
        // mutating command could be added to the enum without
        // being added to the audit list, silently suppressing
        // audit emission. Batch 35 ties both to the same SSoT.
        let required_perm =
            required_permission::permission_for_command(&command.command, &command.params);
        let is_safety_critical = required_perm
            .as_ref()
            .map(|p| p.is_mutating())
            .unwrap_or(false);
        if is_safety_critical {
            warn!(
                "AUDIT: Safety-critical command initiated: command='{}', id='{}', device_id='{}', timestamp='{}', required_permission={:?}",
                sanitize_for_log(&command.command),
                command.command_id,
                device_id,
                Utc::now().to_rfc3339(),
                required_perm
            );
        }

        // RBAC-gate-preview log (Sprint 6.4 gate activates here).
        debug!(
            "RBAC-gate-preview: command='{}' required_permission={:?} is_safety_critical={} (gate activates Sprint 6.4)",
            sanitize_for_log(&command.command),
            required_perm,
            is_safety_critical
        );

        // **Batch #307 Faz 6 two-person integrity gate.**
        // ADR-017 §8 mandates a SECOND signature (co-approval)
        // for the `UpdateFirmware / DeployProgram / ForceValue
        // / SafeStateTrigger / Reboot` subset. The gate enforces
        // here at the dispatch layer (centralized SSoT — all
        // mandatory commands flow through this same check).
        //
        // Pre-Batch-#307 the block was a warn-log preview only;
        // Batches #305 (CommandEnvelope v3 wire fields) + #306
        // (envelope_adapter co-approver verify) landed the
        // primitives + adapter; this batch flips the gate from
        // PREVIEW to ENFORCING.
        //
        // Trust chain (all 3 layers must agree before the
        // command reaches its handler):
        //
        //   1. Wire format carries co_approver_actor +
        //      co_approver_signature (Batch #305).
        //   2. envelope_adapter::verify_co_approver_if_present
        //      verifies the co-approver signature against the
        //      same canonical bytes as primary (Batch #306).
        //      Sets AdaptedCommand.verified_co_approver = true
        //      on success.
        //   3. handle_message projects the flag to
        //      CommandMessage.verified_co_approver.
        //   4. THIS GATE rejects when the command's
        //      Permission::requires_two_person_integrity()
        //      returns true AND verified_co_approver is false.
        //
        // Rejected commands STILL get the post-exec audit
        // emission below (rejection counts as a completion
        // outcome — silent denies hide policy probes from the
        // SIEM). The audit-detail surfaces 'two_person_integrity_required'
        // as the reason.
        let requires_two_person = required_perm
            .as_ref()
            .map(|p| p.requires_two_person_integrity())
            .unwrap_or(false);
        if requires_two_person && !command.verified_co_approver {
            warn!(
                "TWO-PERSON-INTEGRITY rejected: command='{}' requires co-approval per ADR-017 §8; envelope carried no verified co-approver signature. id='{}'",
                sanitize_for_log(&command.command),
                command.command_id,
            );
            // Build the same response shape as the unknown-
            // command + shutdown-race rejects so audit paths
            // see a uniform structure. The post-exec audit
            // emission below fires with the rejection details.
            let elapsed = start_time.elapsed();
            audit_emit::emit_post_event(
                audit_sink.as_ref(),
                &command.command,
                &command.command_id,
                &device_id,
                tenant,
                crate::audit::AuditOutcome::Failure,
                &format!(
                    "elapsed_ms={} err=two_person_integrity_required",
                    elapsed.as_millis()
                ),
            );
            return CommandResponse {
                command_id: command.command_id.clone(),
                device_id,
                success: false,
                result: serde_json::json!({
                    "rejected": "two_person_integrity_required",
                    "required_permission": format!("{:?}", required_perm),
                }),
                timestamp: Utc::now().to_rfc3339(),
                error: Some(
                    "Command requires two-person integrity per ADR-017 §8 — \
                     envelope MUST carry a verified co-approver signature \
                     (co_approver_actor + co_approver_signature). The \
                     primary operator + a second operator with the \
                     ForceValueCoApprove-class permission must BOTH sign \
                     the same canonical bytes for the command to dispatch."
                        .to_string(),
                ),
            };
        } else if requires_two_person {
            // Co-approver verified — log at info level for
            // operator-visible audit trail of mandatory
            // commands that DID get the second signature.
            info!(
                "TWO-PERSON-INTEGRITY accepted: command='{}' verified co-approval id='{}'",
                sanitize_for_log(&command.command),
                command.command_id,
            );
        }

        let (success, result, error) = match command.command.as_str() {
            "ping" => self.cmd_ping().await,
            "get_info" => self.cmd_get_info().await,
            "get_config" => self.cmd_get_config().await,
            "get_hardware" => self.cmd_get_hardware().await,
            "scan_hardware" => self.cmd_scan_hardware().await,
            "read_modbus" => self.cmd_read_modbus(&command.params).await,
            "write_modbus" => self.cmd_write_modbus(&command.params).await,
            "read_gpio" => self.cmd_read_gpio().await,
            "write_gpio" => self.cmd_write_gpio(&command.params).await,
            // Script commands
            "list_scripts" => self.cmd_list_scripts().await,
            "get_script" => self.cmd_get_script(&command.params).await,
            "deploy_script" => self.cmd_deploy_script(&command.params).await,
            "delete_script" => self.cmd_delete_script(&command.params).await,
            "enable_script" => self.cmd_enable_script(&command.params).await,
            "disable_script" => self.cmd_disable_script(&command.params).await,
            // IEC 61131-3 Program commands (v2.1)
            "deploy_program" => self.cmd_deploy_program(&command.params).await,
            "get_program" => self.cmd_get_program().await,
            "rollback_program" => self.cmd_rollback_program().await,
            // PLC Programming commands (v1.3.0)
            "plc_upload" => self.cmd_plc_upload(&command.params).await,
            "plc_status" => self.cmd_plc_status(&command.params).await,
            "plc_start" => self.cmd_plc_start(&command.params).await,
            "plc_stop" => self.cmd_plc_stop(&command.params).await,
            "plc_list" => self.cmd_plc_list(&command.params).await,
            "plc_download" => self.cmd_plc_download(&command.params).await,
            "plc_delete" => self.cmd_plc_delete(&command.params).await,
            // Deploy orchestrator commands (v2.2)
            "deploy_to_codesys" => self.cmd_deploy_to_codesys(&command.params).await,
            "deploy_auto" => self.cmd_deploy_auto(&command.params).await,
            "validate_st" => self.cmd_validate_st(&command.params).await,
            // System commands
            "reboot" => self.cmd_reboot(&command.params).await,
            "restart_agent" => self.cmd_restart_agent().await,
            "update_firmware" => self.cmd_update_firmware(command).await,
            "set_log_level" => self.cmd_set_log_level(&command.params).await,
            // Failover commands (v1.3.4)
            "failover_status" => self.cmd_failover_status().await,
            "failover_force" => self.cmd_failover_force().await,
            "failover_recover" => self.cmd_failover_recover().await,
            // I/O config and output commands
            "update_io_config" => self.cmd_update_io_config(&command.params).await,
            "set_output" => self.cmd_set_output(&command.params).await,
            // Runtime Modbus device provisioning (Slice 3.5 / SENSOR-CRITICAL-007):
            // push a tenant-added VFD to the live edge as a Modbus device.
            "provision_modbus_device" => self.cmd_provision_modbus_device(&command.params).await,
            "decommission_modbus_device" => {
                self.cmd_decommission_modbus_device(&command.params).await
            }
            // SCADA display commands (v1.6.0)
            #[cfg(feature = "scada-display")]
            "deploy_process" => self.cmd_deploy_process(&command.params).await,
            #[cfg(feature = "scada-display")]
            "deploy_scada_package" => self.cmd_deploy_scada_package(&command.params).await,
            #[cfg(feature = "scada-display")]
            "undeploy_scada_package" => self.cmd_undeploy_scada_package(&command.params).await,
            // Faz 5 two-phase release bundle (takes the full command —
            // the intermediate staged ack rides the bundle's commandId)
            #[cfg(feature = "scada-display")]
            "deploy_bundle" => self.cmd_deploy_bundle(command).await,
            #[cfg(feature = "scada-display")]
            "display_on" => self.cmd_display_on().await,
            #[cfg(feature = "scada-display")]
            "display_off" => self.cmd_display_off().await,
            #[cfg(feature = "scada-display")]
            "get_display_status" => self.cmd_get_display_status().await,
            // LoRaWAN commands (v1.5.0)
            #[cfg(feature = "lorawan")]
            "update_lora_devices" => self.cmd_update_lora_devices(&command.params).await,
            #[cfg(feature = "lorawan")]
            "lora_downlink" => self.cmd_lora_downlink(&command.params).await,
            // RBAC manifest hot-reload (Batch 72 Sprint 6.1)
            "update_policy" => self.cmd_update_policy(&command.params).await,
            "update_cert_pinning" => self.cmd_update_cert_pinning(&command.params).await,
            // OPC UA user-token manifest hot-reload (Batch #249b Faz 5 A-3c)
            "update_user_token_manifest" => {
                self.cmd_update_user_token_manifest(&command.params).await
            }
            // Master-key rotation orchestrator (Batch 100 Sprint 6.3)
            "rotate_master" => self.cmd_rotate_master(&command.params).await,
            // Firmware A/B slot confirmation (Batch 109 Sprint 6.5)
            "confirm_slot" => self.cmd_confirm_slot(&command.params).await,
            // Signed firmware manifest verification preview (Batch 115 Sprint 6.5)
            "verify_signed_manifest" => self.cmd_verify_signed_manifest(&command.params).await,
            // Signed firmware manifest apply orchestrator (Batch 116 Sprint 6.5)
            "apply_signed_manifest" => self.cmd_apply_signed_manifest(&command.params).await,
            // License tier refresh (Batch 143 Faz 7)
            "refresh_license" => self.cmd_refresh_license(&command.params).await,
            // ST bytecode program deploy (Batch 167 Faz 3)
            "deploy_bytecode_program" => self.cmd_deploy_bytecode_program(&command.params).await,
            // Batch #299 ORPHAN-HIGH-020 closure: ST source
            // deploy. Parallel entry point to
            // deploy_bytecode_program — operators ship raw .st
            // source via SignedStSource envelope; edge runs
            // verify+parse+compile+deploy internally.
            "deploy_st_source" => self.cmd_deploy_st_source(&command.params).await,
            // ST bytecode program operator commands (Batch 173 Faz 3)
            "list_bytecode_programs" => self.cmd_list_bytecode_programs(&command.params).await,
            "enable_bytecode_program" => self.cmd_enable_bytecode_program(&command.params).await,
            "disable_bytecode_program" => self.cmd_disable_bytecode_program(&command.params).await,
            "delete_bytecode_program" => self.cmd_delete_bytecode_program(&command.params).await,
            // Live-debug force commands (Batch 197 Faz 6)
            "force_value" => self.cmd_force_value(&command.params).await,
            "unforce_value" => self.cmd_unforce_value(&command.params).await,
            "unforce_all" => self.cmd_unforce_all(&command.params).await,
            "list_forces" => self.cmd_list_forces(&command.params).await,
            // Watch-session commands (Batch 205 Faz 6)
            "watch_subscribe" => self.cmd_watch_subscribe(&command.params).await,
            "watch_unsubscribe" => self.cmd_watch_unsubscribe(&command.params).await,
            "list_watch_sessions" => self.cmd_list_watch_sessions(&command.params).await,
            _ => {
                // v1.2.2: Sanitize user-provided command name to prevent log injection
                warn!("Unknown command: {}", sanitize_for_log(&command.command));
                (
                    false,
                    json!(null),
                    Some(format!(
                        "Unknown command: {}",
                        sanitize_for_log(&command.command)
                    )),
                )
            }
        };

        // v1.2.6: Log command completion with timing
        let elapsed = start_time.elapsed();
        if success {
            info!(
                "Command completed: id='{}', command='{}', success=true, duration={:?}",
                command.command_id,
                sanitize_for_log(&command.command),
                elapsed
            );
        } else {
            warn!(
                "Command failed: id='{}', command='{}', error={:?}, duration={:?}",
                command.command_id,
                sanitize_for_log(&command.command),
                error,
                elapsed
            );
        }

        // IEC 62443 SL-2: Audit log outcome of safety-critical commands
        if is_safety_critical {
            warn!(
                "AUDIT: Safety-critical command completed: command='{}', id='{}', device_id='{}', success={}, duration={:?}, timestamp='{}'",
                sanitize_for_log(&command.command),
                command.command_id,
                device_id,
                success,
                elapsed,
                Utc::now().to_rfc3339()
            );
        }

        // Batch 79 Sprint 6.2 Phase 2: emit POST-exec audit
        // event to the HMAC-chained sink (when
        // audit.mode=Enabled). No-op when sink is None.
        //
        // Batch 118 Sprint 6.5: enrich detail with per-command
        // result summary via `summarize_result`. Closes the
        // audit-detail gap flagged in Batch 113/115/116
        // observations — command-specific fields (which gate
        // rejected, which slot confirmed, which bootloader
        // backend fired) now flow into the audit chain
        // alongside the base elapsed_ms + err.
        let post_outcome = if success {
            crate::audit::AuditOutcome::Success
        } else {
            crate::audit::AuditOutcome::Failure
        };
        let result_summary = audit_emit::summarize_result(&command.command, &result);
        let post_detail = match (&error, result_summary.is_empty()) {
            (Some(e), true) => {
                format!("elapsed_ms={} err={}", elapsed.as_millis(), e)
            }
            (Some(e), false) => format!(
                "elapsed_ms={} err={} {}",
                elapsed.as_millis(),
                e,
                result_summary
            ),
            (None, true) => format!("elapsed_ms={}", elapsed.as_millis()),
            (None, false) => format!("elapsed_ms={} {}", elapsed.as_millis(), result_summary),
        };
        audit_emit::emit_post_event(
            audit_sink.as_ref(),
            &command.command,
            &command.command_id,
            &device_id,
            tenant,
            post_outcome,
            &post_detail,
        );

        CommandResponse {
            command_id: command.command_id.clone(),
            device_id,
            success,
            result,
            timestamp: Utc::now().to_rfc3339(),
            error,
        }
    }
}
