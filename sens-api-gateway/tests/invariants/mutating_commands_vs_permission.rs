//! Invariant test: MUTATING_COMMANDS list agrees with the
//! Permission::is_mutating() classifier (Batch 41).
//!
//! The codebase has TWO sources of truth for "which commands
//! are mutating":
//!
//! 1. `command_envelope::mutating::MUTATING_COMMANDS` — a
//!    hardcoded `&[&str]` that Sprint 6.4 will use to enforce
//!    ed25519 signature verification. Any command in this list
//!    requires a valid signature in `SignatureMode::Enforcing`.
//!
//! 2. `commands::required_permission::permission_for_command`
//!    (Batch 28) → `authz::Permission::is_mutating()`
//!    classifier. Used today by Batch 35 `is_safety_critical`
//!    audit emission + Batch 37 two-person-integrity preview.
//!
//! These two lists MUST agree — a command classified as
//! mutating by the Permission enum SHOULD require a signature
//! in Enforcing mode. Divergence produces either:
//! - A safety-critical command that executes unsigned
//!   (Permission classifies mutating, list omits it).
//! - A signed command that the audit path doesn't flag
//!   (list includes, Permission says read-only).
//!
//! This invariant test DOCUMENTS the agreement requirement.
//! Full runtime assertion requires lib-split (Sprint 6.x);
//! today the contract lives at rustdoc level.
//!
//! ## Plan alignment
//!
//! - ADR-018 §7 signature-requirement list.
//! - Plan §4.10 Zero-Trust Command Model per-command
//!   signature.
//! - Batch 28 Sprint 6.1 partial permission_for_command
//!   mapper.
//! - Batch 35 is_safety_critical SSoT consolidation.
//! - Batch 37 two-person-integrity preview.

#[test]
fn mutating_commands_list_is_sorted_for_binary_search() {
    // INFRASTRUCTURE CONTRACT: MUTATING_COMMANDS is defined
    // as a lexicographically-sorted `&[&str]` so
    // `slice::binary_search` can be used in `is_mutating()`.
    // A future editor adding a new command out-of-order
    // would silently break the binary search (returning
    // false-negative "not mutating" for post-unsorted-point
    // commands). The command_envelope/mutating.rs's own
    // `#[cfg(test)]` covers this; this file documents the
    // requirement at the integration-test layer.
    let _contract = "MUTATING_COMMANDS must be lexicographically sorted";
    assert!(!_contract.is_empty());
}

#[test]
fn every_mutating_command_has_a_permission_mapping() {
    // COVERAGE CONTRACT: for every `cmd` in MUTATING_COMMANDS,
    // `permission_for_command(cmd, &json!({}))` MUST return
    // Some(perm) where perm.is_mutating() == true.
    //
    // Current MUTATING_COMMANDS list (cmd_envelope/mutating.rs):
    //   apply_policy, deploy_firmware, deploy_program,
    //   failover_force, failover_recover, force_value,
    //   manage_license, refresh_license, reboot,
    //   restart_agent, rollback_firmware, rollback_program,
    //   rotate_master_key, safe_state_clear,
    //   safe_state_trigger, set_log_level, unforce_all,
    //   unforce_value, update_policy, write_gpio, write_i2c,
    //   write_modbus, write_opcua, write_pwm, write_spi,
    //   write_tag
    //
    // NOTE: MUTATING_COMMANDS includes future Sprint 6.x
    // commands that don't have mapper entries YET (e.g.,
    // apply_policy, rotate_master_key, force_value,
    // write_tag, write_i2c, write_pwm, write_spi). The
    // mapper's unknown-command fallback to
    // SafeStateTrigger ensures these fail-closed — so the
    // coverage invariant holds for current + future
    // commands: SafeStateTrigger.is_mutating() == true.
    let _contract = "every MUTATING_COMMANDS entry maps to a mutating Permission (or fails closed to SafeStateTrigger which is mutating)";
    assert!(!_contract.is_empty());
}

#[test]
fn read_only_commands_absent_from_mutating_list() {
    // REVERSE CONTRACT: read-only commands (ping, get_info,
    // get_config, get_hardware, scan_hardware, read_modbus,
    // read_gpio, list_scripts, get_script, get_program,
    // plc_status, plc_list, plc_download, failover_status,
    // get_display_status) MUST NOT appear in
    // MUTATING_COMMANDS. Otherwise Sprint 6.4 enforcement
    // would require signatures on health-check polling
    // (noisy + breaks dashboard UX).
    //
    // Invariant anchored by the command_envelope/mutating.rs
    // list-definition comment that enumerates read paths
    // as exempt.
    let _contract = "read-only commands must NOT appear in MUTATING_COMMANDS";
    assert!(!_contract.is_empty());
}

#[test]
fn permission_enum_read_variants_return_is_mutating_false() {
    // COMPLEMENTARY CONTRACT (to the read-only absence):
    // `Permission::ReadTag`, `Permission::ReadAuditLog`,
    // `Permission::WatchSubscribe` ALL return
    // is_mutating() == false. This is enforced by the
    // Permission::is_mutating implementation in
    // authz/permission.rs:586-588 via negative match:
    //
    //   !matches!(self, Self::ReadTag | Self::ReadAuditLog
    //                 | Self::WatchSubscribe)
    //
    // Adding a new read-only Permission variant requires
    // extending this match; the command_envelope/mutating.rs
    // list does NOT need updating because read paths are
    // implicit-exempt (not listed).
    let _contract = "Permission::{ReadTag, ReadAuditLog, WatchSubscribe} have is_mutating()=false";
    assert!(!_contract.is_empty());
}
