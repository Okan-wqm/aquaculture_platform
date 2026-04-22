//! Audit emission helpers (Batch 79 Sprint 6.2 Phase 2).
//!
//! Thin glue layer between the `commands` god-module and the
//! `audit::AuditSink` runtime landed in Batches 74-78. Exists
//! in commands/ (not audit/) because the mapping logic
//! depends on command-domain knowledge (cmd name → AuditAction
//! taxonomy) that doesn't belong in the audit module.
//!
//! ## Flow
//!
//! `execute_command` calls:
//!   1. `emit_pre_event(sink, cmd, device_id)` BEFORE dispatch.
//!   2. (dispatches)
//!   3. `emit_post_event(sink, cmd, device_id, outcome, detail)`
//!      AFTER dispatch.
//!
//! Both calls are no-ops when `sink` is None
//! (audit.mode=Disabled). When Some, they construct an
//! `AuditEntry` + call `sink.append()`. Append failures are
//! logged but do NOT fail the command — Phase 2 / Batch 80
//! flips this to fail-closed when the keystore-derived key
//! lands.
//!
//! ## Action mapping
//!
//! Different command names map to different AuditAction
//! discriminators so downstream analytics can slice by
//! semantic category (firmware vs script vs write vs
//! policy). Unknown / admin commands map to
//! `CommandExecuted` as the catch-all.

use std::sync::Arc;

use tracing::warn;

use crate::audit::{AuditAction, AuditActor, AuditEntry, AuditOutcome, AuditPhase, AuditResource, AuditSink};
use crate::authz::permission::TenantId;

/// Map a command name to its semantic AuditAction. Unknown /
/// non-matching commands fall back to `CommandExecuted` /
/// `CommandRejected` depending on the phase + outcome.
pub(super) fn action_for_command(cmd: &str, outcome: AuditOutcome) -> AuditAction {
    // Explicit mapping keeps the taxonomy auditable: a new
    // command must be added here to get a specific action,
    // otherwise it falls into the catch-all.
    match cmd {
        // Policy lifecycle
        "update_policy" => match outcome {
            AuditOutcome::Success => AuditAction::PolicyUpdateApplied,
            AuditOutcome::Failure | AuditOutcome::AuthorizationDenied => {
                AuditAction::PolicyUpdateRejected
            }
        },

        // Firmware lifecycle
        "update_firmware" => match outcome {
            AuditOutcome::Success => AuditAction::FirmwareDeployApplied,
            _ => AuditAction::FirmwareDeployRequested,
        },

        // Program deploy
        "deploy_program" | "plc_upload" | "deploy_to_codesys" | "deploy_auto"
        | "deploy_script" => match outcome {
            AuditOutcome::Success => AuditAction::ProgramDeployApplied,
            _ => AuditAction::ProgramDeployRequested,
        },
        "rollback_program" => AuditAction::ProgramDeployRollback,

        // Safety
        "safe_state_trigger" => AuditAction::SafeStateTriggered,

        // Tag writes (various protocols)
        "write_modbus" | "write_gpio" | "write_opcua" | "write_s7" | "set_output" => {
            AuditAction::TagWrite
        }

        // Reads
        "read_modbus" | "read_gpio" | "get_hardware" | "scan_hardware"
        | "get_info" | "get_config" | "ping" => AuditAction::TagRead,

        // Everything else: catch-all. Both phases use this
        // same fallback regardless of outcome.
        _ => match outcome {
            AuditOutcome::Success => AuditAction::CommandExecuted,
            AuditOutcome::AuthorizationDenied => AuditAction::CommandRejected,
            AuditOutcome::Failure => AuditAction::CommandRejected,
        },
    }
}

/// Construct an AuditEntry for the given phase + command +
/// outcome. Kept as a pure function so it can be unit-tested
/// without any filesystem side-effects.
pub(super) fn build_entry(
    phase: AuditPhase,
    cmd: &str,
    command_id: &str,
    device_id: &str,
    tenant: TenantId,
    outcome: AuditOutcome,
    detail: &str,
) -> AuditEntry {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::ZERO);

    // Bound detail at MAX_DETAIL_BYTES — canonical_bytes
    // refuses oversized. Take prefix to avoid canonical_bytes
    // error surfacing in the audit emit path.
    let truncated_detail = if detail.len() > crate::audit::entry::MAX_DETAIL_BYTES {
        detail
            .get(..crate::audit::entry::MAX_DETAIL_BYTES)
            .unwrap_or("")
            .to_string()
    } else {
        detail.to_string()
    };

    AuditEntry {
        timestamp_unix_secs: now.as_secs() as i64,
        timestamp_nanos: now.subsec_nanos(),
        correlation_id: command_id.to_string(),
        phase,
        // Operator identity comes from the Batch 68 envelope
        // adapter path; pre-adapter-integration it's a
        // placeholder label. Phase 2 / Batch 81 wires real
        // operator identity from AuthorizedContext when
        // Sprint 6.4 RBAC gate activates.
        actor: AuditActor::new(format!("device:{}", device_id)),
        tenant,
        // Sprint 6.1 populated: default policy_version=0
        // when the manifest isn't loaded (Disabled mode).
        // Sprint 6.4 RBAC-gate-activation populates from
        // AuthorizedContext.
        policy_version: 0,
        // Sprint 6.4 co-approval gate populates this;
        // pre-activation always false.
        two_person_integrity_verified: false,
        action: action_for_command(cmd, outcome),
        // Resource defaults to a free-form label; commands
        // that manipulate specific resources (tags, programs)
        // will override this via a future expansion of the
        // emit API. Pre-Batch-80 the cmd name is the resource.
        resource: AuditResource::Other {
            label: cmd.to_string(),
        },
        outcome,
        detail: truncated_detail,
    }
}

/// Emit a pre-exec audit entry. No-op when sink is None.
///
/// Pre-entry outcome is always `Success` — the pre phase
/// represents "we're about to execute this", not the
/// execution result. A RBAC denial (when Sprint 6.4 gate
/// activates) emits a SINGLE entry with outcome =
/// `AuthorizationDenied` rather than both pre + post.
pub(super) fn emit_pre_event(
    sink: Option<&Arc<AuditSink>>,
    cmd: &str,
    command_id: &str,
    device_id: &str,
    tenant: TenantId,
) {
    let Some(sink) = sink else { return };
    let entry = build_entry(
        AuditPhase::Pre,
        cmd,
        command_id,
        device_id,
        tenant,
        AuditOutcome::Success,
        "",
    );
    if let Err(e) = sink.append(entry) {
        warn!(
            "Audit pre-event append failed (non-fatal — command proceeds, Phase 2 / Batch 80 flips to fail-closed): cmd={} err={}",
            cmd, e
        );
    }
}

/// Emit a post-exec audit entry with the handler's outcome.
/// No-op when sink is None.
pub(super) fn emit_post_event(
    sink: Option<&Arc<AuditSink>>,
    cmd: &str,
    command_id: &str,
    device_id: &str,
    tenant: TenantId,
    outcome: AuditOutcome,
    detail: &str,
) {
    let Some(sink) = sink else { return };
    let entry = build_entry(
        AuditPhase::Post,
        cmd,
        command_id,
        device_id,
        tenant,
        outcome,
        detail,
    );
    if let Err(e) = sink.append(entry) {
        warn!(
            "Audit post-event append failed (non-fatal — result returned, Phase 2 / Batch 80 flips to fail-closed): cmd={} err={}",
            cmd, e
        );
    }
}

/// Extract a compact `key=value` summary string from the
/// command result JSON (Batch 118 Sprint 6.5 emit contract
/// extension).
///
/// ## WHY
///
/// Pre-Batch-118 the dispatch-layer `emit_post_event` detail
/// string carried ONLY `elapsed_ms` + `err`. Per-command
/// structured-result fields (which gate rejected a firmware
/// manifest, which slot cmd_confirm_slot operated on, which
/// force-value was applied) flowed ONLY to the MQTT response
/// payload — never to the audit log. Forensic reconstruction
/// required cross-referencing tracing logs + command-response
/// archives outside the audit chain.
///
/// Batch 113 observation #2 + Batch 115 observation #2 +
/// Batch 116 observation #1 all flagged the same root cause:
/// the `emit_post_event` contract had no per-command
/// result-detail ingest point. This function closes it by
/// converting the command-specific result JSON (that the
/// handler ALREADY constructs) into a flat key=value string
/// suitable for the audit detail field.
///
/// ## Pattern
///
/// Command name → known-field extraction. New command-specific
/// detail needs ONE new arm here; the default catch-all keeps
/// the no-detail behaviour for commands whose result JSON is
/// either empty or whose fields are not audit-relevant.
///
/// Keep the output UNDER `crate::audit::entry::MAX_DETAIL_BYTES`
/// after prefix — the post-emit truncates but truncation loses
/// the trailing fields, which are usually the most specific.
/// Target 100-200 bytes per summary.
pub(super) fn summarize_result(cmd: &str, result: &serde_json::Value) -> String {
    match cmd {
        "confirm_slot" => {
            let slot = result
                .get("confirmed_slot")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let bl_ok = result
                .get("bootloader_coordination")
                .and_then(|v| v.get("cleared_pending_boot"))
                .and_then(|v| v.as_bool())
                .map(|b| if b { "ok" } else { "failed" })
                .unwrap_or("unknown");
            let backend = result
                .get("bootloader_coordination")
                .and_then(|v| v.get("backend"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            format!(
                "confirmed_slot={} bootloader_clear={} backend={}",
                slot, bl_ok, backend
            )
        }
        "verify_signed_manifest" => {
            // Both success + failure carry a `verified` flag;
            // failures carry `gate` + optional `reason`.
            let verified = result
                .get("verified")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if verified {
                let fw_version = result
                    .get("firmware_version")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let tag = result
                    .get("release_tag")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let files = result
                    .get("file_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                format!(
                    "verified=true firmware_version={} release_tag={} file_count={}",
                    fw_version, tag, files
                )
            } else {
                let gate = result
                    .get("gate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                format!("verified=false gate={}", gate)
            }
        }
        "apply_signed_manifest" => {
            let verified = result
                .get("verified")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !verified {
                let gate = result
                    .get("gate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                return format!("verified=false gate={}", gate);
            }
            let applied = result
                .get("applied")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !applied {
                let gate = result
                    .get("gate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("apply_failed");
                return format!("verified=true applied=false gate={}", gate);
            }
            let transition = result
                .get("applied_transition")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let target = result
                .get("target_slot")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let from_v = result
                .get("previous_firmware_version")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let to_v = result
                .get("firmware_version")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let bl_ok = result
                .get("bootloader_coordination")
                .and_then(|v| v.get("set_next_boot_slot_ok"))
                .and_then(|v| v.as_bool())
                .map(|b| if b { "ok" } else { "failed" })
                .unwrap_or("unknown");
            format!(
                "applied=true transition={} target={} version={}->{} bootloader={}",
                transition, target, from_v, to_v, bl_ok
            )
        }
        // Catch-all — no per-command detail known; caller
        // emits the default elapsed_ms + err detail.
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_for_command_maps_update_policy_to_policy_update() {
        assert!(matches!(
            action_for_command("update_policy", AuditOutcome::Success),
            AuditAction::PolicyUpdateApplied
        ));
        assert!(matches!(
            action_for_command("update_policy", AuditOutcome::Failure),
            AuditAction::PolicyUpdateRejected
        ));
    }

    #[test]
    fn action_for_command_maps_writes_to_tag_write() {
        assert!(matches!(
            action_for_command("write_modbus", AuditOutcome::Success),
            AuditAction::TagWrite
        ));
        assert!(matches!(
            action_for_command("write_gpio", AuditOutcome::Success),
            AuditAction::TagWrite
        ));
    }

    #[test]
    fn action_for_command_maps_reads_to_tag_read() {
        assert!(matches!(
            action_for_command("read_modbus", AuditOutcome::Success),
            AuditAction::TagRead
        ));
        assert!(matches!(
            action_for_command("ping", AuditOutcome::Success),
            AuditAction::TagRead
        ));
    }

    #[test]
    fn action_for_command_catch_all_maps_by_outcome() {
        assert!(matches!(
            action_for_command("some_unknown_cmd", AuditOutcome::Success),
            AuditAction::CommandExecuted
        ));
        assert!(matches!(
            action_for_command("some_unknown_cmd", AuditOutcome::AuthorizationDenied),
            AuditAction::CommandRejected
        ));
        assert!(matches!(
            action_for_command("some_unknown_cmd", AuditOutcome::Failure),
            AuditAction::CommandRejected
        ));
    }

    #[test]
    fn build_entry_truncates_oversized_detail() {
        let tenant = TenantId::new_from_verified([0x42u8; 16]);
        let huge_detail = "x".repeat(crate::audit::entry::MAX_DETAIL_BYTES + 100);
        let entry = build_entry(
            AuditPhase::Post,
            "ping",
            "cid-1",
            "dev-1",
            tenant,
            AuditOutcome::Success,
            &huge_detail,
        );
        assert_eq!(entry.detail.len(), crate::audit::entry::MAX_DETAIL_BYTES);
    }

    #[test]
    fn emit_is_noop_when_sink_is_none() {
        // Cannot directly assert "no side effect" but can
        // prove the function doesn't panic + returns without
        // error when sink is None.
        let tenant = TenantId::new_from_verified([0u8; 16]);
        emit_pre_event(None, "ping", "cid-1", "dev-1", tenant);
        emit_post_event(
            None,
            "ping",
            "cid-1",
            "dev-1",
            tenant,
            AuditOutcome::Success,
            "ok",
        );
    }

    // ========================================================================
    // summarize_result tests (Batch 118 Sprint 6.5)
    // ========================================================================

    #[test]
    fn summarize_confirm_slot_success() {
        let result = serde_json::json!({
            "confirmed_slot": "a",
            "new_state": {},
            "bootloader_coordination": {
                "backend": "noop",
                "cleared_pending_boot": true
            }
        });
        let summary = summarize_result("confirm_slot", &result);
        assert_eq!(
            summary,
            "confirmed_slot=a bootloader_clear=ok backend=noop"
        );
    }

    #[test]
    fn summarize_confirm_slot_bootloader_failed() {
        let result = serde_json::json!({
            "confirmed_slot": "b",
            "bootloader_coordination": {
                "backend": "tryboot",
                "cleared_pending_boot": false
            }
        });
        let summary = summarize_result("confirm_slot", &result);
        assert_eq!(
            summary,
            "confirmed_slot=b bootloader_clear=failed backend=tryboot"
        );
    }

    #[test]
    fn summarize_verify_signed_manifest_success() {
        let result = serde_json::json!({
            "verified": true,
            "firmware_version": 42,
            "release_tag": "v2.0.0",
            "file_count": 17
        });
        let summary = summarize_result("verify_signed_manifest", &result);
        assert_eq!(
            summary,
            "verified=true firmware_version=42 release_tag=v2.0.0 file_count=17"
        );
    }

    #[test]
    fn summarize_verify_signed_manifest_failure_surfaces_gate() {
        let result = serde_json::json!({
            "verified": false,
            "gate": "invalid_signature",
            "reason": "ed25519 rejected"
        });
        let summary = summarize_result("verify_signed_manifest", &result);
        assert_eq!(summary, "verified=false gate=invalid_signature");
    }

    #[test]
    fn summarize_apply_signed_manifest_applied() {
        let result = serde_json::json!({
            "verified": true,
            "applied": true,
            "applied_transition": "SwapToPending",
            "target_slot": "b",
            "previous_firmware_version": 1,
            "firmware_version": 2,
            "bootloader_coordination": {
                "backend": "noop",
                "set_next_boot_slot_ok": true
            }
        });
        let summary = summarize_result("apply_signed_manifest", &result);
        assert_eq!(
            summary,
            "applied=true transition=SwapToPending target=b version=1->2 bootloader=ok"
        );
    }

    #[test]
    fn summarize_apply_signed_manifest_verified_but_apply_rejected() {
        let result = serde_json::json!({
            "verified": true,
            "applied": false,
            "gate": "invalid_initial_state",
            "reason": "pending confirm open"
        });
        let summary = summarize_result("apply_signed_manifest", &result);
        assert_eq!(
            summary,
            "verified=true applied=false gate=invalid_initial_state"
        );
    }

    #[test]
    fn summarize_apply_signed_manifest_verify_rejected() {
        let result = serde_json::json!({
            "verified": false,
            "gate": "tenant_mismatch"
        });
        let summary = summarize_result("apply_signed_manifest", &result);
        assert_eq!(summary, "verified=false gate=tenant_mismatch");
    }

    #[test]
    fn summarize_unknown_command_returns_empty_string() {
        let result = serde_json::json!({
            "accepted": true,
            "note": "some unknown-cmd response"
        });
        let summary = summarize_result("some_unknown_cmd", &result);
        assert_eq!(summary, "");
    }

    #[test]
    fn summarize_missing_fields_falls_back_to_placeholders() {
        // Pathological result shape (handler didn't return
        // expected fields). The summarizer must NOT panic +
        // MUST return a safe placeholder string so the audit
        // detail field remains parseable.
        let result = serde_json::json!({});
        let s = summarize_result("confirm_slot", &result);
        assert_eq!(
            s,
            "confirmed_slot=? bootloader_clear=unknown backend=?"
        );
        let s = summarize_result("verify_signed_manifest", &result);
        assert_eq!(s, "verified=false gate=unknown");
        let s = summarize_result("apply_signed_manifest", &result);
        assert_eq!(s, "verified=false gate=unknown");
    }
}
