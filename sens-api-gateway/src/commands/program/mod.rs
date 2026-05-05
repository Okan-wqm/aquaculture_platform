//! IEC 61131-3 Program command handlers (Batch 20l ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. This module houses
//! the IEC 61131-3 program lifecycle + Structured Text validator —
//! a cohesive domain bounded by `ProgramDefinition` / `ProgramState`
//! types (defined in mod.rs because they're also used by PLC
//! handlers that stay there until Batch 20m). Program handlers
//! share a deploy_lock + program-state-file persistence pattern;
//! the ST validator is here because it gates deploy_program
//! correctness (operators validate ST source before deploying).
//!
//! WHAT:
//! - `impl CommandHandler` block:
//!   - `cmd_deploy_program` — deploys a `ProgramDefinition` to
//!     the edge. Validates function-block count + scan_cycle
//!     bounds against `config.scripting` limits (plan §5 Faz 7
//!     license-tier enforcement target). Saves previous version
//!     for rollback + delivers the script portion to
//!     ScriptStorage. Atomic persist with rollback-on-failure.
//!   - `cmd_get_program` — reports currently-deployed program
//!     metadata (no function-block internals — those stay
//!     private to the runtime).
//!   - `cmd_rollback_program` — restores previous-version program
//!     + clears the rollback slot (can't rollback twice; the new
//!     state has no "previous previous").
//!   - `cmd_validate_st` — CPU-intensive AST validator wrapped in
//!     spawn_blocking + 60s timeout. 1MB source cap + AST
//!     strip-from-response to bound MQTT payload size.
//! - Module-private helpers:
//!   - `load_program_state` — reads program.json; corrupted-file
//!     backup for forensic analysis per v1.3.3.
//!   - `save_program_state` — atomic tmp+rename write to prevent
//!     power-loss corruption per v2.3.
//!
//! DEPLOY LOCK: `cmd_deploy_program` + `cmd_rollback_program`
//! both acquire `self.deploy_lock.lock().await` — prevents
//! interleaved deploy-and-rollback producing torn state.
//!
//! ROLLBACK-ON-FAILURE: `cmd_deploy_program` deploys the script
//! to ScriptStorage BEFORE persisting program state. If persist
//! fails, the script is rolled back with a CRITICAL log if the
//! rollback itself fails (operator must intervene). This is the
//! tier-1 consistency guarantee — partial deploy is worse than
//! no deploy.
//!
//! ST VALIDATOR SAFETY: 1MB source cap + 60s timeout prevent DoS
//! via pathological parser inputs. AST stripped from response
//! before MQTT publish because AST can be MB for large programs
//! and would blow the broker's payload limit.


// Batch #304 ULTRA-HIGH-013 ceiling extension: program.rs
// (631 lines) split into 4 sub-files. The
// EffectiveDeployLimits + compute_effective_deploy_limits
// helpers stay in mod.rs because:
//   1. They're consumed by the test module below (which
//      validates the stricter-of-both license/config
//      intersection invariant).
//   2. They're consumed by deploy.rs's cmd_deploy_program
//      gate logic — but extracting them into a separate
//      file would split a tightly-cohesive 47-line helper
//      from its sole production caller and its tests, with
//      no architectural payoff.

mod deploy;
mod lifecycle;
mod persistence;

use chrono::Utc;
use serde_json::{Value, json};
use std::fs;
use std::time::Duration;
use tracing::{debug, error, info, warn};

use crate::st_validator::validate_st;

use super::{CommandHandler, ProgramDefinition, ProgramState};

/// Batch 142 Faz 7: stricter-of-both license + config
/// intersection for cmd_deploy_program gates.
///
/// Pure function extracted for unit testability — the
/// CommandHandler body reads from AppState + delegates
/// to this for the actual decision.
///
/// Returns:
/// - `effective_max_fbs` = min(config, license)
/// - `effective_min_scan_ms` = max(config, license)
/// - `fb_gated_by_license`: true if license was the
///   stricter half (used for error message attribution).
/// - `scan_gated_by_license`: same semantic for scan
///   cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct EffectiveDeployLimits {
    pub effective_max_fbs: usize,
    pub effective_min_scan_ms: u64,
    pub fb_gated_by_license: bool,
    pub scan_gated_by_license: bool,
}

pub(super) fn compute_effective_deploy_limits(
    config_max_fbs: usize,
    config_min_scan_ms: u64,
    license_max_fbs: u32,
    license_min_scan_ms: u32,
) -> EffectiveDeployLimits {
    let license_max_fbs_usize = license_max_fbs as usize;
    let license_min_scan_u64 = license_min_scan_ms as u64;

    let effective_max_fbs = config_max_fbs.min(license_max_fbs_usize);
    let effective_min_scan_ms = config_min_scan_ms.max(license_min_scan_u64);

    EffectiveDeployLimits {
        effective_max_fbs,
        effective_min_scan_ms,
        // FB gated by LICENSE iff license is the stricter
        // (smaller) half. Tie goes to license for
        // error-attribution consistency (operator
        // intuition: "my tier limits me").
        fb_gated_by_license: license_max_fbs_usize <= config_max_fbs,
        // Scan-min gated by LICENSE iff license_min is
        // the stricter (larger) floor. Same tie rule.
        scan_gated_by_license: license_min_scan_u64 >= config_min_scan_ms,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_limits_license_stricter_on_both() {
        // STARTER license: fb=8, scan=5000.
        // Config: fb=32, scan=100.
        // License is the stricter half on both → gated by
        // license for both.
        let eff = compute_effective_deploy_limits(32, 100, 8, 5000);
        assert_eq!(eff.effective_max_fbs, 8);
        assert_eq!(eff.effective_min_scan_ms, 5000);
        assert!(eff.fb_gated_by_license);
        assert!(eff.scan_gated_by_license);
    }

    #[test]
    fn effective_limits_config_stricter_on_fb() {
        // ENTERPRISE license: fb=128, scan=100.
        // Config: fb=4, scan=200.
        // Config is stricter on FB (4 < 128); license is
        // stricter on scan (100 < 200 means license floor
        // 100 is LESS restrictive than config floor 200,
        // so config wins for scan too).
        let eff = compute_effective_deploy_limits(4, 200, 128, 100);
        assert_eq!(eff.effective_max_fbs, 4);
        assert_eq!(eff.effective_min_scan_ms, 200);
        assert!(!eff.fb_gated_by_license);
        assert!(!eff.scan_gated_by_license);
    }

    #[test]
    fn effective_limits_mixed() {
        // License: fb=8 (stricter), scan=50 (looser).
        // Config: fb=32 (looser), scan=200 (stricter).
        // FB gated by license, scan gated by config.
        let eff = compute_effective_deploy_limits(32, 200, 8, 50);
        assert_eq!(eff.effective_max_fbs, 8);
        assert_eq!(eff.effective_min_scan_ms, 200);
        assert!(eff.fb_gated_by_license);
        assert!(!eff.scan_gated_by_license);
    }

    #[test]
    fn effective_limits_equal_values_tie_goes_to_license() {
        // Exactly-equal limits: tie-break attribution to
        // license. Operators on tier X who set matching
        // config see "license tier=X" in error messages —
        // consistent with "my tier limits me" intuition.
        let eff = compute_effective_deploy_limits(16, 500, 16, 500);
        assert_eq!(eff.effective_max_fbs, 16);
        assert_eq!(eff.effective_min_scan_ms, 500);
        assert!(eff.fb_gated_by_license);
        assert!(eff.scan_gated_by_license);
    }

    #[test]
    fn effective_limits_conservative_starter_produces_starter_caps() {
        // Plug the Batch 140 conservative() values in.
        use crate::license::EdgeLicenseLimits;
        let c = EdgeLicenseLimits::conservative();
        // Generous config: fb=100, scan=50.
        let eff = compute_effective_deploy_limits(
            100,
            50,
            c.max_fb_instances,
            c.min_scan_cycle_ms,
        );
        // STARTER caps should win.
        assert_eq!(eff.effective_max_fbs, c.max_fb_instances as usize);
        assert_eq!(eff.effective_min_scan_ms, c.min_scan_cycle_ms as u64);
        assert!(eff.fb_gated_by_license);
        assert!(eff.scan_gated_by_license);
    }
}
