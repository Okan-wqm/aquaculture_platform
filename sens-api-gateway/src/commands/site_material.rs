//! The response of a command whose target is signed site material in the
//! Suderra OS profile (ADR-048 DEC-4.12).
//!
//! On Suderra OS the I/O map, the fieldbus inventory, the RBAC manifest and
//! `config.yaml` are parts of the signed `suderra.site-config.v1` statement
//! the root installer writes into the read-only site directory. The agent
//! cannot change them: in P0 the only path is re-provisioning in
//! MAINTENANCE, and in P1 the root update worker's `kind=site-config`
//! request. A cloud command that would rewrite one of them is therefore
//! refused with an `unsupported` result instead of being applied in memory
//! and lost — or half-applied — at the next restart.

use serde_json::{Value, json};
use tracing::warn;

/// `(success=false, details, error)` for `command`, whose target `what` is
/// site material.
pub(super) fn unsupported(command: &str, what: &str) -> (bool, Value, Option<String>) {
    warn!(
        "Rejecting {}: unsupported in the suderra-os profile; {} is signed site material \
         (ADR-048 DEC-4.12)",
        command, what
    );
    (
        false,
        json!({ "reason": "unsupported", "site_material": what }),
        Some(format!(
            "unsupported: {command} cannot change {what} in the suderra-os profile; it is signed \
             site material changed only by re-provisioning (ADR-048 DEC-4.12)"
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_result_is_a_failure_that_names_the_reason() {
        let (ok, details, error) = unsupported("update_io_config", "the I/O map");
        assert!(!ok);
        assert_eq!(details["reason"], "unsupported");
        assert!(
            error
                .as_deref()
                .unwrap_or_default()
                .starts_with("unsupported:")
        );
    }
}
