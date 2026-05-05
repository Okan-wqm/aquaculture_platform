//! Script CRUD command handlers (Batch 20e ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain split. Script commands operate
//! on `ScriptStorage` (AppState singleton, v2.2) — a well-bounded
//! dependency separate from IEC 61131-3 Program / PLC / IO
//! handlers. Extracting these surfaces the script-storage lifecycle
//! (add / delete / enable / disable) as a cohesive domain.
//!
//! WHAT: 6 handlers moved from mod.rs as `impl CommandHandler`
//! block:
//! - `cmd_list_scripts` — list all scripts with summary metadata.
//! - `cmd_get_script` — retrieve full script definition + runtime
//!   state for a specific id.
//! - `cmd_deploy_script` — add-or-update a script. Parses
//!   `ScriptDefinition` from params JSON; returns operator-visible
//!   parse error on malformed input.
//! - `cmd_delete_script` — remove a script by id. Distinguishes
//!   "not found" (404 semantics) from "delete failed"
//!   (storage-layer error).
//! - `cmd_enable_script` / `cmd_disable_script` — toggle the
//!   `enabled` flag without affecting the script body.
//!
//! SECURITY: Every operator-visible script_id path routes through
//! `sanitize_for_log()` to neutralize log-injection vectors if an
//! attacker supplies a malformed id. The storage layer itself
//! rejects invalid ids at `add_script` time; sanitize_for_log is
//! defense-in-depth for the log path.
//!
//! STORAGE COUPLING: `self.script_storage` is the v2.2 AppState-
//! shared singleton. Pre-v2.2 each CommandHandler held its own
//! ScriptStorage instance which caused deploy-vs-execute races
//! (scripts deployed on the command path weren't visible to the
//! execution path). All 6 handlers now route through the shared
//! storage.

use serde_json::{Value, json};
use tracing::{error, info};

use crate::scripting::ScriptDefinition;
use crate::security::sanitize_for_log;

use super::CommandHandler;

impl CommandHandler {
    /// List all scripts (v2.2 - uses shared storage, v1.2.0 - async API)
    pub(super) async fn cmd_list_scripts(&self) -> (bool, Value, Option<String>) {
        info!("Executing list_scripts command");

        let all_scripts = self.script_storage.get_all().await;
        let scripts: Vec<Value> = all_scripts
            .iter()
            .map(|s| {
                json!({
                    "id": s.definition.id,
                    "name": s.definition.name,
                    "description": s.definition.description,
                    "enabled": s.definition.enabled,
                    "status": format!("{:?}", s.status).to_lowercase(),
                    "triggers": s.definition.triggers.len(),
                    "actions": s.definition.actions.len(),
                    "last_run": s.last_run,
                    "last_result": s.last_result,
                    "error_count": s.error_count
                })
            })
            .collect();

        (
            true,
            json!({"scripts": scripts, "count": scripts.len()}),
            None,
        )
    }

    /// Get a specific script (v1.2.0 - async API)
    pub(super) async fn cmd_get_script(&self, params: &Value) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        info!(
            "Executing get_script command for: {}",
            sanitize_for_log(script_id)
        );

        match self.script_storage.get(script_id).await {
            Some(script) => {
                let data = json!({
                    "id": script.definition.id,
                    "name": script.definition.name,
                    "description": script.definition.description,
                    "version": script.definition.version,
                    "enabled": script.definition.enabled,
                    "status": format!("{:?}", script.status).to_lowercase(),
                    "triggers": script.definition.triggers,
                    "conditions": script.definition.conditions,
                    "actions": script.definition.actions,
                    "on_error": script.definition.on_error,
                    "last_run": script.last_run,
                    "last_result": script.last_result,
                    "error_count": script.error_count,
                    "created_at": script.created_at,
                    "updated_at": script.updated_at
                });
                (true, data, None)
            }
            None => (
                false,
                json!(null),
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
        }
    }

    /// Deploy (add/update) a script (v1.2.0 - async API)
    pub(super) async fn cmd_deploy_script(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing deploy_script command");

        let definition: ScriptDefinition = match serde_json::from_value(params.clone()) {
            Ok(def) => def,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid script definition: {}", e)),
                );
            }
        };

        let script_id = definition.id.clone();
        let script_name = definition.name.clone();

        match self.script_storage.add_script(definition).await {
            Ok(()) => {
                info!("Script deployed: {} ({})", script_name, script_id);
                (
                    true,
                    json!({
                        "id": script_id,
                        "name": script_name,
                        "message": "Script deployed successfully"
                    }),
                    None,
                )
            }
            Err(e) => {
                error!("Failed to deploy script: {}", e);
                (false, json!(null), Some(format!("Deploy failed: {}", e)))
            }
        }
    }

    /// Delete a script (v1.2.0 - async API)
    pub(super) async fn cmd_delete_script(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        info!(
            "Executing delete_script command for: {}",
            sanitize_for_log(script_id)
        );

        match self.script_storage.delete(script_id).await {
            Ok(true) => (true, json!({"id": script_id, "deleted": true}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
            Err(e) => (false, json!(null), Some(format!("Delete failed: {}", e))),
        }
    }

    /// Enable a script (v1.2.0 - async API)
    pub(super) async fn cmd_enable_script(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        info!(
            "Executing enable_script command for: {}",
            sanitize_for_log(script_id)
        );

        match self.script_storage.enable(script_id).await {
            Ok(true) => (true, json!({"id": script_id, "enabled": true}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
            Err(e) => (false, json!(null), Some(format!("Enable failed: {}", e))),
        }
    }

    /// Disable a script (v1.2.0 - async API)
    pub(super) async fn cmd_disable_script(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let script_id = match params.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'id' parameter".to_string()),
                );
            }
        };

        info!(
            "Executing disable_script command for: {}",
            sanitize_for_log(script_id)
        );

        match self.script_storage.disable(script_id).await {
            Ok(true) => (true, json!({"id": script_id, "enabled": false}), None),
            Ok(false) => (
                false,
                json!(null),
                Some(format!(
                    "Script '{}' not found",
                    sanitize_for_log(script_id)
                )),
            ),
            Err(e) => (false, json!(null), Some(format!("Disable failed: {}", e))),
        }
    }
}
