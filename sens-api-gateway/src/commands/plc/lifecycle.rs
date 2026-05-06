//! Module: commands::plc::lifecycle
//!
//! ## Why this module exists (Batch #303 ULTRA-HIGH-013 ceiling)
//!
//! Pre-Batch-#303 commands/plc.rs was a single 856-line file
//! that violated the ≤500-line ceiling. Batch #303 split the
//! 7 cmd_plc_* handlers + 7 generic *_with_client helpers
//! across 4 sibling files keyed by command-class:
//!
//!   - upload.rs    — cmd_plc_upload + upload_with_client
//!                    (deploy a PlcProgram to an external PLC
//!                    over Codesys / S7 / OPC UA / EtherNet/IP /
//!                    ADS protocols)
//!   - status.rs    — cmd_plc_status + get_status_with_client
//!                    (query running state + active program)
//!   - lifecycle.rs — cmd_plc_start + cmd_plc_stop + helpers
//!                    (run/stop transitions)
//!   - catalog.rs   — cmd_plc_list + cmd_plc_download +
//!                    cmd_plc_delete + helpers (manage stored
//!                    programs on the PLC)
//!
//! Each file is its own `impl super::super::CommandHandler`
//! block. Method visibility stays `pub(super)` (only callable
//! from the parent commands tree); the dispatch table in
//! commands/dispatch_lifecycle.rs's match arm calls them
//! unchanged from the pre-split shape.
//!
//! ## Shared imports
//!
//! Every sub-file uses serde_json, std::time::Duration, tracing
//! macros, and the crate::plc_programming protocol clients
//! (Codesys / S7 / OPC UA / EtherNet/IP / ADS). Each sub-file
//! imports only what its handlers need so that adding a 6th
//! protocol surfaces only in the affected sub-file.

//!
//! cmd_plc_start + cmd_plc_stop — transition an external PLC
//! between RUN and STOP states. start_with_client +
//! stop_with_client wrap the connect → command → disconnect
//! lifecycle. State-mutating path; the dispatch-layer RBAC
//! gate (Permission::DeployProgram) runs upstream.

use serde_json::{Value, json};
use std::time::Duration;
use tracing::info;

use crate::plc_programming::{CodesysClient, PlcProgrammer, S7Client};

impl super::super::CommandHandler {
    pub(in crate::commands) async fn cmd_plc_start(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_start command");
        self.plc_run_stop_helper(params, true).await
    }

    /// Stop PLC (STOP mode)
    pub(in crate::commands) async fn cmd_plc_stop(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_stop command");
        self.plc_run_stop_helper(params, false).await
    }

    /// Helper for start/stop commands
    async fn plc_run_stop_helper(
        &self,
        params: &Value,
        start: bool,
    ) -> (bool, Value, Option<String>) {
        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'protocol' parameter".to_string()),
                );
            }
        };

        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter".to_string()),
                );
            }
        };

        // Only supporting S7 for run/stop initially (most common use case)
        let result = match protocol.to_lowercase().as_str() {
            "s7" => {
                let config = crate::plc_programming::s7comm::S7Config {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(102) as u16,
                    rack: params.get("rack").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                    plc_type: Default::default(),
                    timeout_secs: 30,
                    pdu_size: 480,
                };
                let mut client = S7Client::new(config);
                if start {
                    Self::start_with_client(&mut client).await
                } else {
                    Self::stop_with_client(&mut client).await
                }
            }
            "codesys" => {
                let config = crate::plc_programming::codesys::CodesysConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: 1217,
                    mode: Default::default(),
                    device_name: None,
                    username: None,
                    password: None,
                    encrypted: false,
                    timeout_secs: 30,
                    application: "Application".to_string(),
                };
                let mut client = CodesysClient::new(config);
                if start {
                    Self::start_with_client(&mut client).await
                } else {
                    Self::stop_with_client(&mut client).await
                }
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Start/Stop not supported for protocol: {}",
                        protocol
                    )),
                );
            }
        };

        match result {
            Ok(()) => {
                let action = if start { "started" } else { "stopped" };
                info!(protocol = %protocol, address = %address, "PLC {}", action);
                (true, json!({"success": true, "action": action}), None)
            }
            Err(e) => {
                let action = if start { "start" } else { "stop" };
                (
                    false,
                    json!(null),
                    Some(format!("PLC {} failed: {}", action, e)),
                )
            }
        }
    }

    /// Helper to start PLC
    /// v2.3: Connect with 30-second timeout
    async fn start_with_client<P: PlcProgrammer>(client: &mut P) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.start().await;
        let _ = client.disconnect().await;
        result
    }

    /// Helper to stop PLC
    /// v2.3: Connect with 30-second timeout
    async fn stop_with_client<P: PlcProgrammer>(client: &mut P) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.stop().await;
        let _ = client.disconnect().await;
        result
    }

}
