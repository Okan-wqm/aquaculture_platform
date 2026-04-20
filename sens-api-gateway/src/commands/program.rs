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

        let (max_fbs, min_scan, max_scan) = {
            let state = self.state.read().await;
            (
                state.config.scripting.max_function_blocks,
                state.config.scripting.min_scan_cycle_ms,
                state.config.scripting.max_scan_cycle_ms,
            )
        };

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

        if program.function_blocks.len() > max_fbs {
            return (
                false,
                json!(null),
                Some(format!("Too many function blocks (max {})", max_fbs)),
            );
        }

        if program.scan_cycle_ms < min_scan || program.scan_cycle_ms > max_scan {
            return (
                false,
                json!(null),
                Some(format!(
                    "Scan cycle must be between {}ms and {}ms",
                    min_scan, max_scan
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
