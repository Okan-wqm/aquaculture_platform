//! commands::program::deploy
//!
//! ## Why this module exists (Batch #304 ULTRA-HIGH-013 ceiling)
//!
//! Pre-Batch-#304 commands/program.rs was a single 631-line
//! file that violated the ≤500-line ceiling. Batch #304 split
//! the 4 cmd_program_* handlers + 2 program-state-persistence
//! helpers across 3 sibling files keyed by command-class +
//! kept the EffectiveDeployLimits helper alongside its tests
//! in mod.rs. This file:
//!
//! cmd_deploy_program — deploys a `ProgramDefinition` to the
//! edge with deploy-lock + license-tier gate +
//! rollback-on-failure discipline. License gate uses the
//! stricter-of-both intersection (config + license) via the
//! `compute_effective_deploy_limits` helper exported from
//! the parent mod.rs. Atomic persist via tmp+rename per
//! `save_program_state` in the sibling persistence.rs.
//!
//! Method visibility: pub(in crate::commands) so the dispatch
//! table in commands/dispatch_lifecycle.rs can call them while
//! external (non-commands) modules cannot.

use chrono::Utc;
use serde_json::{Value, json};
use tracing::{error, info, warn};

use super::super::{CommandHandler, ProgramDefinition};
use super::compute_effective_deploy_limits;

impl CommandHandler {
    pub(in crate::commands) async fn cmd_deploy_program(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        self.deploy_program_locked(params).await
    }

    /// Deploy body WITHOUT the deploy lock — the caller MUST hold it.
    /// Split out (Faz 5) so `cmd_deploy_bundle` can apply N programs
    /// atomically under ONE lock acquisition; the tokio Mutex is not
    /// reentrant, so delegating to `cmd_deploy_program` from inside the
    /// bundle apply would deadlock.
    pub(in crate::commands) async fn deploy_program_locked(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
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
            let gated_by =
                if program.scan_cycle_ms < eff.effective_min_scan_ms && eff.scan_gated_by_license {
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
}
