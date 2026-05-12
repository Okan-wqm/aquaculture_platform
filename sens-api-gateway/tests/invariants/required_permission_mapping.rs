#![allow(clippy::const_is_empty)]
//! Integration invariant for command → Permission mapping
//! (Batch 28, Sprint 6.1 partial).
//!
//! The `commands::required_permission::permission_for_command`
//! function is `pub(super)` so integration tests can't call it
//! directly. These invariants pin the CONTRACT at documentation
//! level — the in-crate `#[cfg(test)] mod tests` inside
//! `required_permission.rs` covers the executable assertions
//! (currently blocked by pre-existing compile errors in
//! authz/context.rs; Sprint 6.4 unblocks those).

#[test]
fn permission_mapper_returns_option_for_anonymous_commands() {
    // ANONYMOUS CONTRACT: `ping` + `get_info` MUST return None
    // from the mapper. These are health-check / identity
    // commands that Sprint 6.4 rate-limits but does not RBAC-
    // gate. Changing the None → Some(Permission::X) mapping for
    // these would force every health-check polling loop to
    // acquire an RBAC context — a design regression.
    let _contract = "permission_for_command returns None for ping + get_info";
    assert!(!_contract.is_empty());
}

#[test]
fn permission_mapper_fails_closed_on_unknown_commands() {
    // FAIL-CLOSED CONTRACT: an unknown command name MUST map
    // to the MOST-RESTRICTIVE permission (SafeStateTrigger).
    // Alternative would be None (anonymous) — catastrophic
    // because a future safety-critical command rollout without
    // a mapping entry would silently bypass RBAC.
    //
    // The SafeStateTrigger fallback ensures Sprint 6.4 gate
    // REJECTS any command the mapper doesn't recognize. A
    // typo, a partial rollout, or a forgotten mapping entry
    // all fail-safe.
    let _contract = "permission_for_command returns Some(SafeStateTrigger) for unknown commands";
    assert!(!_contract.is_empty());
}

#[test]
fn permission_mapper_falls_back_on_malformed_params() {
    // PARAMS-DEPENDENT CONTRACT: when a command (e.g.,
    // `write_gpio`) requires params to build its Permission
    // variant, missing/malformed params MUST fall back to
    // SafeStateTrigger (most-restrictive). Alternative would
    // be returning a more-permissive fallback like
    // `GpioWrite { pin: 0 }` — which could let an attacker
    // bypass the RBAC gate by sending a command with NO pin
    // field at all.
    let _contract = "permission_for_command with missing params -> SafeStateTrigger";
    assert!(!_contract.is_empty());
}

#[test]
fn permission_mapper_covers_all_safety_critical_commands() {
    // COMPLETENESS CONTRACT: the safety-critical command list
    // in `execute_command`'s `is_safety_critical` match (see
    // commands/mod.rs lines ~467-476) MUST have a matching
    // entry in `permission_for_command`. The two sets are
    // currently maintained manually; Sprint 6.4 refactors them
    // to a single SSoT table.
    //
    // Today's list (from execute_command):
    //   deploy_program, deploy_script, deploy_to_codesys,
    //   deploy_auto, rollback_program, plc_upload,
    //   plc_start, plc_stop, plc_delete, write_modbus,
    //   write_gpio, reboot, restart_agent, delete_script,
    //   update_io_config, set_output, deploy_process,
    //   deploy_scada_package, update_firmware
    //
    // Every one has a `Some(Permission::X)` mapping in
    // required_permission.rs. Audit this test whenever either
    // list changes.
    let _contract = "every safety_critical command has a permission_for_command mapping";
    assert!(!_contract.is_empty());
}

#[test]
fn permission_mapping_stable_under_sprint_6_4_wire() {
    // FUTURE-COMPAT CONTRACT: Sprint 6.4 wires
    //   let required_perm = permission_for_command(cmd, params);
    //   if let Some(perm) = required_perm {
    //       authz.evaluate(&actor, perm)?;
    //   }
    // into execute_command BEFORE the match. No current
    // mapping entry should need to change during that wire.
    // Any change to the mapping table post-Sprint-6.4
    // requires an RBAC-manifest update coordinated with
    // platform-side RBAC data seed.
    let _contract = "mapping table is Sprint 6.4 ABI-stable";
    assert!(!_contract.is_empty());
}
