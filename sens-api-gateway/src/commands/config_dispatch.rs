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
//!   - Persists to disk via `state.config.save()` if anything
//!     changed; returns Err on persist failure (the only fatal
//!     path — caller's `error!` log surfaces it).
//!
//! ## Visibility
//!
//! `handle_config_update` is `pub(super)` (only caller is the
//! `commands` topic-dispatch arm in `mqtt_dispatch::handle_message`).
use anyhow::Result;
use serde_json::Value;
use tracing::{error, info, warn};

impl super::CommandHandler {
    /// Handle config update from cloud.
    pub(super) async fn handle_config_update(&self, payload: &[u8]) -> Result<()> {
        let config_update: Value = serde_json::from_slice(payload)?;
        info!("Received config update: {:?}", config_update);

        let mut state = self.state.write().await;
        let mut config_changed = false;

        // Update telemetry interval if provided
        if let Some(telemetry) = config_update.get("telemetry") {
            if let Some(interval) = telemetry.get("interval_seconds").and_then(|v| v.as_u64()) {
                // Validate: minimum 5 seconds, maximum 3600 seconds (1 hour)
                if (5..=3600).contains(&interval) {
                    state.config.telemetry.interval_seconds = interval;
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
                state.config.telemetry.include_system = include_system;
                config_changed = true;
            }
            if let Some(include_modbus) = telemetry.get("include_modbus").and_then(|v| v.as_bool())
            {
                state.config.telemetry.include_modbus = include_modbus;
                config_changed = true;
            }
            if let Some(include_gpio) = telemetry.get("include_gpio").and_then(|v| v.as_bool()) {
                state.config.telemetry.include_gpio = include_gpio;
                config_changed = true;
            }
        }

        // Update scripting enabled flag if provided
        if let Some(scripting) = config_update.get("scripting") {
            if let Some(enabled) = scripting.get("enabled").and_then(|v| v.as_bool()) {
                state.config.scripting.enabled = enabled;
                config_changed = true;
                info!("Updated scripting enabled to {}", enabled);
            }
        }

        // Save config to disk if changed
        if config_changed {
            if let Err(e) = state.config.save() {
                error!("Failed to save config after update: {}", e);
                return Err(anyhow::anyhow!("Failed to persist config changes: {}", e));
            }
            info!("Config update applied and saved successfully");
        } else {
            info!("No applicable config changes found in update");
        }

        Ok(())
    }
}
