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

use crate::authz::permission::Permission;

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
    super::catalog::permission_for_command(cmd, params)
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
    fn update_user_token_manifest_requires_distinct_permission() {
        // Batch #248 Faz 5 A-3c hot-reload: user-token manifest
        // is a DIFFERENT trust anchor (different HSM signing key,
        // different monotonic version stream). Must require
        // ManageUserTokenManifest, NOT ManagePolicy — collapsing
        // the two would defeat the R-4 3-key segregation.
        assert!(matches!(
            permission_for_command("update_user_token_manifest", &json!({})),
            Some(Permission::ManageUserTokenManifest)
        ));
    }

    #[test]
    fn update_user_token_manifest_is_not_manage_policy() {
        // Regression gate: if someone reroutes this permission to
        // ManagePolicy "for convenience", that collapses the key
        // segregation. Guard with an explicit negative assertion.
        assert!(!matches!(
            permission_for_command("update_user_token_manifest", &json!({})),
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
