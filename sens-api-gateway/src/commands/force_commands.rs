//! Live-debug force commands — Batch 197 Faz 6
//! (plan R-9 item 4).
//!
//! ## WHY
//!
//! Plan §5 Faz 6 item 4 specifies 4 MQTT commands for
//! the live-debug force path:
//!
//! - `force_value { tag_name, value, ttl_secs,
//!   reason }` — applies a force.
//! - `unforce_value { tag_name }` — removes one.
//! - `unforce_all` — drains every active force.
//! - `list_forces` — enumerates active forces.
//!
//! Each handler is a thin adapter over the Batch 194
//! ForceRegistry primitive. The surrounding command
//! infrastructure (envelope_adapter — Batch 68+) has
//! already enforced:
//! - ed25519 signature verify,
//! - jti dedup + TTL replay defense,
//! - authz manifest policy evaluate,
//! - audit pre+post emit (Batch 78+).
//!
//! This module covers items 8-13 from plan R-9's
//! force_value security chain (concurrent-count,
//! tag existence, type range, old-value save,
//! ProcessImage write with TagSource::Force,
//! ForceRegistry apply).
//!
//! ## Two-person integrity
//!
//! Plan R-9 mandates two-person integrity for
//! `force_value`. The co-approval mechanism requires
//! a multi-key ceremony that's not in place yet; a
//! follow-up batch adds the gate once ADR-017
//! ships that infrastructure. Until then the single-
//! operator path is the only one. Operator-facing
//! documentation notes this explicitly.

use serde_json::{json, Value};
use tracing::{info, warn};

use super::CommandHandler;
use crate::process_image::TagQuality;
use crate::security::sanitize_for_log;

impl CommandHandler {
    /// `force_value { tag_name, value, ttl_secs,
    /// reason }` — apply a force. Returns the
    /// generated force_id on success.
    ///
    /// Security chain (plan R-9):
    /// - Param shape validation (required fields).
    /// - Registry enforces TTL cap + rate limit +
    ///   concurrent count.
    /// - On success, writes the force value to
    ///   ProcessImage with TagSource::Force so the
    ///   polling loop sees the forced value
    ///   immediately (next io_poll tick is
    ///   Batch 198 scope but this write makes the
    ///   forced value live NOW).
    pub(super) async fn cmd_force_value(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing force_value command (Faz 6 Batch 197)");

        let tag_name = match params.get("tag_name").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return (
                    false,
                    json!(null),
                    Some(
                        "force_value: missing or empty required param `tag_name`"
                            .to_string(),
                    ),
                );
            }
        };

        let value = match params.get("value").and_then(|v| v.as_f64()) {
            Some(v) => v,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "force_value: missing or non-numeric required param `value`"
                            .to_string(),
                    ),
                );
            }
        };

        let ttl_secs = match params.get("ttl_secs").and_then(|v| v.as_u64()) {
            Some(n) if n > 0 => n,
            Some(_) => {
                return (
                    false,
                    json!(null),
                    Some(
                        "force_value: ttl_secs must be > 0 (use unforce_value to clear)"
                            .to_string(),
                    ),
                );
            }
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "force_value: missing required param `ttl_secs`"
                            .to_string(),
                    ),
                );
            }
        };

        let reason = params
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("(no reason supplied)")
            .to_string();

        // Operator attribution: prefer params.actor,
        // fall back to a placeholder. Upstream command
        // envelope already records the authenticated
        // actor; this field is for audit display.
        let actor = params
            .get("actor")
            .and_then(|v| v.as_str())
            .unwrap_or("command-envelope")
            .to_string();

        // Opt-in persistence across reboot. Default
        // false per plan R-9 fail-safe rule.
        let persist = params
            .get("persist_across_reboot")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let (force_registry, process_image, force_store, license) = {
            let state = self.state.read().await;
            (
                state.force_registry.clone(),
                state.process_image.clone(),
                state.force_registry_store.clone(),
                state.license.clone(),
            )
        };

        // Batch 214 Faz 7 wire: license concurrent-force cap.
        // check_force_budget uses `>=` so the current registry
        // size is checked BEFORE apply — rejecting here stops
        // the registry from growing past cap. conservative()
        // fallback has cap=0; STARTER tenants cannot force at
        // all, which matches the plan's tier-gating discipline.
        let active_forces = force_registry.active_count().await;
        match crate::license::check_force_budget(active_forces, &license) {
            crate::license::ForceBudget::WithinBudget { .. } => {}
            crate::license::ForceBudget::Exceeded { active, cap } => {
                warn!(
                    "force_value rejected: license cap hit (active={} cap={} tier={})",
                    active,
                    cap,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "force_value: license cap reached (active={} cap={} tier={}) — upgrade tier or unforce an existing entry",
                        active,
                        cap,
                        license.tier.as_str(),
                    )),
                );
            }
        }

        match force_registry
            .apply(
                tag_name.clone(),
                value,
                TagQuality::Good,
                actor.clone(),
                reason.clone(),
                ttl_secs,
                persist,
            )
            .await
        {
            Ok(force_id) => {
                // Plan R-9 step 11: write the forced
                // value to ProcessImage with
                // TagSource::Force so scan-cycle +
                // downstream consumers see it live.
                process_image
                    .update_tag_raw(
                        &tag_name,
                        value,
                        TagQuality::Good,
                        crate::process_image::TagSource::Force,
                    )
                    .await;

                // Batch 202 Faz 6: persist
                // opt-in forces to SQLCipher so they
                // survive reboot. Non-persist forces
                // skip this step entirely — in-memory
                // only. Store unavailable (None) +
                // persist=true logs a warn + returns
                // persisted=false so operators see
                // the mismatch.
                let persisted_ok = if persist {
                    match force_registry.get(&tag_name).await {
                        Some(entry) => match force_store.as_ref() {
                            Some(store) => match store.save(&entry) {
                                Ok(()) => true,
                                Err(e) => {
                                    warn!(
                                        "force_value: registry apply OK but store save failed for `{}`: {}",
                                        sanitize_for_log(&tag_name),
                                        e
                                    );
                                    false
                                }
                            },
                            None => {
                                warn!(
                                    "force_value: persist=true requested but force_registry_store not configured. Force lives in memory only."
                                );
                                false
                            }
                        },
                        None => {
                            warn!(
                                "force_value: registry apply OK but entry missing at save-back read for `{}`",
                                sanitize_for_log(&tag_name)
                            );
                            false
                        }
                    }
                } else {
                    false
                };

                info!(
                    "force_value: tag=`{}` value={} ttl={}s force_id={} actor=`{}` persist={} persisted={}",
                    sanitize_for_log(&tag_name),
                    value,
                    ttl_secs,
                    force_id,
                    sanitize_for_log(&actor),
                    persist,
                    persisted_ok,
                );
                (
                    true,
                    json!({
                        "applied": true,
                        "force_id": force_id.to_string(),
                        "tag_name": tag_name,
                        "value": value,
                        "ttl_secs": ttl_secs,
                        "persist_across_reboot": persist,
                        "persisted": persisted_ok,
                    }),
                    None,
                )
            }
            Err(e) => {
                warn!("force_value rejected: {}", e);
                (
                    false,
                    json!(null),
                    Some(format!("force_value: {}", e)),
                )
            }
        }
    }

    /// `unforce_value { tag_name }` — remove one
    /// active force.
    pub(super) async fn cmd_unforce_value(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing unforce_value command (Faz 6 Batch 197)");

        let tag_name = match params.get("tag_name").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return (
                    false,
                    json!(null),
                    Some(
                        "unforce_value: missing or empty required param `tag_name`"
                            .to_string(),
                    ),
                );
            }
        };

        let (force_registry, force_store) = {
            let state = self.state.read().await;
            (state.force_registry.clone(), state.force_registry_store.clone())
        };

        match force_registry.remove(&tag_name).await {
            Ok(entry) => {
                // Batch 202: purge from SQLCipher
                // store too so the force doesn't
                // re-appear on reboot. Best-effort —
                // store failure logs at warn +
                // returns success (in-memory removal
                // is authoritative for the current
                // boot).
                if let Some(store) = force_store.as_ref() {
                    if let Err(e) = store.delete(&tag_name) {
                        warn!(
                            "unforce_value: registry remove OK but store delete failed for `{}`: {}",
                            sanitize_for_log(&tag_name),
                            e
                        );
                    }
                }
                info!(
                    "unforce_value: tag=`{}` force_id={} old_value={} actor=`{}`",
                    sanitize_for_log(&tag_name),
                    entry.force_id,
                    entry.value,
                    sanitize_for_log(&entry.actor),
                );
                (
                    true,
                    json!({
                        "unforced": true,
                        "tag_name": entry.tag_name,
                        "force_id": entry.force_id.to_string(),
                        "old_value": entry.value,
                    }),
                    None,
                )
            }
            Err(e) => {
                warn!("unforce_value rejected: {}", e);
                (
                    false,
                    json!(null),
                    Some(format!("unforce_value: {}", e)),
                )
            }
        }
    }

    /// `unforce_all` — drain every active force.
    /// Returns the list of cleared tag names for
    /// audit.
    pub(super) async fn cmd_unforce_all(
        &self,
        _params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing unforce_all command (Faz 6 Batch 197)");

        let (force_registry, force_store) = {
            let state = self.state.read().await;
            (state.force_registry.clone(), state.force_registry_store.clone())
        };
        let drained = force_registry.remove_all().await;
        let tag_names: Vec<String> = drained
            .iter()
            .map(|e| e.tag_name.clone())
            .collect();

        // Batch 202: purge each drained entry from
        // SQLCipher. Failures are logged + skipped;
        // the in-memory drain already completed so
        // runtime is consistent. Worst-case stale
        // rows get filtered by the load_into_registry
        // gate on next boot.
        if let Some(store) = force_store.as_ref() {
            for name in &tag_names {
                if let Err(e) = store.delete(name) {
                    warn!(
                        "unforce_all: store delete failed for `{}`: {}",
                        sanitize_for_log(name),
                        e
                    );
                }
            }
        }

        info!(
            "unforce_all: drained {} force(s): {:?}",
            drained.len(),
            tag_names
        );
        (
            true,
            json!({
                "drained_count": drained.len(),
                "tag_names": tag_names,
            }),
            None,
        )
    }

    /// `list_forces` — enumerate active forces.
    pub(super) async fn cmd_list_forces(
        &self,
        _params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing list_forces command (Faz 6 Batch 197)");

        let force_registry = {
            let state = self.state.read().await;
            state.force_registry.clone()
        };
        let entries = force_registry.list().await;
        let summaries: Vec<Value> = entries
            .iter()
            .map(|e| {
                json!({
                    "force_id": e.force_id.to_string(),
                    "tag_name": e.tag_name,
                    "value": e.value,
                    "actor": e.actor,
                    "reason": e.reason,
                    "applied_at_unix_secs": e.applied_at.timestamp(),
                    "expires_at_unix_secs": e.expires_at_unix,
                    "persist_across_reboot": e.persist_across_reboot,
                })
            })
            .collect();
        (
            true,
            json!({
                "count": summaries.len(),
                "forces": summaries,
            }),
            None,
        )
    }
}
