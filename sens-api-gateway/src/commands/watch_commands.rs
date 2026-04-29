//! Watch-session commands — Batch 205 Faz 6
//! (plan R-9 item 4 watch_subscribe / unsubscribe).
//!
//! Thin adapters over the Batch 203
//! WatchSessionRegistry primitive + the
//! Batch 205 `AppState.watch_sessions` wire. The
//! publisher task (Batch 204) reads the registry's
//! due sessions + publishes their tag values;
//! these commands create + tear down sessions.

use serde_json::{Value, json};
use tracing::{info, warn};
use uuid::Uuid;

use super::CommandHandler;
use crate::security::sanitize_for_log;

impl CommandHandler {
    /// `watch_subscribe { tags, interval_ms, ttl_secs,
    ///                    actor? }` — create a new
    /// session. Returns the session_id operators use
    /// to construct the MQTT subscription topic:
    /// `tenants/{tid}/devices/{did}/watch/{sid}`.
    pub(super) async fn cmd_watch_subscribe(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing watch_subscribe command (Faz 6 Batch 205)");

        // Required: tags (non-empty array of strings).
        let tags: Vec<String> = match params.get("tags") {
            Some(Value::Array(arr)) => {
                let mut list = Vec::with_capacity(arr.len());
                for v in arr {
                    match v.as_str() {
                        Some(s) if !s.is_empty() => list.push(s.to_string()),
                        _ => {
                            return (
                                false,
                                json!(null),
                                Some(
                                    "watch_subscribe: each tag must be a non-empty string"
                                        .to_string(),
                                ),
                            );
                        }
                    }
                }
                list
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(
                        "watch_subscribe: missing required param `tags` (array of strings)"
                            .to_string(),
                    ),
                );
            }
        };

        let interval_ms = match params.get("interval_ms").and_then(|v| v.as_u64()) {
            Some(n) => n,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "watch_subscribe: missing required param `interval_ms` (integer)"
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
                    Some("watch_subscribe: ttl_secs must be > 0".to_string()),
                );
            }
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "watch_subscribe: missing required param `ttl_secs` (integer)".to_string(),
                    ),
                );
            }
        };

        let actor = params
            .get("actor")
            .and_then(|v| v.as_str())
            .unwrap_or("command-envelope")
            .to_string();

        let (registry, license) = {
            let state = self.state.read().await;
            (state.watch_sessions.clone(), state.license.clone())
        };

        // Batch 214 Faz 7 wire: license watch-session cap.
        // `>=` semantics — rejecting active==cap stops the
        // registry from growing past cap. conservative()
        // fallback gives 1 session which still allows a single
        // debug-watch cycle for STARTER tenants.
        let active_sessions = registry.active_count().await;
        match crate::license::check_watch_budget(active_sessions, &license) {
            crate::license::WatchBudget::WithinBudget { .. } => {}
            crate::license::WatchBudget::Exceeded { active, cap } => {
                warn!(
                    "watch_subscribe rejected: license cap hit (active={} cap={} tier={})",
                    active,
                    cap,
                    license.tier.as_str(),
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "watch_subscribe: license cap reached (active={} cap={} tier={}) — upgrade tier or unsubscribe an existing session",
                        active,
                        cap,
                        license.tier.as_str(),
                    )),
                );
            }
        }

        match registry
            .subscribe(tags.clone(), interval_ms, ttl_secs, actor.clone())
            .await
        {
            Ok(session_id) => {
                info!(
                    "watch_subscribe: session_id={} tags={:?} interval_ms={} ttl_secs={} actor=`{}`",
                    session_id,
                    tags,
                    interval_ms,
                    ttl_secs,
                    sanitize_for_log(&actor),
                );
                (
                    true,
                    json!({
                        "subscribed": true,
                        "session_id": session_id.to_string(),
                        "tags": tags,
                        "interval_ms": interval_ms,
                        "ttl_secs": ttl_secs,
                    }),
                    None,
                )
            }
            Err(e) => {
                warn!("watch_subscribe rejected: {}", e);
                (false, json!(null), Some(format!("watch_subscribe: {}", e)))
            }
        }
    }

    /// `watch_unsubscribe { session_id }` — stop an
    /// active session. Publisher task stops emitting
    /// on the next tick; the sweep-task path also
    /// would drop it at TTL regardless.
    pub(super) async fn cmd_watch_unsubscribe(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing watch_unsubscribe command (Faz 6 Batch 205)");

        let session_id = match params.get("session_id").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => match Uuid::parse_str(s) {
                Ok(id) => id,
                Err(e) => {
                    return (
                        false,
                        json!(null),
                        Some(format!(
                            "watch_unsubscribe: invalid session_id UUID: {}",
                            sanitize_for_log(&e.to_string())
                        )),
                    );
                }
            },
            _ => {
                return (
                    false,
                    json!(null),
                    Some(
                        "watch_unsubscribe: missing or empty required param `session_id`"
                            .to_string(),
                    ),
                );
            }
        };

        let registry = {
            let state = self.state.read().await;
            state.watch_sessions.clone()
        };

        match registry.unsubscribe(&session_id).await {
            Ok(session) => {
                info!(
                    "watch_unsubscribe: session_id={} tag_count={}",
                    session_id,
                    session.tags.len()
                );
                (
                    true,
                    json!({
                        "unsubscribed": true,
                        "session_id": session_id.to_string(),
                        "tag_count": session.tags.len(),
                    }),
                    None,
                )
            }
            Err(e) => {
                warn!("watch_unsubscribe rejected: {}", e);
                (
                    false,
                    json!(null),
                    Some(format!("watch_unsubscribe: {}", e)),
                )
            }
        }
    }

    /// `list_watch_sessions` — enumerate active
    /// sessions. Cloud UI uses this to show the
    /// operator's active debug subscriptions.
    pub(super) async fn cmd_list_watch_sessions(
        &self,
        _params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing list_watch_sessions command (Faz 6 Batch 205)");

        let registry = {
            let state = self.state.read().await;
            state.watch_sessions.clone()
        };

        let sessions = registry.list().await;
        let summaries: Vec<Value> = sessions
            .iter()
            .map(|s| {
                json!({
                    "session_id": s.session_id.to_string(),
                    "tags": s.tags,
                    "interval_ms": s.interval_ms,
                    "actor": s.actor,
                    "created_at_unix_secs": s.created_at.timestamp(),
                    "expires_at_unix_secs": s.expires_at_unix,
                })
            })
            .collect();

        (
            true,
            json!({
                "count": summaries.len(),
                "sessions": summaries,
            }),
            None,
        )
    }
}
