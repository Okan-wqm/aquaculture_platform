//! Diagnostic command handlers (Batch 20c ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 splits the 4392-line `commands.rs` god-
//! file into domain-bounded sub-modules. This module houses
//! READ-ONLY diagnostic commands — no state mutation beyond a log-
//! level config write. Extracting these first is the safest opener
//! because the handlers have the smallest blast radius.
//!
//! WHAT: `impl CommandHandler` block containing:
//! - `cmd_ping` — health-check roundtrip with timestamp.
//! - `cmd_get_info` — device/agent/tenant metadata (no secrets).
//! - `cmd_get_config` — SAFE subset of AgentConfig (device_id,
//!   telemetry flags, logging level, counts). Secrets (MQTT
//!   password, JWT keys, master key) are never surfaced here —
//!   this is a deliberate allowlist, not a redact-list.
//! - `cmd_set_log_level` — updates `config.logging.level` in-
//!   memory; NOT effective until agent restart (the response body
//!   makes this limitation operator-visible).
//!
//! CROSS-MODULE INVARIANTS:
//! - Every handler returns the canonical `(success, result_value,
//!   error_message)` triple consumed by `execute_command` dispatch
//!   (mod.rs).
//! - Log-safe output: every operator-visible string routed through
//!   `sanitize_for_log()` (`cmd_set_log_level` sanitizes the level
//!   string even after whitelist validation — defense-in-depth
//!   against log-injection if the whitelist is ever expanded
//!   without re-checking).

use serde_json::{Value, json};
use tracing::info;
use chrono::Utc;

use crate::security::sanitize_for_log;

use super::CommandHandler;

impl CommandHandler {
    /// Ping command - simple health check
    pub(super) async fn cmd_ping(&self) -> (bool, Value, Option<String>) {
        info!("Executing ping command");
        (
            true,
            json!({"pong": true, "timestamp": Utc::now().to_rfc3339()}),
            None,
        )
    }

    /// Get device info
    pub(super) async fn cmd_get_info(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_info command");

        let state = self.state.read().await;

        let info = json!({
            "device_id": state.config.device_id,
            "device_code": state.config.device_code,
            "agent_version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "tenant_id": state.tenant_id,
            "mqtt_broker": state.config.mqtt.broker,
            "is_activated": state.is_activated,
        });

        (true, info, None)
    }

    /// Get current config
    ///
    /// WHY ALLOWLIST NOT REDACT: `AgentConfig` contains secrets
    /// (mqtt.password, master_key_path contents, JWT key paths).
    /// A "redact matched fields" approach risks leaking newly-
    /// added secret fields that forget to add themselves to the
    /// redact list. Explicit allowlist surfaces only the fields
    /// an operator legitimately needs visible.
    pub(super) async fn cmd_get_config(&self) -> (bool, Value, Option<String>) {
        info!("Executing get_config command");

        let state = self.state.read().await;

        // Batch 36: extended to surface Faz 2 security posture
        // fields (mtls rollout stage, replay-protection
        // thresholds, shutdown/drain timeouts). Operators
        // running the platform UI's "Device → Config" view
        // see the ACTIVE values rather than assuming defaults.
        // Preserved allowlist discipline — every new field is
        // explicitly listed; secrets (mqtt.password, master-key
        // paths, cert keys) remain absent.
        let config = json!({
            "device_id": state.config.device_id,
            "device_code": state.config.device_code,
            "api_url": state.config.api_url,
            "telemetry": {
                "interval_seconds": state.config.telemetry.interval_seconds,
                "include_cpu": state.config.telemetry.include_cpu,
                "include_memory": state.config.telemetry.include_memory,
                "include_disk": state.config.telemetry.include_disk,
                "include_temperature": state.config.telemetry.include_temperature,
            },
            "logging": {
                "level": state.config.logging.level,
            },
            // Batch 27: mTLS rollout stage visibility.
            "mtls": {
                "mode": format!("{:?}", state.config.mtls.mode).to_lowercase(),
                "enforce_fingerprint_pinning": state.config.mtls.enforce_fingerprint_pinning,
                "min_tls_version": state.config.mtls.min_tls_version,
            },
            // Batch 32+34: shutdown + replay-protection thresholds.
            "runtime": {
                "shutdown_timeout_secs": state.config.runtime.shutdown_timeout_secs,
                "drain_timeout_ms": state.config.runtime.drain_timeout_ms,
                "max_command_age_secs": state.config.runtime.max_command_age_secs,
                "max_command_skew_secs": state.config.runtime.max_command_skew_secs,
                "rate_limit_max_commands": state.config.runtime.rate_limit_max_commands,
                "rate_limit_window_secs": state.config.runtime.rate_limit_window_secs,
            },
            // Batch 18: backup lifecycle visibility.
            "backup": {
                "enabled": state.config.backup.enabled,
                "max_backups": state.config.backup.max_backups,
            },
            // Batch 15: offline queue visibility.
            "offline_queue": {
                "enabled": state.config.offline_queue.enabled,
            },
            "modbus_devices": state.config.modbus.len(),
            "gpio_pins": state.config.gpio.len(),
        });

        (true, config, None)
    }

    /// Set log level
    ///
    /// WHY NOT APPLY AT RUNTIME: The `tracing_subscriber` layer's
    /// filter is constructed at boot (see `main.rs` setup) and
    /// cannot be re-parameterized without rebuilding the subscriber
    /// — runtime mutation would require a `reload` handle wired
    /// into the subscriber at boot (reserved for Sprint 6.x).
    /// Current behavior: updates the CONFIG value; `restart_agent`
    /// command picks it up on next boot. The response body makes
    /// this limitation operator-visible.
    pub(super) async fn cmd_set_log_level(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let level = match params.get("level").and_then(|v| v.as_str()) {
            Some(l) => l,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'level' parameter".to_string()),
                );
            }
        };

        let valid_levels = ["trace", "debug", "info", "warn", "error"];
        if !valid_levels.contains(&level.to_lowercase().as_str()) {
            return (
                false,
                json!(null),
                Some(format!("Invalid level. Valid: {:?}", valid_levels)),
            );
        }

        // v1.2.2: Sanitize for logging (even though whitelist validated).
        // Defense-in-depth: if the whitelist is ever expanded without
        // re-checking for control characters, sanitize_for_log keeps
        // the log path safe.
        info!("Setting log level to: {}", sanitize_for_log(level));

        let mut state = self.state.write().await;
        let previous_level = state.config.logging.level.clone();
        state.config.logging.level = level.to_lowercase();

        (
            true,
            json!({
                "previous_level": previous_level,
                "requested_level": level.to_lowercase(),
                "applied_immediately": false,
                "note": "Log level configuration updated. Changes will take effect after agent restart. \
                        Use 'restart_agent' command to apply immediately, or the agent will use the new \
                        level on next startup."
            }),
            None,
        )
    }
}
