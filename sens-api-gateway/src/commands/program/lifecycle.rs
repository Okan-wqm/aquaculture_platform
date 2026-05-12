//! commands::program::lifecycle
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
//! cmd_get_program / cmd_rollback_program / cmd_validate_st —
//! read-only metadata + previous-version restore +
//! standalone ST source validator. The validator surfaces
//! E100/E110 lex/parse errors via the canonical
//! `crate::st_validator::validate_st` entry point + strips
//! AST from the response (AST can be MB-class for large
//! programs and would blow the broker's payload limit).
//!
//! Method visibility: pub(in crate::commands) so the dispatch
//! table in commands/dispatch_lifecycle.rs can call them while
//! external (non-commands) modules cannot.

use chrono::Utc;
use serde_json::{Value, json};
use std::time::Duration;
use tracing::{error, info};

use crate::st_validator::validate_st;

use super::super::CommandHandler;

impl CommandHandler {
    pub(in crate::commands) async fn cmd_get_program(&self) -> (bool, Value, Option<String>) {
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
    pub(in crate::commands) async fn cmd_rollback_program(
        &mut self,
    ) -> (bool, Value, Option<String>) {
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
    pub(in crate::commands) async fn cmd_validate_st(
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
}
