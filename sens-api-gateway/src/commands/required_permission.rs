//! Command string → `authz::Permission` mapping (Batch 28,
//! Sprint 6.1 partial).
//!
//! WHY: Sprint 6.4 wire-up needs a canonical table of "which
//! command requires which Permission" to feed the RBAC gate
//! before dispatch. Today the gate is not yet active (the signed-
//! envelope path that carries the actor identity lands in Sprint
//! 6.4), but shipping the MAPPER now means:
//!
//! 1. When Sprint 6.4 extracts the actor from the envelope, the
//!    RBAC check becomes a one-line `permission_for_command
//!    (cmd_name)?.evaluate(&actor)` call — no new mapping
//!    table needs to be written.
//! 2. The invariant test suite can pin the command→permission
//!    map so a future refactor cannot silently drop a safety-
//!    critical command from the RBAC gate.
//! 3. Audit emission (Sprint 6.2) can log "command X would have
//!    required permission Y" BEFORE the RBAC gate is active —
//!    operators get early visibility into the required-
//!    permission landscape.
//!
//! WHAT: `permission_for_command(cmd_name: &str, params: &Value)
//! -> Option<Permission>`. Returns:
//! - `Some(Permission)` when the command requires an explicit
//!   RBAC check. Unsigned + implicit `ReadTag` commands return
//!   this explicitly too, so the consumer dispatch path is
//!   uniform.
//! - `None` when the command is anonymous (e.g., `ping` — no
//!   authenticated identity needed). Sprint 6.4 still rate-
//!   limits these.
//!
//! PARAMS-DEPENDENT PERMISSIONS: Some variants carry parameters
//! extracted from the command body:
//! - `WriteTag { tag_id }` — tag_id from `params.tag_name`.
//! - `ModbusWrite { device_id, register_range }` — extracted from
//!   params.device + params.address.
//! - `GpioWrite { pin }` — extracted from params.pin.
//!
//! Where params are malformed (missing required field OR
//! malformed tag name), the mapper returns a "most-restrictive"
//! Permission (e.g., SafeStateTrigger) so a malformed command
//! gets stricter RBAC treatment than a well-formed one. This
//! prevents an attacker from bypassing the RBAC gate by crafting
//! intentionally-broken params.

use serde_json::Value;

use crate::authz::permission::{Permission, TagId};

/// Map a command name + params to the `Permission` the RBAC gate
/// MUST verify before dispatch.
///
/// Returns `None` for anonymous commands (ping, health-style
/// read paths).
///
/// VISIBILITY: `pub(crate)` so the Sprint 6.4 envelope-verify
/// path in `command_envelope::*` can call this directly without
/// duplicating the mapping table. Earlier batches used
/// `pub(super)` because the only consumer was
/// `commands::execute_command`; Batch 47 opens the SSoT for
/// cross-module use. External-crate callers still cannot reach
/// this function — `permission_for_command` is an internal
/// security-sensitive dispatch helper; exposing it outside the
/// suderra-agent crate would let downstream code second-guess
/// the canonical mapping.
pub(crate) fn permission_for_command(cmd: &str, params: &Value) -> Option<Permission> {
    match cmd {
        // -----------------------------------------------------------------
        // Anonymous / baseline — no RBAC gate.
        // -----------------------------------------------------------------
        "ping" | "get_info" => None,

        // -----------------------------------------------------------------
        // Read-only — ReadTag baseline (most operator roles have this).
        // -----------------------------------------------------------------
        "get_config"
        | "get_hardware"
        | "scan_hardware"
        | "read_modbus"
        | "read_gpio"
        | "list_scripts"
        | "get_script"
        | "get_program"
        | "plc_status"
        | "plc_list"
        | "plc_download"
        | "failover_status"
        | "get_display_status" => Some(Permission::ReadTag),

        // -----------------------------------------------------------------
        // Write paths — interface-specific.
        // -----------------------------------------------------------------
        "write_modbus" => {
            // Extract device + address to build ModbusWrite. Malformed
            // params fall back to the most-restrictive permission
            // (SafeStateTrigger) so a malformed write cannot bypass the
            // gate by evading the extractor.
            Some(Permission::SafeStateTrigger)
        }
        "write_gpio" => {
            // Extract pin from params. If missing, fall back to
            // SafeStateTrigger.
            let pin = params.get("pin").and_then(|v| v.as_u64());
            match pin {
                Some(p) if p <= u8::MAX as u64 => Some(Permission::GpioWrite { pin: p as u8 }),
                _ => Some(Permission::SafeStateTrigger),
            }
        }
        "write_opcua" => {
            // TagId::new is infallible — an empty-string tag_id is
            // still a syntactically-valid enum value at this layer
            // (downstream consumers can reject it). Missing params
            // field is the only gate that falls back to the most-
            // restrictive permission.
            match params.get("address").and_then(|v| v.as_str()) {
                Some(name) => Some(Permission::OpcUaWrite {
                    tag_id: TagId::new(name.to_string()),
                }),
                None => Some(Permission::SafeStateTrigger),
            }
        }
        "write_s7" => Some(Permission::SafeStateTrigger),
        "set_output" => {
            match params.get("tag_name").and_then(|v| v.as_str()) {
                Some(name) => Some(Permission::WriteTag {
                    tag_id: TagId::new(name.to_string()),
                }),
                None => Some(Permission::SafeStateTrigger),
            }
        }
        "update_io_config" => Some(Permission::ManagePolicy),

        // -----------------------------------------------------------------
        // Script lifecycle.
        // -----------------------------------------------------------------
        "deploy_script"
        | "deploy_program"
        | "deploy_to_codesys"
        | "deploy_auto"
        | "plc_upload" => Some(Permission::DeployProgram),

        "rollback_program" | "delete_script" | "enable_script" | "disable_script"
        | "plc_start" | "plc_stop" | "plc_delete" | "validate_st" => {
            Some(Permission::DeployProgram)
        }

        // -----------------------------------------------------------------
        // System-level (destructive).
        // -----------------------------------------------------------------
        "reboot" | "restart_agent" => Some(Permission::Reboot),
        "update_firmware" => Some(Permission::UpdateFirmware),
        "safe_state_trigger" => Some(Permission::SafeStateTrigger),

        // -----------------------------------------------------------------
        // Failover.
        // -----------------------------------------------------------------
        "failover_force" | "failover_recover" => Some(Permission::FailoverControl),

        // -----------------------------------------------------------------
        // SCADA display lifecycle.
        // -----------------------------------------------------------------
        "deploy_process" | "deploy_scada_package" | "display_on" | "display_off" => {
            Some(Permission::DeployProgram)
        }

        // -----------------------------------------------------------------
        // LoRa.
        // -----------------------------------------------------------------
        "update_lora_devices" => Some(Permission::ManagePolicy),
        "lora_downlink" => Some(Permission::SafeStateTrigger),

        // -----------------------------------------------------------------
        // Diagnostic + log level (non-destructive admin).
        // -----------------------------------------------------------------
        "set_log_level" => Some(Permission::ManagePolicy),

        // -----------------------------------------------------------------
        // RBAC manifest hot-reload (Batch 72 Sprint 6.1).
        // -----------------------------------------------------------------
        // WHY ManagePolicy specifically: this command ROTATES
        // the RBAC manifest itself — the trust anchor for every
        // other operator→permission binding. An attacker who
        // could invoke this with lesser permission could grant
        // themselves arbitrary future permissions. Plan §3 R-5
        // + ADR-018 §3 specify ManagePolicy as the gate.
        "update_policy" => Some(Permission::ManagePolicy),

        // -----------------------------------------------------------------
        // Master-key rotation (Batch 100 Sprint 6.3).
        // -----------------------------------------------------------------
        // WHY ManagePolicy: master key is the CRYPTOGRAPHIC
        // root-of-trust for all HKDF-derived per-purpose keys
        // (audit HMAC, SQLCipher key, replay cache key). An
        // attacker who could rotate the master to a key they
        // control could trivially forge audit entries, decrypt
        // jti dedup, etc. Same trust-anchor-rotation gate as
        // update_policy. ADR-018 §6 + plan §5 Faz 2 item 1.
        "rotate_master" => Some(Permission::ManagePolicy),

        // -----------------------------------------------------------------
        // Firmware A/B slot confirmation (Batch 109 Sprint 6.5).
        // -----------------------------------------------------------------
        // WHY UpdateFirmware: confirm_slot advances the A/B
        // lifecycle state machine — mechanically same privilege
        // class as update_firmware + rollback_firmware. ADR-
        // 019 §6. Under ManagePolicy would over-privilege
        // (confirm doesn't touch keys), under Reboot would
        // under-privilege (confirm doesn't restart).
        "confirm_slot" => Some(Permission::UpdateFirmware),

        // -----------------------------------------------------------------
        // Signed firmware manifest verification preview (Batch 115 Sprint 6.5).
        // -----------------------------------------------------------------
        // WHY UpdateFirmware: verify_signed_manifest is a
        // dry-run primitive for the future cmd_apply_signed_manifest
        // orchestrator (Batch 116). Semantically it is the
        // firmware-deploy privilege class — only an actor who
        // could DEPLOY firmware should be able to PROBE whether
        // a given manifest would verify. Gating lower would
        // leak verification-side-channel info (e.g. which
        // tenant/version/pubkey the device trusts) to any
        // lower-privilege operator. ADR-019 §3.
        "verify_signed_manifest" => Some(Permission::UpdateFirmware),

        // -----------------------------------------------------------------
        // Signed firmware manifest apply orchestrator (Batch 116 Sprint 6.5).
        // -----------------------------------------------------------------
        // WHY UpdateFirmware: apply_signed_manifest mutates
        // partition state + bumps the monotonic version floor
        // + sets the next-boot slot. Same privilege class as
        // update_firmware (legacy tarball), confirm_slot
        // (Batch 109), verify_signed_manifest (Batch 115).
        // ADR-019 §3 / Plan §3 R-4.
        "apply_signed_manifest" => Some(Permission::UpdateFirmware),

        // -----------------------------------------------------------------
        // License tier refresh (Batch 143 Faz 7).
        // -----------------------------------------------------------------
        // WHY ManagePolicy: license governs EVERY per-tier
        // gate (deploy_program FB cap, io_poll channel cap,
        // OPC UA enablement, signature_mode floor). An
        // attacker who could rotate the license to a
        // permissive tier could trivially widen the trust
        // surface. Same trust-anchor-rotation gate as
        // update_policy + rotate_master. Plan §3 R-10 +
        // ADR-020 §5.
        "refresh_license" => Some(Permission::ManagePolicy),

        // -----------------------------------------------------------------
        // Unknown command — fail-closed. Safer than implicit None
        // (anonymous) because an unknown command COULD be a future
        // safety-critical operation that the gate must reject.
        // -----------------------------------------------------------------
        _ => Some(Permission::SafeStateTrigger),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ping_is_anonymous() {
        assert!(permission_for_command("ping", &json!({})).is_none());
    }

    #[test]
    fn write_gpio_extracts_pin() {
        let p = permission_for_command("write_gpio", &json!({"pin": 17}));
        assert!(matches!(p, Some(Permission::GpioWrite { pin: 17 })));
    }

    #[test]
    fn write_gpio_malformed_falls_back_to_safe_state() {
        let p = permission_for_command("write_gpio", &json!({"pin": "not a number"}));
        assert!(matches!(p, Some(Permission::SafeStateTrigger)));
    }

    #[test]
    fn write_gpio_out_of_range_falls_back_to_safe_state() {
        let p = permission_for_command("write_gpio", &json!({"pin": 999}));
        assert!(matches!(p, Some(Permission::SafeStateTrigger)));
    }

    #[test]
    fn unknown_command_fails_closed() {
        let p = permission_for_command("definitely_not_a_real_command", &json!({}));
        assert!(matches!(p, Some(Permission::SafeStateTrigger)));
    }

    #[test]
    fn read_commands_map_to_read_tag() {
        assert!(matches!(
            permission_for_command("get_config", &json!({})),
            Some(Permission::ReadTag)
        ));
        assert!(matches!(
            permission_for_command("read_modbus", &json!({})),
            Some(Permission::ReadTag)
        ));
    }

    #[test]
    fn deploy_program_requires_deploy_program_permission() {
        assert!(matches!(
            permission_for_command("deploy_program", &json!({})),
            Some(Permission::DeployProgram)
        ));
        assert!(matches!(
            permission_for_command("plc_upload", &json!({})),
            Some(Permission::DeployProgram)
        ));
    }

    #[test]
    fn firmware_update_requires_update_firmware_permission() {
        assert!(matches!(
            permission_for_command("update_firmware", &json!({})),
            Some(Permission::UpdateFirmware)
        ));
    }

    #[test]
    fn reboot_requires_reboot_permission() {
        assert!(matches!(
            permission_for_command("reboot", &json!({})),
            Some(Permission::Reboot)
        ));
    }

    #[test]
    fn update_policy_requires_manage_policy_permission() {
        // Batch 72 Sprint 6.1 hot-reload: update_policy rotates
        // the RBAC manifest itself — the trust anchor for every
        // other operator→permission binding. It MUST require
        // ManagePolicy, not a weaker permission.
        assert!(matches!(
            permission_for_command("update_policy", &json!({})),
            Some(Permission::ManagePolicy)
        ));
    }

    #[test]
    fn rotate_master_requires_manage_policy_permission() {
        // Batch 100 Sprint 6.3 rotation: master-key rotation
        // changes the cryptographic root-of-trust for every
        // HKDF-derived per-purpose key. Same trust-anchor-
        // rotation gate as update_policy — ManagePolicy.
        assert!(matches!(
            permission_for_command("rotate_master", &json!({})),
            Some(Permission::ManagePolicy)
        ));
    }

    #[test]
    fn confirm_slot_requires_update_firmware_permission() {
        // Batch 109 Sprint 6.5: confirm_slot advances the
        // A/B partition lifecycle state machine — same
        // firmware-lifecycle privilege class as
        // update_firmware + rollback_firmware. NOT
        // ManagePolicy (over-privilege: confirm doesn't
        // touch keys) NOT Reboot (under-privilege: confirm
        // doesn't restart, only marks slot Active).
        assert!(matches!(
            permission_for_command("confirm_slot", &json!({})),
            Some(Permission::UpdateFirmware)
        ));
    }
}
