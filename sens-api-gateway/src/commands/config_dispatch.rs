//! Config-update routing for the CommandHandler.
//!
//! ## Why this module exists (Batch #296 ULTRA-HIGH-013 closure)
//!
//! Pre-Batch-#296 the `handle_config_update` body lived inline in
//! `commands/mod.rs`. Extracted here as part of the
//! ULTRA-HIGH-013 ≤500-line ceiling closure. The function:
//!
//!   - Parses the cloud config-update JSON.
//!   - Selectively updates telemetry interval / include flags +
//!     scripting enabled flag (validated bounds: 5..=3600s for
//!     interval).
//!   - Applies the changes to a copy, persists the copy via
//!     `save(crate::paths::AgentPaths::current())`, and only then
//!     swaps it into the live configuration, so a persist failure
//!     leaves the running agent unchanged (EDGE-MEDIUM-079); returns
//!     Err on persist failure (caller's `error!` log surfaces it).
//!
//! ## Profiles (ADR-048 DEC-4.12)
//!
//! Generic profile only. On Suderra OS `config.yaml` is site material
//! the root installer writes from a signed site-config statement; until
//! the P1 `kind=site-config` update channel the only way to change it is
//! re-provisioning, so the config topic applies nothing there and the
//! message is rejected as unsupported.
//!
//! ## Visibility
//!
//! `handle_config_update` is `pub(super)` (only caller is the
//! `commands` topic-dispatch arm in `mqtt_dispatch::handle_message`).
use anyhow::Result;
#[cfg(not(feature = "suderra-os"))]
use serde_json::Value;
use tracing::warn;
#[cfg(not(feature = "suderra-os"))]
use tracing::{error, info};

impl super::CommandHandler {
    /// Suderra OS: the config topic applies nothing (ADR-048 DEC-4.12).
    #[cfg(feature = "suderra-os")]
    pub(super) async fn handle_config_update(&self, payload: &[u8]) -> Result<()> {
        warn!(
            "Rejecting config update ({} bytes): unsupported in the suderra-os profile; \
             config.yaml is signed site material changed only by re-provisioning (ADR-048 DEC-4.12)",
            payload.len()
        );
        Err(anyhow::anyhow!(
            "unsupported: the config topic applies nothing in the suderra-os profile (ADR-048 DEC-4.12)"
        ))
    }

    /// Handle config update from cloud.
    #[cfg(not(feature = "suderra-os"))]
    pub(super) async fn handle_config_update(&self, payload: &[u8]) -> Result<()> {
        let config_update: Value = serde_json::from_slice(payload)?;
        info!("Received config update: {:?}", config_update);

        let mut state = self.state.write().await;
        // EDGE-MEDIUM-079: changes go to a copy; the live configuration is
        // replaced only after the copy is on disk.
        let mut updated = state.config.clone();
        let mut config_changed = false;

        // Update telemetry interval if provided
        if let Some(telemetry) = config_update.get("telemetry") {
            if let Some(interval) = telemetry.get("interval_seconds").and_then(|v| v.as_u64()) {
                // Validate: minimum 5 seconds, maximum 3600 seconds (1 hour)
                if (5..=3600).contains(&interval) {
                    updated.telemetry.interval_seconds = interval;
                    config_changed = true;
                    info!("Updated telemetry interval to {} seconds", interval);
                } else {
                    warn!(
                        "Invalid telemetry interval {}: must be between 5 and 3600 seconds",
                        interval
                    );
                }
            }

            // Update telemetry include flags
            if let Some(include_system) = telemetry.get("include_system").and_then(|v| v.as_bool())
            {
                updated.telemetry.include_system = include_system;
                config_changed = true;
            }
            if let Some(include_modbus) = telemetry.get("include_modbus").and_then(|v| v.as_bool())
            {
                updated.telemetry.include_modbus = include_modbus;
                config_changed = true;
            }
            if let Some(include_gpio) = telemetry.get("include_gpio").and_then(|v| v.as_bool()) {
                updated.telemetry.include_gpio = include_gpio;
                config_changed = true;
            }
        }

        // Update scripting enabled flag if provided
        if let Some(scripting) = config_update.get("scripting") {
            if let Some(enabled) = scripting.get("enabled").and_then(|v| v.as_bool()) {
                updated.scripting.enabled = enabled;
                config_changed = true;
                info!("Updated scripting enabled to {}", enabled);
            }
        }

        // Save config to disk if changed, then make it live.
        if config_changed {
            if let Err(e) = updated.save(crate::paths::AgentPaths::current()) {
                error!("Failed to save config after update: {}", e);
                return Err(anyhow::anyhow!("Failed to persist config changes: {}", e));
            }
            state.config = updated;
            info!("Config update applied and saved successfully");
        } else {
            info!("No applicable config changes found in update");
        }

        Ok(())
    }
}
