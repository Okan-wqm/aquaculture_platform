//! # Mutating-commands list — signature-required allowlist (plan §4.10)
//!
//! In `SignatureMode::Enforcing`, only commands in [`MUTATING_COMMANDS`]
//! REQUIRE a valid signed envelope. Read-only commands (health checks,
//! telemetry queries, introspection) are allowed unsigned in all modes
//! because they carry no authority.
//!
//! This list is the **edge-side** canonical set of mutating command names.
//! The cloud-side command signer uses the same list; if the edge accepts
//! an unsigned command that the cloud would have signed, that's an
//! asymmetry bug caught by the contract tests (Faz 9 scope).
//!
//! **Stability:** this list is a policy surface. Adding a command here
//! means an existing deployment can no longer execute that command without
//! the cloud signer being updated first (rollout order: signer FIRST, then
//! edge). Removing from the list weakens the signature gate.

/// Sorted list of mutating command names — binary search compatible.
/// Keep lexicographically sorted; the `is_mutating` predicate uses
/// `slice::binary_search` which requires sort order.
pub const MUTATING_COMMANDS: &[&str] = &[
    "apply_policy",
    "deploy_firmware",
    "deploy_program",
    "failover_force",
    "failover_recover",
    "force_value",
    "manage_license",
    "reboot",
    "refresh_license",
    "restart_agent",
    "rollback_firmware",
    "rollback_program",
    "rotate_master_key",
    "safe_state_clear",
    "safe_state_trigger",
    "set_log_level",
    "unforce_all",
    "unforce_value",
    "update_policy",
    "write_gpio",
    "write_i2c",
    "write_modbus",
    "write_opcua",
    "write_pwm",
    "write_spi",
    "write_tag",
];

/// Return true if `cmd_name` requires a valid ed25519-signed envelope
/// under `SignatureMode::Enforcing`. Runs in O(log N) via binary search.
pub fn is_mutating(cmd_name: &str) -> bool {
    MUTATING_COMMANDS.binary_search(&cmd_name).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WHY: List MUST be lexicographically sorted for binary_search to work.
    ///      A future unsorted addition would silently break `is_mutating`
    ///      for later commands in the sort order.
    #[test]
    fn mutating_commands_is_sorted() {
        for w in MUTATING_COMMANDS.windows(2) {
            assert!(w[0] < w[1], "not sorted: {} >= {}", w[0], w[1]);
        }
    }

    /// WHY: No duplicate entries.
    #[test]
    fn mutating_commands_has_no_duplicates() {
        for w in MUTATING_COMMANDS.windows(2) {
            assert_ne!(w[0], w[1], "duplicate: {}", w[0]);
        }
    }

    /// WHY: Known mutating commands return true.
    #[test]
    fn is_mutating_returns_true_for_known_mutating_commands() {
        for cmd in &[
            "write_tag",
            "force_value",
            "deploy_program",
            "rotate_master_key",
            "safe_state_trigger",
        ] {
            assert!(is_mutating(cmd), "{} must be mutating", cmd);
        }
    }

    /// WHY: Read-only + unknown commands return false.
    #[test]
    fn is_mutating_returns_false_for_read_only_and_unknown_commands() {
        for cmd in &[
            "ping",
            "health_check",
            "read_tag",
            "list_forces",
            "get_config",
            "nonexistent_command",
            "", // empty string
        ] {
            assert!(!is_mutating(cmd), "{} must NOT be mutating", cmd);
        }
    }

    /// WHY: Case sensitivity — "Write_Tag" is NOT "write_tag".
    #[test]
    fn is_mutating_is_case_sensitive() {
        assert!(is_mutating("write_tag"));
        assert!(!is_mutating("Write_Tag"));
        assert!(!is_mutating("WRITE_TAG"));
    }

    /// WHY: Count pin — catches accidental additions/removals. If you
    ///      intentionally change the list size, update this number AND
    ///      document the change in the commit message.
    #[test]
    fn mutating_commands_count_is_pinned() {
        assert_eq!(MUTATING_COMMANDS.len(), 26);
    }
}
