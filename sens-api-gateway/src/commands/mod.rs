//! Command handler for remote commands
//!
//! Receives and executes commands from the cloud platform.
//! Supports: ping, reboot, get_config, update_config, scripts, etc.
//!
//! v2.1 Features:
//! - deploy_program: IEC 61131-3 program deployment with FBs
//!
//! v1.2.2 Security:
//! - Log sanitization to prevent log injection attacks

// Module declarations — each submodule's own doc comment
// describes its scope; this list is the at-a-glance index.
// Architectural narrative (which Batch landed each split) lives
// in commit history; per-handler audit notes live inline in the
// destination files.
//
// Cross-cutting consumers:
//   - `required_permission` — pub(crate) so command_envelope's
//     verify path can call permission_for_command without
//     duplicating the SSoT table.
//   - `ping_handler` — pub mod for in-tree tests of
//     PingHandler EnvelopeHandler shape.
//   - `program_def` — pub use re-exports ProgramDefinition +
//     ProgramState (cloud wire-shape types).
//
// Per-domain handler submodules (each adds an
// `impl CommandHandler { ... cmd_X ... }` block):
mod apply_signed_manifest;
mod audit_emit;
// Faz 5 two-phase release-bundle apply (verify → staged ack →
// atomic apply → confirmed/failed). Verification core is a pure
// function so "broken checksum applies nothing" is testable.
// pub(crate): contract_fixtures_tests runs the shared fixture
// through the full verify pipeline.
pub(crate) mod bundle_deploy;
pub(crate) mod catalog;
mod cert_pinning;
mod confirm_slot;
mod deploy_bytecode_program;
mod diagnostic;
mod envelope_adapter;
mod failover;
mod firmware;
mod helpers;
mod ide_deploy;
mod io_config;
#[cfg(feature = "lorawan")]
mod lora;
pub mod ping_handler;
mod plc;
mod program;
mod rbac;
mod read;
mod refresh_license;
pub(crate) mod required_permission;
mod rotate_master;
mod script;
mod system;
mod user_token;
mod verify_signed_manifest;
mod write;
// Batch #299 ORPHAN-HIGH-020 closure: cmd_deploy_st_source —
// operator-signed ST source MQTT command handler. Parallel to
// deploy_bytecode_program but takes raw .st source via
// SignedStSource envelope (Batch #297 primitive), runs through
// compile_and_deploy_signed_source (Batch #298 adapter) which
// internally orchestrates verify+parse+compile+deploy. Same
// AppState read-guard discipline as deploy_bytecode_program.
mod bytecode_ops;
mod deploy_st_source;
mod force_commands;
mod watch_commands;

// Batch #296 ULTRA-HIGH-013 closure: types + dispatch lifecycle
// extracted from inline mod.rs to keep this file under the
// 500-line ceiling. Types remain `pub` re-exported at the
// commands module boundary so external callers compile unchanged.
mod program_def;
pub use program_def::{ProgramDefinition, ProgramState};
mod config_dispatch;
mod dispatch_lifecycle;
mod mqtt_dispatch;

// Imports for the post-extraction mod.rs body
// (CommandHandler struct + new() + tests).
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};
use tracing::{error, info, warn};

use crate::AppState;
use crate::scripting::ScriptStorage;

use self::helpers::RateLimiter;
#[allow(unused_imports)]
// param helpers: not all handlers use every extractor; imported at module scope for uniform call syntax across moved sub-modules (Batches 20c+).
use self::helpers::{
    get_bool_param, get_str_param, get_u64_param, require_str_param, require_u64_param,
};

/// Default delay before system reboot (seconds) - v1.2.6
const DEFAULT_REBOOT_DELAY_SECS: u64 = 5;

/// Default delay before agent restart (seconds) - v1.2.6
const DEFAULT_RESTART_DELAY_SECS: u64 = 2;

// ============================================================================
// Command Handler
// ============================================================================
// Batch #296 ULTRA-HIGH-013 closure: ProgramDefinition + ProgramState
// types moved to commands/program_def.rs (re-exported above).

/// Command handler
///
/// v2.2: Uses shared ScriptStorage from AppState for data consistency
/// v1.2.0: ScriptStorage now has internal RwLock (no external lock needed)
pub struct CommandHandler {
    state: Arc<RwLock<AppState>>,
    /// Shared script storage (v2.2 - from AppState singleton)
    /// v1.2.0: Internal RwLock for thread-safe access
    script_storage: Arc<ScriptStorage>,
    rate_limiter: RateLimiter,
    /// Path to program state file
    program_state_path: PathBuf,
    /// Concurrency lock to prevent overlapping deploy operations
    deploy_lock: Mutex<()>,
    /// Command replay dedup set (bounded VecDeque, max 1000 entries).
    /// Tracks recently executed command_ids to prevent MQTT QoS 1 re-delivery
    /// from triggering safety-critical commands twice (pump toggle, VFD start/stop).
    executed_command_ids: VecDeque<String>,
}

impl CommandHandler {
    /// Create a new command handler (v2.2 - uses shared storage from AppState)
    pub async fn new(state: Arc<RwLock<AppState>>) -> Self {
        // Get shared script storage and runtime config from AppState (v2.2 singleton)
        let (script_storage, rate_limit_max, rate_limit_window_secs) = {
            let state_guard = state.read().await;
            (
                state_guard.script_storage.clone(),
                state_guard.config.runtime.rate_limit_max_commands,
                state_guard.config.runtime.rate_limit_window_secs,
            )
        };

        // Batch 30: route through crate::data_dir SSoT helper.
        let program_state_path = crate::data_dir::data_dir().join("program.json");

        Self {
            state,
            script_storage,
            rate_limiter: RateLimiter::new(
                rate_limit_max,
                Duration::from_secs(rate_limit_window_secs),
            ),
            program_state_path,
            deploy_lock: Mutex::new(()),
            executed_command_ids: VecDeque::with_capacity(1000),
        }
    }

    /// Run the command handler loop.
    ///
    /// Batch 26 plan D-15: accepts `shutdown_rx` directly rather
    /// than relying on `tokio::select!`-wrapped `run_until_shutdown`
    /// for cancellation. The select!-based wrapper would DROP the
    /// future mid-`handle_message` on shutdown — if an incoming
    /// command was invoking `set_output` on a Modbus register, the
    /// drop would cancel the in-flight write AFTER the bus
    /// transaction had started, leaving the actuator in a partial-
    /// write state. Subsequent safe-state apply might THEN overwrite
    /// a partially-written register, but there's a microsecond-
    /// level window where the actuator could be in an
    /// indeterminate state.
    ///
    /// The DRAIN pattern: check shutdown flag BETWEEN iterations,
    /// never mid-`handle_message`. In-flight commands complete
    /// naturally; new commands are not accepted after shutdown
    /// signal. The outer shutdown coordinator's timeout still
    /// bounds total drain time (any command that takes longer
    /// than the timeout gets force-aborted by the coordinator's
    /// `tokio::time::timeout` around the JoinHandle).
    pub async fn run(mut self, mut shutdown_rx: tokio::sync::broadcast::Receiver<()>) {
        info!("Command handler started (D-15 drain-aware)");

        loop {
            // Check shutdown BETWEEN iterations. An in-flight
            // handle_message from the previous iteration has
            // already completed at this point; new commands are
            // NOT accepted once shutdown has been signaled.
            //
            // `try_recv` on a broadcast receiver returns:
            // - Ok(()) — signal received, exit loop cleanly.
            // - Err(TryRecvError::Empty) — no signal yet, continue.
            // - Err(TryRecvError::Closed) — sender dropped, exit
            //   (equivalent to shutdown — nobody left to signal).
            // - Err(TryRecvError::Lagged) — a very high volume of
            //   signals filled the channel. Treat as shutdown too.
            match shutdown_rx.try_recv() {
                Ok(()) => {
                    info!("Command handler received shutdown; loop exit after drain");
                    return;
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                    warn!("Shutdown sender dropped; command handler exiting");
                    return;
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {
                    info!("Shutdown channel lagged; treating as shutdown signal");
                    return;
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    // No shutdown yet, proceed with poll cycle.
                }
            }

            // Wait a bit before checking for messages.
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

            let message = {
                let mut state = self.state.write().await;
                if let Some(ref mut mqtt) = state.mqtt_client {
                    mqtt.try_recv()
                } else {
                    None
                }
            };

            if let Some(msg) = message {
                if !self.rate_limiter.check() {
                    warn!(
                        "Command rate limit exceeded ({} commands in {} seconds). Dropping message.",
                        self.rate_limiter.max_commands(),
                        self.rate_limiter.window().as_secs()
                    );
                    continue;
                }

                // CRITICAL: handle_message runs to completion here,
                // not inside a tokio::select! — the D-15 drain-
                // before-safe-state guarantee depends on NO mid-
                // execution cancellation point.
                if let Err(e) = self.handle_message(msg).await {
                    error!("Failed to handle message: {}", e);
                }
            }
        }
    }

    // Batch #296 ULTRA-HIGH-013 closure: handle_message body
    // (~292 lines) moved to commands/mqtt_dispatch.rs as an
    // `impl super::CommandHandler` block. Method visibility
    // remains pub(super) — only the run-loop callsite above
    // can invoke it; rate-limiter cannot be bypassed.

    // Batch #296 ULTRA-HIGH-013 closure: execute_command body
    // (~345 lines including the 54+ command-name dispatch
    // table) moved to commands/dispatch_lifecycle.rs as an
    // `impl super::CommandHandler` block. Method visibility
    // remains pub(super) — the only caller is handle_message
    // in the sibling mqtt_dispatch.rs module.

    // Per-command handlers (cmd_*) are defined as
    // `impl super::CommandHandler { ... }` blocks across the
    // domain submodules declared near the top of this file
    // (diagnostic.rs / failover.rs / script.rs / read.rs /
    // write.rs / system.rs / io_config.rs / lora.rs /
    // firmware.rs / program.rs / plc.rs / ide_deploy.rs /
    // rbac.rs / user_token.rs / rotate_master.rs /
    // confirm_slot.rs / verify_signed_manifest.rs /
    // apply_signed_manifest.rs / refresh_license.rs /
    // deploy_bytecode_program.rs / bytecode_ops.rs /
    // force_commands.rs / watch_commands.rs).
    //
    // Dispatch table → handler binding lives in
    // dispatch_lifecycle.rs's `match command.command.as_str()`.
    // Adding a new command requires (1) adding the cmd_X method
    // in the appropriate submodule, (2) adding the match arm in
    // dispatch_lifecycle.rs, (3) adding the
    // command-name → permission entry in
    // required_permission.rs.
}

#[cfg(test)]
mod tests {
    use super::*;
    // Test-scoped imports: CommandResponse + json! were used by
    // pre-Batch-#296 mod.rs body but the production imports
    // were trimmed during the extraction; tests still need them.
    use crate::mqtt::CommandResponse;
    use serde_json::json;

    #[test]
    fn test_command_response_serialization() {
        // Batch 85 fix of ORPHAN-HIGH-013 #3: CommandResponse
        // uses `#[serde(rename_all = "camelCase")]` per ADR-006
        // wire-format convention (edge->cloud MQTT payloads
        // use camelCase to match platform-side GraphQL + REST
        // idiom). Pre-fix test asserted snake_case field
        // names which never matched the serialized output.
        let response = CommandResponse {
            command_id: "cmd-123".to_string(),
            device_id: "device-456".to_string(),
            success: true,
            result: json!({"pong": true}),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            error: None,
        };

        let json = serde_json::to_string(&response).unwrap();
        // Assert camelCase field serialization (matches
        // actual wire format).
        assert!(
            json.contains("commandId"),
            "expected camelCase commandId: {}",
            json
        );
        assert!(
            json.contains("deviceId"),
            "expected camelCase deviceId: {}",
            json
        );
        assert!(json.contains("pong"));
        // None fields skip via `skip_serializing_if`.
        assert!(
            !json.contains("error"),
            "error=None should be omitted: {}",
            json
        );
        // Pin the canonical field presence so a future
        // rename_all change is caught.
        assert!(json.contains("success"));
        assert!(json.contains("result"));
        assert!(json.contains("timestamp"));
    }
}
