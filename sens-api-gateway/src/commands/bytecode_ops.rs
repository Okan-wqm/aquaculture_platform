//! Bytecode program operator commands — Batch 173 Faz 3
//! (plan R-1).
//!
//! ## WHY
//!
//! Batch 167 gave operators a way to DEPLOY signed
//! bytecode (`cmd_deploy_bytecode_program`). Batch 173
//! rounds out the operator surface with the three
//! control commands the cloud UI needs:
//!
//! - `list_bytecode_programs` — enumerate every deployed
//!   program for inspection (cloud UI shows table of
//!   deployed automations).
//! - `disable_bytecode_program` — pause execution of a
//!   program without removing it. Scan cycle skips it
//!   on the next tick. Useful for diagnostics or
//!   planned outages.
//! - `enable_bytecode_program` — re-enable a paused
//!   program.
//! - `delete_bytecode_program` — permanently remove a
//!   program from the in-memory registry + SQLCipher
//!   store.
//!
//! All four commands are tenant-gated: `AppState.tenant
//! _id` must match `ProgramEntry.tenant_id` — defense
//! in depth even if the authz manifest layer changes.
//!
//! ## MQTT command params shape
//!
//! `list_bytecode_programs`: no params needed, returns
//! the list.
//!
//! `disable` / `enable` / `delete`: `{ "program_id":
//! "..." }`.

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::security::sanitize_for_log;

impl CommandHandler {
    /// List every deployed bytecode program for the
    /// agent's tenant. Platform-scoped programs
    /// (tenant_id=None) are included too.
    pub(super) async fn cmd_list_bytecode_programs(
        &self,
        _params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing list_bytecode_programs command (Faz 3 Batch 173)");

        let (registry, expected_tenant) = {
            let state = self.state.read().await;
            (state.bytecode_registry.clone(), state.tenant_id.clone())
        };

        let entries = registry.list().await;

        // Filter to the agent's tenant + platform-scoped
        // entries. Defense-in-depth — the registry SHOULD
        // already only contain this-tenant + platform
        // entries because cross-tenant inserts get
        // rejected at deploy time, but filter here to
        // catch any SQLCipher-seeded-state corner case.
        let summaries: Vec<Value> = entries
            .into_iter()
            .filter(|entry| match (&entry.tenant_id, &expected_tenant) {
                (Some(et), Some(at)) => et == at,
                (None, _) => true, // platform-scoped
                _ => false,
            })
            .map(|entry| {
                json!({
                    "program_id": entry.program_id,
                    "program_name": entry.bytecode.program_name,
                    "tenant_id": entry.tenant_id,
                    "policy_version": entry.policy_version,
                    "enabled": entry.enabled,
                    "deployed_at_unix_secs": entry.deployed_at.timestamp(),
                    "allowed_write_tags_count":
                        entry.bytecode.allowed_write_tags.len(),
                    "opcode_count": entry.bytecode.opcodes.len(),
                })
            })
            .collect();

        (
            true,
            json!({
                "programs": summaries,
            }),
            None,
        )
    }

    /// Disable a program — it stays in the registry +
    /// SQLCipher store but the scan-cycle orchestrator
    /// skips it.
    pub(super) async fn cmd_disable_bytecode_program(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        self.set_enabled_bytecode_program(params, false, "disable_bytecode_program")
            .await
    }

    /// Re-enable a previously disabled program. Scan
    /// cycle picks it up on the next tick.
    pub(super) async fn cmd_enable_bytecode_program(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        self.set_enabled_bytecode_program(params, true, "enable_bytecode_program")
            .await
    }

    /// Shared implementation for enable + disable.
    async fn set_enabled_bytecode_program(
        &self,
        params: &Value,
        enabled: bool,
        cmd_label: &str,
    ) -> (bool, Value, Option<String>) {
        info!("Executing {} command (Faz 3 Batch 173)", cmd_label);

        let program_id = match extract_program_id(params, cmd_label) {
            Ok(id) => id,
            Err(msg) => return (false, json!(null), Some(msg)),
        };

        let (registry, store, expected_tenant) = {
            let state = self.state.read().await;
            (
                state.bytecode_registry.clone(),
                state.bytecode_registry_store.clone(),
                state.tenant_id.clone(),
            )
        };

        // Tenant gate — verify the entry belongs to this
        // agent's tenant before mutating state.
        match registry.get(&program_id).await {
            Some(entry) => {
                if !tenant_match(&entry.tenant_id, &expected_tenant) {
                    return (
                        false,
                        json!(null),
                        Some(format!(
                            "{}: program `{}` belongs to a different tenant",
                            cmd_label,
                            sanitize_for_log(&program_id)
                        )),
                    );
                }
            }
            None => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "{}: program `{}` not found",
                        cmd_label,
                        sanitize_for_log(&program_id)
                    )),
                );
            }
        }

        // Registry toggle.
        if let Err(e) = registry.set_enabled(&program_id, enabled).await {
            return (
                false,
                json!(null),
                Some(format!(
                    "{}: registry set_enabled failed: {}",
                    cmd_label,
                    sanitize_for_log(&e.to_string())
                )),
            );
        }

        // Persist the new enabled state through the
        // store when present — best-effort: a store
        // failure logs + returns success because the
        // in-memory change IS live.
        let persisted =
            persist_enabled_change(&registry, store.as_ref(), &program_id, cmd_label).await;

        info!(
            "{}: program_id={} enabled={} persisted={}",
            cmd_label,
            sanitize_for_log(&program_id),
            enabled,
            persisted
        );
        (
            true,
            json!({
                "program_id": program_id,
                "enabled": enabled,
                "persisted": persisted,
            }),
            None,
        )
    }

    /// Permanently remove a program from the registry +
    /// store.
    pub(super) async fn cmd_delete_bytecode_program(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing delete_bytecode_program command (Faz 3 Batch 173)");

        let program_id = match extract_program_id(params, "delete_bytecode_program") {
            Ok(id) => id,
            Err(msg) => return (false, json!(null), Some(msg)),
        };

        let (registry, store, expected_tenant) = {
            let state = self.state.read().await;
            (
                state.bytecode_registry.clone(),
                state.bytecode_registry_store.clone(),
                state.tenant_id.clone(),
            )
        };

        // Tenant + existence gate BEFORE mutation.
        match registry.get(&program_id).await {
            Some(entry) => {
                if !tenant_match(&entry.tenant_id, &expected_tenant) {
                    return (
                        false,
                        json!(null),
                        Some(format!(
                            "delete_bytecode_program: program `{}` belongs to a different tenant",
                            sanitize_for_log(&program_id)
                        )),
                    );
                }
            }
            None => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "delete_bytecode_program: program `{}` not found",
                        sanitize_for_log(&program_id)
                    )),
                );
            }
        }

        if let Err(e) = registry.remove(&program_id).await {
            return (
                false,
                json!(null),
                Some(format!(
                    "delete_bytecode_program: registry remove failed: {}",
                    sanitize_for_log(&e.to_string())
                )),
            );
        }

        // Delete from the store too. Best-effort — store
        // failure logs at warn + returns success because
        // the in-memory removal IS authoritative for the
        // current boot; the stale SQLCipher row gets
        // filtered next reboot via the tenant gate in
        // `load_into_registry`.
        let persisted = if let Some(store_ref) = store.as_ref() {
            match store_ref.delete(&program_id) {
                Ok(()) => true,
                Err(e) => {
                    warn!(
                        "delete_bytecode_program: registry remove OK but store delete failed for {}: {}",
                        sanitize_for_log(&program_id),
                        e
                    );
                    false
                }
            }
        } else {
            false
        };

        info!(
            "delete_bytecode_program: program_id={} persisted={}",
            sanitize_for_log(&program_id),
            persisted
        );
        (
            true,
            json!({
                "program_id": program_id,
                "deleted": true,
                "persisted": persisted,
            }),
            None,
        )
    }
}

/// Param helper: extract the `program_id` string or
/// return an operator-visible error message.
fn extract_program_id(params: &Value, cmd_label: &str) -> Result<String, String> {
    match params.get("program_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(format!(
            "{}: missing or empty required param `program_id` (string)",
            cmd_label
        )),
    }
}

/// Tenant gate: matches when both are the same tenant,
/// OR when the entry is platform-scoped (None). Any
/// mismatch rejects.
fn tenant_match(entry_tenant: &Option<String>, agent_tenant: &Option<String>) -> bool {
    match (entry_tenant, agent_tenant) {
        (Some(a), Some(b)) => a == b,
        (None, _) => true, // platform-scoped entries are visible to all tenants
        _ => false,
    }
}

/// Read the mutated entry back from the registry +
/// persist through the store. Same best-effort policy
/// as the deploy save-back: log warn on failure, return
/// false — operator sees `persisted: false` in the
/// response + investigates via logs.
async fn persist_enabled_change(
    registry: &crate::scripting::bytecode_registry::BytecodeProgramRegistry,
    store: Option<
        &std::sync::Arc<crate::scripting::bytecode_registry_store::BytecodeRegistryStore>,
    >,
    program_id: &str,
    cmd_label: &str,
) -> bool {
    let Some(store_ref) = store else { return false };
    let Some(entry) = registry.get(program_id).await else {
        // Rare: set_enabled succeeded but entry vanished
        // before save-back read (concurrent delete race).
        warn!(
            "{}: in-memory toggle OK but entry missing at save-back for `{}`",
            cmd_label,
            sanitize_for_log(program_id)
        );
        return false;
    };
    match store_ref.save(&entry) {
        Ok(()) => true,
        Err(e) => {
            warn!(
                "{}: in-memory toggle OK but store save failed for `{}`: {}",
                cmd_label,
                sanitize_for_log(program_id),
                e
            );
            false
        }
    }
}
