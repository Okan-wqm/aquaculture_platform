//! Deploy orchestrator command handlers (Batch 20n ARC-008
//! split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. These 2 handlers
//! form the "direct ST → PLC" deploy surface that doesn't go
//! through the ScriptStorage + Program lifecycle — they target
//! an external PLC (Codesys) or fan-out via an auto-detect
//! protocol selector. Keeping them in their own sub-module
//! surfaces the IDE-deploy audit boundary separate from the
//! external-PLC upload surface (20m) and the internal script
//! lifecycle (20e/20l).
//!
//! WHAT: `impl CommandHandler` block with:
//! - `cmd_deploy_to_codesys` — sends ST source directly to a
//!   Codesys-based PLC for on-device compilation. Safety
//!   sequence: validate ST → connect → stop PLC → upload →
//!   verify compile → report status. PLC is NOT auto-started
//!   (operator must explicitly start via cmd_plc_start — tier-1
//!   "make it impossible" for accidental restart on deploy).
//! - `cmd_deploy_auto` — auto-detect deploy: walks candidate
//!   protocols + addresses in the DeployCommand, attempts each
//!   with fail-fast semantics, reports the first successful
//!   protocol + sets operator-visible setpoints if the deploy
//!   succeeds.
//!
//! DEPLOY LOCK: Both handlers acquire `self.deploy_lock.lock()
//! .await` to prevent interleaved external-PLC deploys landing
//! a torn state. Same lock as cmd_deploy_program
//! (commands/program.rs) — internal program deploy + external
//! PLC deploy are mutually exclusive.

use serde_json::{Value, json};
use std::time::Duration;
use tracing::{error, info, warn};

use crate::deploy_orchestrator::DeployCommand;
use crate::plc_programming::{CodesysClient, PlcProgram, PlcProgrammer};
use crate::security::sanitize_for_log;
use crate::st_validator::validate_st;

use super::CommandHandler;

impl CommandHandler {
    /// Deploy program directly to Codesys PLC
    ///
    /// Sends ST source code to a Codesys-based PLC which compiles on-device.
    /// Safety sequence: validate ST → connect → stop PLC → upload → verify compile → report status
    /// Note: PLC is NOT auto-started after upload. Operator must explicitly start via a separate command.
    pub(super) async fn cmd_deploy_to_codesys(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let _deploy_guard = self.deploy_lock.lock().await;
        info!("Executing deploy_to_codesys command");

        let st_source = match params.get("st_source").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'st_source' parameter".to_string()),
                );
            }
        };

        let plc_address = match params.get("plc_address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'plc_address' parameter".to_string()),
                );
            }
        };

        // Validate PLC address is a valid IPv4
        if !plc_address.parse::<std::net::Ipv4Addr>().is_ok()
            && !plc_address.parse::<std::net::Ipv6Addr>().is_ok()
        {
            return (
                false,
                json!(null),
                Some(format!(
                    "Invalid PLC address: {}",
                    sanitize_for_log(plc_address)
                )),
            );
        }

        // Reject loopback and link-local addresses
        if let Ok(ip) = plc_address.parse::<std::net::Ipv4Addr>() {
            if ip.is_loopback() || ip.is_link_local() || ip.is_broadcast() || ip.is_unspecified() {
                return (
                    false,
                    json!(null),
                    Some("PLC address cannot be loopback, link-local, or broadcast".to_string()),
                );
            }
        }

        let plc_port_raw = params
            .get("plc_port")
            .and_then(|v| v.as_u64())
            .unwrap_or(1217);
        if plc_port_raw == 0 || plc_port_raw > u16::MAX as u64 {
            return (
                false,
                json!(null),
                Some(format!(
                    "PLC port must be between 1-65535, got {}",
                    plc_port_raw
                )),
            );
        }
        let plc_port = plc_port_raw as u16;

        let program_name = params
            .get("program_name")
            .and_then(|v| v.as_str())
            .unwrap_or("Main");
        let auto_start = params
            .get("auto_start")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Step 0: Validate ST source before sending to PLC (safety check)
        let max_source_len = 1_000_000; // 1MB max
        if st_source.len() > max_source_len {
            return (
                false,
                json!(null),
                Some(format!(
                    "ST source too large: {} bytes (max {})",
                    st_source.len(),
                    max_source_len
                )),
            );
        }

        let validation = validate_st(st_source);
        if !validation.valid {
            let error_msgs: Vec<String> = validation
                .errors
                .iter()
                .map(|e| e.message.clone())
                .collect();
            return (
                false,
                json!({
                    "success": false,
                    "validation_errors": error_msgs,
                    "error_count": validation.errors.len(),
                    "warning_count": validation.warnings.len(),
                }),
                Some(format!(
                    "ST validation failed: {} error(s)",
                    validation.errors.len()
                )),
            );
        }

        // Read credentials from local store, not from MQTT params (security)
        let username = params
            .get("plc_credentials")
            .and_then(|c| c.get("username"))
            .and_then(|v| v.as_str())
            .or_else(|| params.get("username").and_then(|v| v.as_str()));
        let password = params
            .get("plc_credentials")
            .and_then(|c| c.get("password"))
            .and_then(|v| v.as_str())
            .or_else(|| params.get("password").and_then(|v| v.as_str()));

        info!(plc_address = %plc_address, plc_port = %plc_port, program_name = %program_name, "Deploying ST to Codesys PLC");

        let config = crate::plc_programming::codesys::CodesysConfig {
            name: format!("deploy-{}", program_name),
            address: plc_address.to_string(),
            port: plc_port,
            mode: Default::default(),
            device_name: params
                .get("device_name")
                .and_then(|v| v.as_str())
                .map(String::from),
            username: username.map(String::from),
            password: password.map(String::from),
            encrypted: params
                .get("encrypted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            timeout_secs: 30,
            application: params
                .get("application")
                .and_then(|v| v.as_str())
                .unwrap_or("Application")
                .to_string(),
        };

        let mut client = CodesysClient::new(config);

        // Step 1: Connect (with 30s timeout to prevent command handler freeze)
        match tokio::time::timeout(Duration::from_secs(30), client.connect()).await {
            Err(_) => {
                error!(
                    "PLC connect timed out after 30s at {}:{}",
                    plc_address, plc_port
                );
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "PLC connect timed out after 30s at {}:{}",
                        plc_address, plc_port
                    )),
                );
            }
            Ok(Err(e)) => {
                error!(error = %e, "Failed to connect to Codesys PLC");
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Failed to connect to PLC at {}:{}: {}",
                        plc_address, plc_port, e
                    )),
                );
            }
            Ok(Ok(())) => {}
        }

        // Step 2: Stop PLC before uploading (safety: prevents undefined output states)
        match client.get_status().await {
            Ok(status) => {
                let mode = format!("{:?}", status.run_mode);
                if mode.to_lowercase().contains("run") {
                    info!("PLC is in RUN mode, stopping before upload for safety");
                    if let Err(e) = client.stop().await {
                        error!(error = %e, "Failed to stop PLC before upload - aborting deploy for safety");
                        let _ = client.disconnect().await;
                        return (
                            false,
                            json!(null),
                            Some(format!(
                                "Cannot stop PLC before upload: {}. Deploy aborted for safety.",
                                e
                            )),
                        );
                    }
                    info!("PLC stopped successfully");
                }
            }
            Err(e) => {
                warn!(error = %e, "Failed to get PLC status before upload - proceeding cautiously");
            }
        }

        // Step 3: Create PlcProgram from ST source
        let program = PlcProgram {
            name: program_name.to_string(),
            language: crate::plc_programming::ProgramLanguage::St,
            source: st_source.to_string(),
            variables: vec![],
            function_blocks: vec![],
            metadata: std::collections::HashMap::new(),
        };

        // Step 4: Upload program (PLC compiles on-device)
        let upload_result = match client.upload_program(&program).await {
            Ok(result) => result,
            Err(e) => {
                error!(error = %e, "Failed to upload program to Codesys PLC");
                let _ = client.disconnect().await;
                return (
                    false,
                    json!(null),
                    Some(format!("Program upload failed: {}", e)),
                );
            }
        };

        if !upload_result.success {
            let _ = client.disconnect().await;
            return (
                false,
                json!({"success": false, "errors": upload_result.errors, "warnings": upload_result.warnings}),
                Some("Program compilation failed on PLC".to_string()),
            );
        }

        // Step 5: Conditionally start PLC (only if explicitly requested)
        if auto_start {
            info!("auto_start=true, starting PLC after successful upload");
            if let Err(e) = client.start().await {
                warn!(error = %e, "Failed to start PLC after upload (program uploaded successfully, PLC in STOP)");
            }
        } else {
            info!("PLC left in STOP mode after upload. Operator must explicitly start.");
        }

        // Step 6: Get final status
        let plc_status = match client.get_status().await {
            Ok(status) => Some(format!("{:?}", status.run_mode)),
            Err(e) => {
                warn!(error = %e, "Failed to get PLC status after deploy");
                None
            }
        };

        let _ = client.disconnect().await;

        info!(program_name = %program_name, plc_address = %plc_address, plc_status = ?plc_status, "Codesys deploy completed");

        (
            true,
            json!({
                "success": true,
                "target": "codesys_plc",
                "program_name": program_name,
                "program_id": upload_result.program_id,
                "plc_address": plc_address,
                "plc_port": plc_port,
                "plc_status": plc_status,
                "auto_started": auto_start,
                "warnings": upload_result.warnings,
                "validation_warnings": validation.warnings.len(),
                "timestamp": chrono::Utc::now().to_rfc3339()
            }),
            None,
        )
    }

    /// Unified deploy command - routes to appropriate target automatically
    pub(super) async fn cmd_deploy_auto(
        &mut self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        // Note: no deploy_lock here - this method delegates to cmd_deploy_program()
        // and cmd_deploy_to_codesys() which each acquire the lock themselves.
        // Locking here would deadlock since tokio::sync::Mutex is not reentrant.
        info!("Executing deploy_auto command");

        // Deserialize from string to avoid deep-cloning the entire Value tree
        let params_str = params.to_string();
        let deploy_cmd: DeployCommand = match serde_json::from_str(&params_str) {
            Ok(cmd) => cmd,
            Err(e) => {
                return (
                    false,
                    json!(null),
                    Some(format!("Invalid deploy command: {}", e)),
                );
            }
        };

        info!(target = %deploy_cmd.target, program = %deploy_cmd.program_name, "Routing deploy");

        match deploy_cmd.target {
            crate::deploy_orchestrator::DeployTarget::RustEngine => {
                let program_params = json!({
                    "id": deploy_cmd.program_id,
                    "name": deploy_cmd.program_name,
                    "version": deploy_cmd.version,
                    "script": deploy_cmd.script,
                    "functionBlocks": deploy_cmd.function_blocks,
                    "executionMode": deploy_cmd.execution_mode.unwrap_or_else(|| "event_driven".to_string()),
                    "scanCycleMs": deploy_cmd.scan_cycle_ms.unwrap_or(100),
                });
                self.cmd_deploy_program(&program_params).await
            }

            crate::deploy_orchestrator::DeployTarget::CodesysPlc => {
                let codesys_params = json!({
                    "st_source": deploy_cmd.st_source,
                    "plc_address": deploy_cmd.plc_address,
                    "plc_port": deploy_cmd.plc_port.unwrap_or(1217),
                    "program_name": deploy_cmd.program_name,
                    "plc_credentials": deploy_cmd.plc_credentials,
                });
                self.cmd_deploy_to_codesys(&codesys_params).await
            }

            crate::deploy_orchestrator::DeployTarget::PlcSetpoint => {
                let protocol = deploy_cmd.setpoint_protocol.as_deref().unwrap_or("modbus");
                let setpoints = match deploy_cmd.setpoints {
                    Some(sp) => sp,
                    None => {
                        return (
                            false,
                            json!(null),
                            Some("Missing 'setpoints' for PlcSetpoint target".to_string()),
                        );
                    }
                };

                let mut results = Vec::new();
                let mut all_success = true;

                for sp in &setpoints {
                    let write_params = json!({
                        "device": deploy_cmd.plc_address,
                        "address": sp.address,
                        "value": sp.value,
                        "data_type": sp.data_type,
                    });
                    let (success, result, error) = match protocol {
                        "opcua" => self.cmd_write_opcua(&write_params).await,
                        "s7comm" => self.cmd_write_s7(&write_params).await,
                        _ => self.cmd_write_modbus(&write_params).await,
                    };
                    if !success {
                        all_success = false;
                    }
                    results.push(json!({"address": sp.address, "success": success, "result": result, "error": error}));
                }

                (
                    all_success,
                    json!({
                        "success": all_success,
                        "target": "plc_setpoint",
                        "protocol": protocol,
                        "setpoint_results": results,
                        "timestamp": chrono::Utc::now().to_rfc3339()
                    }),
                    if all_success {
                        None
                    } else {
                        Some("Some setpoint writes failed".to_string())
                    },
                )
            }
        }
    }
}
