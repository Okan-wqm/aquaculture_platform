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

// Batch 20b ARC-008 god-file split: internal helpers moved to
// `commands/helpers.rs`. Re-imported here for CommandHandler
// consumption — all helpers are `pub(super)` so they remain
// invisible outside the `commands` module tree.
mod helpers;

// Batch 28 Sprint 6.1 partial: command → authz::Permission
// mapping table. `permission_for_command(cmd, params) ->
// Option<Permission>` is a pure function that lets Sprint 6.4
// wire the RBAC gate in one line. Today the function exists
// but is NOT YET INVOKED by execute_command — the gate check
// is Sprint 6.4 scope after envelope-signed actor extraction.
#[allow(dead_code)] // permission_for_command used by Sprint 6.4 RBAC gate + invariant tests.
mod required_permission;

// Batch 20c ARC-008 god-file split: diagnostic handlers
// (cmd_ping, cmd_get_info, cmd_get_config, cmd_set_log_level)
// extracted to `commands/diagnostic.rs` as a separate `impl
// CommandHandler` block. Dispatch remains in `execute_command`
// below; the sub-module adds only the method implementations.
mod diagnostic;

// Batch 20d ARC-008 god-file split: MQTT failover handlers
// (cmd_failover_status, cmd_failover_force, cmd_failover_recover)
// extracted to `commands/failover.rs`. Surfaces the
// FailoverManager dependency; future Sprint 6.7 ShutdownCoordinator
// integration (OBS-13-001) lands in that sub-module without
// churning unrelated handlers.
mod failover;

// Batch 20e ARC-008 god-file split: script CRUD handlers
// (cmd_list_scripts, cmd_get_script, cmd_deploy_script,
// cmd_delete_script, cmd_enable_script, cmd_disable_script)
// extracted to `commands/script.rs`. All 6 route through the
// v2.2 AppState-shared `ScriptStorage` singleton; sanitize_for_log
// applied to every operator-visible script_id path.
mod script;

// Batch 20f ARC-008 god-file split: hardware READ + discovery
// handlers (cmd_get_hardware, cmd_scan_hardware, cmd_read_modbus,
// cmd_read_gpio) extracted to `commands/read.rs`. All 4 take
// `&self` — proving at the type level that no state mutation
// occurs on the read path.
mod read;

// Batch 20g ARC-008 god-file split: device-level system control
// handlers (cmd_reboot, cmd_restart_agent) + SCADA display
// lifecycle (cmd_deploy_process, cmd_deploy_scada_package,
// cmd_display_on, cmd_display_off, cmd_get_display_status)
// extracted to `commands/system.rs`. SCADA-display handlers are
// cfg-gated on `feature = "scada-display"`. Fire-and-forget
// tokio::spawn pattern documented for reboot/restart.
mod system;

// Batch 20h ARC-008 god-file split: protocol-write handlers
// (cmd_write_modbus, cmd_write_gpio, cmd_write_opcua, cmd_write_s7)
// extracted to `commands/write.rs`. OPC UA + S7 are honest stubs;
// Sprint 6.x fills them in per plan §5 Faz 5.
mod write;

// Batch 20i ARC-008 god-file split: I/O config + output-value
// lifecycle handlers (cmd_update_io_config, cmd_set_output) +
// the parse_io_config_to_tags / persist_io_config private
// helpers extracted to `commands/io_config.rs`. These require
// access to AlarmManager (alarm registration fan-out per HH/H/
// L/LL threshold) and fieldbus handles (GPIO/Modbus/I2C).
mod io_config;

// Batch 20j ARC-008 god-file split: LoRaWAN handlers
// (cmd_update_lora_devices, cmd_lora_downlink) extracted to
// `commands/lora.rs`. The sub-module is feature-gated on
// `lorawan` at the module level — default builds shed the
// code without per-handler cfg noise.
#[cfg(feature = "lorawan")]
mod lora;

// Batch 20k ARC-008 god-file split: firmware OTA pipeline
// (cmd_update_firmware + 6 module-private helpers:
// is_valid_github_repo, is_valid_version_string,
// resolve_firmware_version, fetch_latest_agent_tag,
// download_file, compute_sha256, read_checksum_file) extracted
// to `commands/firmware.rs`. Security-critical 5-stage state
// machine (resolve → download → verify → install → restart) now
// lives as a reviewable domain unit.
mod firmware;

// Batch 20l ARC-008 god-file split: IEC 61131-3 program
// lifecycle + ST validator (cmd_deploy_program, cmd_get_program,
// cmd_rollback_program, cmd_validate_st) + load/save
// program_state helpers extracted to `commands/program.rs`.
// Deploy-lock + atomic-persist + rollback-on-failure contract
// documented inline.
mod program;

// Batch 20m ARC-008 god-file split: external-PLC programming
// (cmd_plc_upload, cmd_plc_status, cmd_plc_start, cmd_plc_stop,
// cmd_plc_list, cmd_plc_download, cmd_plc_delete + 4 generic
// helpers parameterized over PlcProgrammer) extracted to
// `commands/plc.rs`. Address-safety guards (reject loopback /
// link-local / broadcast / unspecified) live in each handler.
mod plc;

// Batch 20n ARC-008 god-file split: deploy orchestrator handlers
// (cmd_deploy_to_codesys, cmd_deploy_auto) extracted to
// `commands/ide_deploy.rs`. Direct ST → PLC deploy surface
// (Codesys + auto-detect protocol selector) uses the same
// deploy_lock as cmd_deploy_program for mutual exclusion.
mod ide_deploy;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::mqtt::{CommandMessage, CommandResponse, IncomingMessage};
use crate::scripting::{ExecutionMode, FBDefinition, ScriptDefinition, ScriptStorage};
use crate::security::sanitize_for_log;

use self::helpers::RateLimiter;
#[allow(unused_imports)] // param helpers: not all handlers use every extractor; imported at module scope for uniform call syntax across moved sub-modules (Batches 20c+).
use self::helpers::{get_bool_param, get_str_param, get_u64_param, require_str_param, require_u64_param};

/// Default delay before system reboot (seconds) - v1.2.6
const DEFAULT_REBOOT_DELAY_SECS: u64 = 5;

/// Default delay before agent restart (seconds) - v1.2.6
const DEFAULT_RESTART_DELAY_SECS: u64 = 2;

// ============================================================================
// IEC 61131-3 Program Definition (v2.1)
// ============================================================================

/// IEC 61131-3 Program definition received from cloud
/// Contains everything needed to run a program on the edge device
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramDefinition {
    /// Unique program ID
    pub id: String,
    /// Program name
    pub name: String,
    /// Program version
    #[serde(default = "default_version")]
    pub version: u32,
    /// Description
    #[serde(default)]
    pub description: String,
    /// Execution mode
    #[serde(default)]
    pub execution_mode: ExecutionMode,
    /// Scan cycle time in milliseconds (for ScanCycle mode)
    #[serde(default = "default_scan_cycle")]
    pub scan_cycle_ms: u64,
    /// Function block definitions
    #[serde(default)]
    pub function_blocks: Vec<FBDefinition>,
    /// Script definition (triggers, conditions, actions)
    pub script: ScriptDefinition,
    /// Whether to replace existing program with same ID
    #[serde(default)]
    pub replace_existing: bool,
}

fn default_version() -> u32 {
    1
}

fn default_scan_cycle() -> u64 {
    100 // 100ms default
}

/// Persisted program state (for reload after restart)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProgramState {
    /// Currently deployed program
    pub program: Option<ProgramDefinition>,
    /// Deployment timestamp
    pub deployed_at: Option<String>,
    /// Previous version (for rollback)
    pub previous_version: Option<Box<ProgramDefinition>>,
}

// ============================================================================
// Command Handler
// ============================================================================

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

    /// Handle incoming message
    async fn handle_message(&mut self, message: IncomingMessage) -> anyhow::Result<()> {
        let state = self.state.read().await;
        let topics = state.mqtt_client.as_ref().map(|m| m.topics().clone());
        drop(state);

        let topics = match topics {
            Some(t) => t,
            None => return Ok(()),
        };

        // Check if this is a command message
        if message.topic == topics.commands {
            debug!("Received command message");

            // Batch 25+31 plan D-14 retained-message rejection
            // (tier-1 fail-fast). Batch 25 added the inline
            // boolean check; Batch 31 routes it through the
            // canonical `runtime_safety::retained_msg::
            // is_retained_command_rejected` predicate so the
            // rejection decision + reason is a single typed
            // value. Sprint 6.2 audit-sink wire will consume
            // `RetainedMsgRejectionReason` as the structured
            // audit event payload.
            //
            // Topic-matcher: comparing against `topics.commands`
            // directly (exact match). Sprint 6.7 may widen to
            // regex-based tenant-scoped command-topic family.
            let commands_topic = topics.commands.clone();
            let rejection = crate::runtime_safety::retained_msg::is_retained_command_rejected(
                message.retain,
                &message.topic,
                |t| t == commands_topic,
            );
            if !matches!(
                rejection,
                crate::runtime_safety::retained_msg::RetainedMsgRejectionReason::NotRejected
            ) {
                warn!(
                    "Rejecting retained MQTT command: reason={}, topic='{}', {} bytes payload. \
                     Attacker-controlled broker replay vector; audit sink wires in Sprint 6.2.",
                    rejection,
                    message.topic,
                    message.payload.len()
                );
                return Ok(());
            }

            // Parse command
            let command: CommandMessage = match serde_json::from_slice(&message.payload) {
                Ok(cmd) => cmd,
                Err(e) => {
                    warn!("Failed to parse command: {}", e);
                    return Ok(());
                }
            };

            info!(
                "Executing command: {} (id: {})",
                command.command, command.command_id
            );

            // IEC 62443 SL-2 FR-7: Command replay protection.
            // MQTT QoS 1 can re-deliver the same message. Reject:
            //   (1) Commands already seen (dedup by command_id)
            //   (2) Commands with stale timestamps (> max_command_age_secs)
            // Retained-flag rejection moved UP to pre-parse per
            // Batch 25 D-14.
            //
            // Batch 34: replay-window + skew-tolerance are NOW
            // config-driven via config.runtime.max_command_age_secs
            // + max_command_skew_secs. Pre-Batch-34 both were
            // hardcoded (300s / 60s).
            let (max_age_secs, max_skew_secs) = {
                let state_guard = self.state.read().await;
                (
                    state_guard.config.runtime.max_command_age_secs as i64,
                    state_guard.config.runtime.max_command_skew_secs as i64,
                )
            };
            if let Ok(cmd_time) = chrono::DateTime::parse_from_rfc3339(&command.timestamp) {
                let age = chrono::Utc::now().signed_duration_since(cmd_time);
                if age.num_seconds() > max_age_secs || age.num_seconds() < -max_skew_secs {
                    warn!(
                        "Rejecting stale/future command: {} age={}s (id: {}, max_age={}s, max_skew={}s)",
                        command.command, age.num_seconds(), command.command_id,
                        max_age_secs, max_skew_secs
                    );
                    return Ok(());
                }
            }
            if self.executed_command_ids.contains(&command.command_id) {
                warn!("Rejecting duplicate command: {} (id: {})",
                    command.command, command.command_id);
                return Ok(());
            }

            // Execute command
            let response = self.execute_command(&command).await;

            // Track executed command ID for dedup (bounded set, evicts oldest)
            if self.executed_command_ids.len() >= 1000 {
                self.executed_command_ids.pop_front();
            }
            self.executed_command_ids.push_back(command.command_id.clone());

            // Publish response
            let state = self.state.read().await;
            if let Some(ref mqtt) = state.mqtt_client {
                mqtt.publish_response(response).await?;
            }
        } else if message.topic == topics.config {
            debug!("Received config update");
            // Batch 25+31 plan D-14: retained-message rejection
            // for config updates. Routed through the canonical
            // `runtime_safety::retained_msg` predicate. Same
            // replay-attack vector as command topic — retained
            // config would re-apply on every reconnect.
            let config_topic = topics.config.clone();
            let rejection = crate::runtime_safety::retained_msg::is_retained_command_rejected(
                message.retain,
                &message.topic,
                |t| t == config_topic,
            );
            if !matches!(
                rejection,
                crate::runtime_safety::retained_msg::RetainedMsgRejectionReason::NotRejected
            ) {
                warn!(
                    "Rejecting retained MQTT config-update: reason={}, topic='{}', {} bytes. \
                     Broker-replay poisoning vector.",
                    rejection,
                    message.topic,
                    message.payload.len()
                );
                return Ok(());
            }
            self.handle_config_update(&message.payload).await?;
        }

        Ok(())
    }

    /// Execute a command and return response
    async fn execute_command(&mut self, command: &CommandMessage) -> CommandResponse {
        // v1.2.6: Track command execution time for observability
        let start_time = std::time::Instant::now();
        info!(
            "⚡ Command received: id='{}', command='{}', has_params={}",
            command.command_id,
            sanitize_for_log(&command.command),
            !command.params.is_null()
        );

        let device_id = {
            let state = self.state.read().await;
            state.config.device_id.clone()
        };

        // Batch 33+35 Sprint 6.1 partial: compute required-
        // permission ONCE and reuse for:
        //   (a) the IEC 62443 SL-2 safety-critical audit log
        //       (was a hardcoded command-name list; now derived
        //       from the canonical Permission::is_mutating()
        //       classifier — eliminates the 3rd parallel
        //       commands list after MUTATING_COMMANDS +
        //       required_permission_for_command).
        //   (b) the RBAC-gate-preview debug log.
        //
        // Pre-Batch-35 is_safety_critical was a bespoke match
        // that drifted from the Permission enum — a new
        // mutating command could be added to the enum without
        // being added to the audit list, silently suppressing
        // audit emission. Batch 35 ties both to the same SSoT.
        let required_perm =
            required_permission::permission_for_command(&command.command, &command.params);
        let is_safety_critical = required_perm
            .as_ref()
            .map(|p| p.is_mutating())
            .unwrap_or(false);
        if is_safety_critical {
            warn!(
                "AUDIT: Safety-critical command initiated: command='{}', id='{}', device_id='{}', timestamp='{}', required_permission={:?}",
                sanitize_for_log(&command.command),
                command.command_id,
                device_id,
                Utc::now().to_rfc3339(),
                required_perm
            );
        }

        // RBAC-gate-preview log (Sprint 6.4 gate activates here).
        debug!(
            "RBAC-gate-preview: command='{}' required_permission={:?} is_safety_critical={} (gate activates Sprint 6.4)",
            sanitize_for_log(&command.command),
            required_perm,
            is_safety_critical
        );

        // Batch 37 Sprint 6.4 partial: two-person-integrity
        // preview. ADR-018 §7 mandates a SECOND signature
        // (co-approval) for the `UpdateFirmware / DeployProgram
        // / ForceValue / SafeStateTrigger / Reboot` subset.
        // Pre-Sprint-6.4 we don't have an envelope carrying a
        // co-approver field; this warn-log surfaces the
        // pending requirement so operators planning rollout
        // know which commands will tighten:
        //
        // - Rollout sequencing: cloud signer adds co-approval
        //   field BEFORE edge enforcement flips on.
        // - Training anchor: operators running firmware
        //   updates or force commands get visible notice that
        //   the workflow will require a second operator.
        // - Audit-entry anchor: Sprint 6.2 sink records this
        //   field as `two_person_integrity_pending` until
        //   Sprint 6.4 switches it to `required` /
        //   `verified` / `rejected_co_approval`.
        let requires_two_person = required_perm
            .as_ref()
            .map(|p| p.requires_two_person_integrity())
            .unwrap_or(false);
        if requires_two_person {
            warn!(
                "TWO-PERSON-INTEGRITY preview: command='{}' requires Sprint 6.4 co-approval (ADR-018 §7). \
                 Pre-Sprint-6.4 accepted without second signature; plan rollout to update cloud signer first.",
                sanitize_for_log(&command.command)
            );
        }

        let (success, result, error) = match command.command.as_str() {
            "ping" => self.cmd_ping().await,
            "get_info" => self.cmd_get_info().await,
            "get_config" => self.cmd_get_config().await,
            "get_hardware" => self.cmd_get_hardware().await,
            "scan_hardware" => self.cmd_scan_hardware().await,
            "read_modbus" => self.cmd_read_modbus(&command.params).await,
            "write_modbus" => self.cmd_write_modbus(&command.params).await,
            "read_gpio" => self.cmd_read_gpio().await,
            "write_gpio" => self.cmd_write_gpio(&command.params).await,
            // Script commands
            "list_scripts" => self.cmd_list_scripts().await,
            "get_script" => self.cmd_get_script(&command.params).await,
            "deploy_script" => self.cmd_deploy_script(&command.params).await,
            "delete_script" => self.cmd_delete_script(&command.params).await,
            "enable_script" => self.cmd_enable_script(&command.params).await,
            "disable_script" => self.cmd_disable_script(&command.params).await,
            // IEC 61131-3 Program commands (v2.1)
            "deploy_program" => self.cmd_deploy_program(&command.params).await,
            "get_program" => self.cmd_get_program().await,
            "rollback_program" => self.cmd_rollback_program().await,
            // PLC Programming commands (v1.3.0)
            "plc_upload" => self.cmd_plc_upload(&command.params).await,
            "plc_status" => self.cmd_plc_status(&command.params).await,
            "plc_start" => self.cmd_plc_start(&command.params).await,
            "plc_stop" => self.cmd_plc_stop(&command.params).await,
            "plc_list" => self.cmd_plc_list(&command.params).await,
            "plc_download" => self.cmd_plc_download(&command.params).await,
            "plc_delete" => self.cmd_plc_delete(&command.params).await,
            // Deploy orchestrator commands (v2.2)
            "deploy_to_codesys" => self.cmd_deploy_to_codesys(&command.params).await,
            "deploy_auto" => self.cmd_deploy_auto(&command.params).await,
            "validate_st" => self.cmd_validate_st(&command.params).await,
            // System commands
            "reboot" => self.cmd_reboot(&command.params).await,
            "restart_agent" => self.cmd_restart_agent().await,
            "update_firmware" => self.cmd_update_firmware(command).await,
            "set_log_level" => self.cmd_set_log_level(&command.params).await,
            // Failover commands (v1.3.4)
            "failover_status" => self.cmd_failover_status().await,
            "failover_force" => self.cmd_failover_force().await,
            "failover_recover" => self.cmd_failover_recover().await,
            // I/O config and output commands
            "update_io_config" => self.cmd_update_io_config(&command.params).await,
            "set_output" => self.cmd_set_output(&command.params).await,
            // SCADA display commands (v1.6.0)
            #[cfg(feature = "scada-display")]
            "deploy_process" => self.cmd_deploy_process(&command.params).await,
            #[cfg(feature = "scada-display")]
            "deploy_scada_package" => self.cmd_deploy_scada_package(&command.params).await,
            #[cfg(feature = "scada-display")]
            "display_on" => self.cmd_display_on().await,
            #[cfg(feature = "scada-display")]
            "display_off" => self.cmd_display_off().await,
            #[cfg(feature = "scada-display")]
            "get_display_status" => self.cmd_get_display_status().await,
            // LoRaWAN commands (v1.5.0)
            #[cfg(feature = "lorawan")]
            "update_lora_devices" => self.cmd_update_lora_devices(&command.params).await,
            #[cfg(feature = "lorawan")]
            "lora_downlink" => self.cmd_lora_downlink(&command.params).await,
            _ => {
                // v1.2.2: Sanitize user-provided command name to prevent log injection
                warn!("Unknown command: {}", sanitize_for_log(&command.command));
                (
                    false,
                    json!(null),
                    Some(format!(
                        "Unknown command: {}",
                        sanitize_for_log(&command.command)
                    )),
                )
            }
        };

        // v1.2.6: Log command completion with timing
        let elapsed = start_time.elapsed();
        if success {
            info!(
                "Command completed: id='{}', command='{}', success=true, duration={:?}",
                command.command_id,
                sanitize_for_log(&command.command),
                elapsed
            );
        } else {
            warn!(
                "Command failed: id='{}', command='{}', error={:?}, duration={:?}",
                command.command_id,
                sanitize_for_log(&command.command),
                error,
                elapsed
            );
        }

        // IEC 62443 SL-2: Audit log outcome of safety-critical commands
        if is_safety_critical {
            warn!(
                "AUDIT: Safety-critical command completed: command='{}', id='{}', device_id='{}', success={}, duration={:?}, timestamp='{}'",
                sanitize_for_log(&command.command),
                command.command_id,
                device_id,
                success,
                elapsed,
                Utc::now().to_rfc3339()
            );
        }

        CommandResponse {
            command_id: command.command_id.clone(),
            device_id,
            success,
            result,
            timestamp: Utc::now().to_rfc3339(),
            error,
        }
    }

    // Batch 20c ARC-008 god-file split: cmd_ping, cmd_get_info,
    // cmd_get_config moved to `commands/diagnostic.rs`. Dispatch
    // unchanged — the method calls in `execute_command` resolve to
    // the sub-module's `impl CommandHandler` block.

    // Batch 20g ARC-008 god-file split: cmd_reboot,
    // cmd_restart_agent moved to `commands/system.rs`.

    // Batch 20k ARC-008 god-file split: cmd_update_firmware
    // (5-stage OTA pipeline — resolve → download → verify →
    // install → restart) moved to commands/firmware.rs.

    // Batch 20c ARC-008 god-file split: cmd_set_log_level moved
    // to `commands/diagnostic.rs`. Dispatch unchanged.

    // Batch 20f ARC-008 god-file split: cmd_get_hardware,
    // cmd_scan_hardware, cmd_read_modbus moved to
    // `commands/read.rs`.

    // Batch 20h ARC-008 god-file split: cmd_write_modbus,
    // cmd_write_gpio moved to `commands/write.rs`.
    // Batch 20f ARC-008 god-file split: cmd_read_gpio moved to
    // `commands/read.rs`.

    // Batch 20e ARC-008 god-file split: cmd_list_scripts,
    // cmd_get_script, cmd_deploy_script, cmd_delete_script,
    // cmd_enable_script, cmd_disable_script moved to
    // `commands/script.rs`. Dispatch unchanged.

    // Batch 20l ARC-008 god-file split: cmd_deploy_program,
    // cmd_get_program, cmd_rollback_program moved to
    // commands/program.rs. Deploy-lock + atomic-persist +
    // rollback-on-failure contract documented inline.
    // Batch 20m ARC-008 god-file split: PLC programming
    // handlers (cmd_plc_upload, cmd_plc_status, cmd_plc_start,
    // cmd_plc_stop, cmd_plc_list, cmd_plc_download,
    // cmd_plc_delete) + 4 generic helpers
    // (upload_with_client, get_status_with_client,
    // start_with_client, plc_run_stop_helper) moved to
    // commands/plc.rs.

    // Batch 20n ARC-008 god-file split: deploy orchestrator
    // handlers (cmd_deploy_to_codesys, cmd_deploy_auto)
    // moved to commands/ide_deploy.rs.

    // Batch 20h ARC-008 god-file split: cmd_write_opcua,
    // cmd_write_s7 moved to `commands/write.rs` (both are honest
    // stubs; Sprint 6.x fills them in per plan §5 Faz 5).

    // Batch 20l ARC-008 god-file split: cmd_validate_st
    // moved to commands/program.rs.

    // Batch 20l ARC-008 god-file split: load_program_state,
    // save_program_state moved to commands/program.rs.

    /// Handle config update from cloud
    async fn handle_config_update(&self, payload: &[u8]) -> anyhow::Result<()> {
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

    // Batch 20d ARC-008 god-file split: cmd_failover_status,
    // cmd_failover_force, cmd_failover_recover moved to
    // `commands/failover.rs`. Dispatch unchanged.

    // Batch 20i ARC-008 god-file split: I/O config +
    // output-value handlers (cmd_update_io_config,
    // cmd_set_output) + parse_io_config_to_tags /
    // persist_io_config helpers moved to
    // commands/io_config.rs.

    // Batch 20j ARC-008 god-file split: LoRaWAN handlers
    // (cmd_update_lora_devices, cmd_lora_downlink) moved to
    // commands/lora.rs (feature-gated on lorawan).

    // Batch 20g ARC-008 god-file split: SCADA display
    // lifecycle handlers (cmd_deploy_process,
    // cmd_deploy_scada_package, cmd_display_on,
    // cmd_display_off, cmd_get_display_status) + the
    // convert_cloud_deploy_payload helper moved to
    // commands/system.rs (cfg-gated on feature
    // "scada-display").
}

// Batch 20k ARC-008 god-file split: firmware helper free
// functions (is_valid_github_repo, is_valid_version_string,
// resolve_firmware_version, fetch_latest_agent_tag,
// download_file, compute_sha256, read_checksum_file) moved
// to commands/firmware.rs as pub(super) module-private
// helpers.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_response_serialization() {
        let response = CommandResponse {
            command_id: "cmd-123".to_string(),
            device_id: "device-456".to_string(),
            success: true,
            result: json!({"pong": true}),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            error: None,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("command_id"));
        assert!(json.contains("pong"));
        assert!(!json.contains("error")); // None fields skipped
    }
}
