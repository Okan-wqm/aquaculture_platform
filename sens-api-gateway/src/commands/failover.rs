//! MQTT broker failover command handlers (Batch 20d ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. Failover commands
//! require access to `AppState.failover_manager` (Batch 13 wire)
//! and the MQTT failover config branch. Extracting them to their
//! own module surfaces the Failover dependency graph — any future
//! Sprint 6.7 ShutdownCoordinator integration (OBS-13-001) lands
//! here without churning unrelated handlers.
//!
//! WHAT: 3 handlers moved from mod.rs as `impl CommandHandler`
//! block:
//! - `cmd_failover_status` — reports config + (TODO Sprint 6.x)
//!   live broker state via FailoverManager::get_status_report().
//! - `cmd_failover_force` — manual failover to backup broker.
//!   Fail-closed on config.mqtt.failover.enabled=false OR missing
//!   backup_broker OR FailoverManager not initialized. All paths
//!   emit operator-visible error strings.
//! - `cmd_failover_recover` — manual recovery to primary broker.
//!   Symmetric fail-closed pattern.
//!
//! SAFETY: These handlers mutate the active MQTT broker target.
//! They MUST be gated by Batch 6a tenant-mTLS authorization. The
//! current implementation does NOT yet enforce RBAC (TODO
//! OBS-20-001 — Sprint 6.x authz::PolicyEngine middleware in
//! execute_command); until then, any authenticated tenant on the
//! broker can trigger failover. Tracked as a separate concern
//! from the Batch 20 god-file split.

use serde_json::{Value, json};
use tracing::{error, info, warn};

use super::CommandHandler;

impl CommandHandler {
    /// Get MQTT failover status.
    ///
    /// WHY PARTIAL: Current implementation reports CONFIG state.
    /// Live broker state (active broker, failover count, last
    /// failover timestamp) requires FailoverManager status-report
    /// API + CommandHandler holding a reference to it — Sprint 6.x
    /// wire-up. Until then the response body is honest about what
    /// it reports.
    pub(super) async fn cmd_failover_status(
        &self,
    ) -> (bool, Value, Option<String>) {
        info!("Executing failover_status command");

        let state = self.state.read().await;
        let failover_config = &state.config.mqtt.failover;

        if !failover_config.enabled {
            return (
                true,
                json!({
                    "enabled": false,
                    "message": "Failover is not enabled. Configure mqtt.failover in config.yaml"
                }),
                None,
            );
        }

        let primary_broker = state.config.mqtt.broker.as_deref().unwrap_or("not configured");
        let backup_broker = failover_config.backup_broker.as_deref().unwrap_or("not configured");
        let backup_port = failover_config.backup_port.unwrap_or(state.config.mqtt.port);

        (
            true,
            json!({
                "enabled": true,
                "primary_broker": format!("{}:{}", primary_broker, state.config.mqtt.port),
                "backup_broker": format!("{}:{}", backup_broker, backup_port),
                "config": {
                    "timeout_secs": failover_config.timeout_secs,
                    "health_check_interval_secs": failover_config.health_check_interval_secs,
                    "max_failures": failover_config.max_failures,
                    "recovery_delay_secs": failover_config.recovery_delay_secs
                }
            }),
            None,
        )
    }

    /// Force failover to backup broker.
    ///
    /// WHY FAIL-CLOSED: Operator sent this command expecting to
    /// move off the primary broker. If ANY precondition is wrong
    /// (config disabled, backup missing, FailoverManager not
    /// wired), returning silent-success would leave the operator
    /// believing failover happened when it didn't. Every failure
    /// path emits an operator-visible error string explaining
    /// which precondition failed.
    pub(super) async fn cmd_failover_force(&self) -> (bool, Value, Option<String>) {
        info!("Executing failover_force command");

        let state = self.state.read().await;
        let failover_config = &state.config.mqtt.failover;

        if !failover_config.enabled {
            return (
                false,
                json!(null),
                Some("Failover is not enabled. Configure mqtt.failover in config.yaml".to_string()),
            );
        }

        if failover_config.backup_broker.is_none() {
            return (
                false,
                json!(null),
                Some("No backup broker configured".to_string()),
            );
        }

        match state.failover_manager.as_ref() {
            Some(fm) => match fm.force_failover().await {
                Ok(()) => {
                    warn!("Manual failover to backup broker completed successfully");
                    (
                        true,
                        json!({
                            "action": "failover_completed",
                            "target": failover_config.backup_broker,
                            "message": "Failover to backup broker completed"
                        }),
                        None,
                    )
                }
                Err(e) => {
                    error!("Manual failover FAILED: {}", e);
                    (
                        false,
                        json!(null),
                        Some(format!("Failover failed: {}", e)),
                    )
                }
            },
            None => {
                error!("FailoverManager not initialized — cannot perform failover");
                (
                    false,
                    json!(null),
                    Some("FailoverManager not initialized. MQTT failover wiring incomplete.".to_string()),
                )
            }
        }
    }

    /// Force recovery to primary broker.
    ///
    /// WHY SYMMETRIC: Same fail-closed precondition pattern as
    /// cmd_failover_force. Recovery cannot silently no-op — the
    /// operator's mental model is "I told the device to go back to
    /// primary; it either did or gave me a specific reason why not".
    pub(super) async fn cmd_failover_recover(&self) -> (bool, Value, Option<String>) {
        info!("Executing failover_recover command");

        let state = self.state.read().await;
        let failover_config = &state.config.mqtt.failover;

        if !failover_config.enabled {
            return (
                false,
                json!(null),
                Some("Failover is not enabled".to_string()),
            );
        }

        let primary_broker = match &state.config.mqtt.broker {
            Some(b) => b.clone(),
            None => {
                return (
                    false,
                    json!(null),
                    Some("No primary broker configured".to_string()),
                );
            }
        };

        match state.failover_manager.as_ref() {
            Some(fm) => match fm.force_recovery().await {
                Ok(()) => {
                    warn!("Manual recovery to primary broker completed successfully");
                    (
                        true,
                        json!({
                            "action": "recovery_completed",
                            "target": primary_broker,
                            "message": "Recovery to primary broker completed"
                        }),
                        None,
                    )
                }
                Err(e) => {
                    error!("Manual recovery FAILED: {}", e);
                    (
                        false,
                        json!(null),
                        Some(format!("Recovery failed: {}", e)),
                    )
                }
            },
            None => {
                error!("FailoverManager not initialized — cannot perform recovery");
                (
                    false,
                    json!(null),
                    Some("FailoverManager not initialized. MQTT failover wiring incomplete.".to_string()),
                )
            }
        }
    }
}
