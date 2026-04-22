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

impl CommandHandler {
    /// Deploy an IEC 61131-3 program.
    ///
    /// Sequence:
    /// 1. Validate program definition (function-block count,
    ///    scan_cycle bounds).
    /// 2. Save previous version for rollback.
    /// 3. Deploy script portion to ScriptStorage.
    /// 4. Persist program state to disk (atomic tmp+rename).
    /// 5. Engine picks up FB definitions on next reload.
    ///
    /// If step 4 fails after step 3 succeeded, the script is
    /// rolled back (removed from ScriptStorage) to maintain
    /// deploy atomicity. A CRITICAL log surfaces if the rollback
    /// itself fails (operator intervention required).
    pub(super) async fn cmd_deploy_program(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing deploy_program command");

        // Batch 142 Faz 7 wire: effective limits are the
        // intersection of static operator config +
        // license tier caps. `min(config.max, license.max)`
        // for upper bounds, `max(config.min, license.min)`
        // for lower bounds. Neither can bypass the other —
        // license cannot be overridden by loose config;
        // config cannot be overridden by permissive
        // license.
        //
        // Error surfaces which side gated (config vs
        // license) for operator visibility — an operator
        // on PROFESSIONAL tier who tightens config to
        // max_function_blocks=4 needs to know their
        // deploy rejection is a CONFIG choice, not a
        // license limit.
        let (config_max_fbs, config_min_scan, config_max_scan, license) = {
            let state = self.state.read().await;
            (
                state.config.scripting.max_function_blocks,
                state.config.scripting.min_scan_cycle_ms,
                state.config.scripting.max_scan_cycle_ms,
                state.license.clone(),
            )
        };
        let eff = compute_effective_deploy_limits(
            config_max_fbs,
            config_min_scan,
            license.max_fb_instances,
            license.min_scan_cycle_ms,
        );

        let program: ProgramDefinition = match serde_json::from_value(params.clone()) {
            Ok(p) => p,
            Err(e) => {
                error!("Failed to parse program definition: {}", e);
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid program definition: {}", e)),
                );
            }
        };

        if program.function_blocks.len() > eff.effective_max_fbs {
            let gated_by = if eff.fb_gated_by_license {
                format!("license tier={:?}", license.tier)
            } else {
                "scripting config".to_string()
            };
            return (
                false,
                json!(null),
                Some(format!(
                    "Too many function blocks: {} submitted > {} effective max (gated by {}). config_max={}, license_max={}",
                    program.function_blocks.len(),
                    eff.effective_max_fbs,
                    gated_by,
                    config_max_fbs,
                    license.max_fb_instances
                )),
            );
        }

        if program.scan_cycle_ms < eff.effective_min_scan_ms
            || program.scan_cycle_ms > config_max_scan
        {
            let gated_by = if program.scan_cycle_ms < eff.effective_min_scan_ms
                && eff.scan_gated_by_license
            {
                format!("license tier={:?}", license.tier)
            } else {
                "scripting config".to_string()
            };
            return (
                false,
                json!(null),
                Some(format!(
                    "Scan cycle {}ms outside effective range [{}ms, {}ms] (gated by {}). config_min={}, license_min={}",
                    program.scan_cycle_ms,
                    eff.effective_min_scan_ms,
                    config_max_scan,
                    gated_by,
                    config_min_scan,
                    license.min_scan_cycle_ms
                )),
            );
        }

        let mut state = self.load_program_state();
        let previous = state.program.take();

        if let Some(prev) = previous {
            if prev.id == program.id {
                state.previous_version = Some(Box::new(prev));
            }
        }

        let script_id = program.script.id.clone();
        if let Err(e) = self.script_storage.add_script(program.script.clone()).await {
            error!("Failed to deploy script: {}", e);
            return (
                false,
                json!(null),
                Some(format!("Failed to deploy script: {}", e)),
            );
        }

        state.program = Some(program.clone());
        state.deployed_at = Some(Utc::now().to_rfc3339());

        // v1.3.3: rollback-on-persist-failure guarantees deploy
        // atomicity. Partial deploy (script in storage + program
        // state not persisted) would leave an inconsistent
        // system on next boot.
        if let Err(e) = self.save_program_state(&state) {
            error!("Failed to save program state: {}", e);

            if let Err(rollback_err) = self.script_storage.delete(&script_id).await {
                error!(
                    "CRITICAL: Failed to rollback script deployment after state save failure: {}. \
                    System may be in inconsistent state - manual intervention required.",
                    rollback_err
                );
            } else {
                warn!("Rolled back script deployment due to state save failure");
            }

            return (
                false,
                json!(null),
                Some(format!("Failed to persist program (rolled back): {}", e)),
            );
        }

        info!(
            program_id = %program.id,
            program_name = %program.name,
            version = program.version,
            fb_count = program.function_blocks.len(),
            execution_mode = ?program.execution_mode,
            "Program deployed successfully"
        );

        (
            true,
            json!({
                "id": program.id,
                "name": program.name,
                "version": program.version,
                "functionBlockCount": program.function_blocks.len(),
                "executionMode": format!("{:?}", program.execution_mode),
                "scanCycleMs": program.scan_cycle_ms,
                "message": "Program deployed successfully. Engine will reload on next cycle."
            }),
            None,
        )
    }

    /// Get currently deployed program metadata.
    pub(super) async fn cmd_get_program(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_program command");

        let state = self.load_program_state();

        match state.program {
            Some(program) => (
                true,
                json!({
                    "id": program.id,
                    "name": program.name,
                    "version": program.version,
                    "description": program.description,
                    "executionMode": format!("{:?}", program.execution_mode),
                    "scanCycleMs": program.scan_cycle_ms,
                    "functionBlockCount": program.function_blocks.len(),
                    "functionBlocks": program.function_blocks.iter()
                        .map(|fb| json!({
                            "id": fb.id,
                            "type": fb.fb_type
                        }))
                        .collect::<Vec<_>>(),
                    "deployedAt": state.deployed_at,
                    "hasPreviousVersion": state.previous_version.is_some()
                }),
                None,
            ),
            None => (
                true,
                json!({
                    "program": null,
                    "message": "No program deployed"
                }),
                None,
            ),
        }
    }

    /// Rollback to previous program version.
    ///
    /// Clears the previous_version slot after successful
    /// rollback — cannot rollback twice (the new state has no
    /// "previous previous"). This is deliberate: a multi-step
    /// rollback surface would require an audit trail beyond the
    /// current program.json format.
    pub(super) async fn cmd_rollback_program(&mut self) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing rollback_program command");

        let mut state = self.load_program_state();

        let previous = match state.previous_version.take() {
            Some(prev) => *prev,
            None => {
                return (
                    false,
                    json!(null),
                    Some("No previous version available for rollback".to_string()),
                );
            }
        };

        let prev_id = previous.id.clone();
        let prev_name = previous.name.clone();
        let prev_version = previous.version;

        if let Err(e) = self
            .script_storage
            .add_script(previous.script.clone())
            .await
        {
            error!("Rollback failed - script deployment error: {}", e);
            return (false, json!(null), Some(format!("Rollback failed: {}", e)));
        }

        state.program = Some(previous);
        state.deployed_at = Some(Utc::now().to_rfc3339());
        state.previous_version = None;

        if let Err(e) = self.save_program_state(&state) {
            error!("Rollback state save failed: {}", e);
            return (
                false,
                json!(null),
                Some(format!("Rollback state save failed: {}", e)),
            );
        }

        info!(
            program_id = %prev_id,
            version = prev_version,
            "Rolled back to previous version"
        );

        (
            true,
            json!({
                "id": prev_id,
                "name": prev_name,
                "version": prev_version,
                "message": "Rolled back to previous version successfully"
            }),
            None,
        )
    }

    /// Validate IEC 61131-3 Structured Text code.
    ///
    /// CPU-intensive parsing runs on tokio's blocking thread pool
    /// with a 60-second timeout. 1MB source cap + AST strip from
    /// response prevent DoS vectors:
    /// - Source cap blocks a pathologically large input from
    ///   consuming arbitrary parser memory.
    /// - Timeout bounds parser CPU regardless of source complexity.
    /// - AST strip prevents MQTT payload blow-up (AST can be MB
    ///   for large programs; would exceed broker limits).
    pub(super) async fn cmd_validate_st(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let source = match params.get("source").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                return (
                    false,
                    json!({"valid": false}),
                    Some("Missing 'source' parameter".to_string()),
                );
            }
        };

        const MAX_SOURCE_LEN: usize = 1_000_000; // 1MB
        if source.len() > MAX_SOURCE_LEN {
            return (
                false,
                json!({
                    "valid": false,
                    "errors": [{
                        "message": format!("Source too large: {} bytes (max {})", source.len(), MAX_SOURCE_LEN)
                    }]
                }),
                Some("Source code exceeds maximum size".to_string()),
            );
        }

        let source_owned = source.to_string();
        let validation_future = tokio::task::spawn_blocking(move || {
            let mut result = validate_st(&source_owned);
            // AST strip: MQTT payload size bound.
            result.ast = None;
            result
        });

        let result = match tokio::time::timeout(Duration::from_secs(60), validation_future).await {
            Err(_) => {
                return (
                    false,
                    json!({"valid": false}),
                    Some("ST validation timed out after 60s".to_string()),
                );
            }
            Ok(Err(e)) => {
                return (
                    false,
                    json!({"valid": false}),
                    Some(format!("Validation task failed: {}", e)),
                );
            }
            Ok(Ok(r)) => r,
        };

        let success = result.valid;

        (
            success,
            serde_json::to_value(&result).unwrap_or(json!({"valid": false})),
            if success {
                None
            } else {
                Some(format!("{} error(s) found", result.errors.len()))
            },
        )
    }

    /// Load program state from disk.
    ///
    /// v1.2.6: Added error logging to prevent silent data loss.
    /// v1.3.3: Added backup of corrupted files for forensic
    /// analysis.
    pub(super) fn load_program_state(&self) -> ProgramState {
        match fs::read_to_string(&self.program_state_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(state) => state,
                Err(e) => {
                    error!(
                        path = ?self.program_state_path,
                        error = %e,
                        "Failed to parse program state - file may be corrupted"
                    );

                    let backup_path = format!(
                        "{}.corrupted.{}",
                        self.program_state_path.display(),
                        chrono::Utc::now().format("%Y%m%d_%H%M%S")
                    );
                    match fs::copy(&self.program_state_path, &backup_path) {
                        Ok(_) => {
                            warn!(
                                "Corrupted program state backed up to: {}. \
                                Using default state. Manual investigation recommended.",
                                backup_path
                            );
                        }
                        Err(backup_err) => {
                            error!(
                                "Failed to backup corrupted program state: {}. \
                                Original file at: {:?}. DATA MAY BE LOST.",
                                backup_err, self.program_state_path
                            );
                        }
                    }

                    ProgramState::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!(
                    path = ?self.program_state_path,
                    "Program state file not found - using default"
                );
                ProgramState::default()
            }
            Err(e) => {
                warn!(
                    path = ?self.program_state_path,
                    error = %e,
                    "Failed to read program state file - using default"
                );
                ProgramState::default()
            }
        }
    }

    /// Save program state to disk.
    ///
    /// v2.3: Atomic write (tmp + rename) to prevent corruption on
    /// power loss. A half-written file on power-loss would break
    /// load_program_state's parse path on next boot; atomic
    /// rename keeps the old file valid until the new file is
    /// fully flushed.
    pub(super) fn save_program_state(&self, state: &ProgramState) -> anyhow::Result<()> {
        if let Some(parent) = self.program_state_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(state)?;

        let tmp_path = self.program_state_path.with_extension("json.tmp");
        fs::write(&tmp_path, &content)?;
        fs::rename(&tmp_path, &self.program_state_path)?;

        debug!(path = ?self.program_state_path, "Program state saved (atomic)");
        Ok(())
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
