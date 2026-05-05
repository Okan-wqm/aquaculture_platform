//! Module: commands::plc::status
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
//! cmd_plc_status — query an external PLC for running state +
//! active program name. get_status_with_client wraps the
//! connect → query → disconnect lifecycle. Read-only path; no
//! state mutation on the target PLC.

use serde_json::{Value, json};
use std::time::Duration;
use tracing::{error, info};

use crate::plc_programming::{
    AdsClient, CodesysClient, EtherNetIpClient, OpcUaClient, PlcProgram, PlcProgrammer, S7Client,
};

impl super::super::CommandHandler {
    /// Get PLC status
    pub(in crate::commands) async fn cmd_plc_status(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing plc_status command");

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

        // Create client based on protocol and get status
        let status_result = match protocol.to_lowercase().as_str() {
            "codesys" => {
                let config = crate::plc_programming::codesys::CodesysConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(1217) as u16,
                    mode: Default::default(),
                    device_name: None,
                    username: None,
                    password: None,
                    encrypted: false,
                    timeout_secs: 30,
                    application: "Application".to_string(),
                };
                let mut client = CodesysClient::new(config);
                Self::get_status_with_client(&mut client).await
            }
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
                Self::get_status_with_client(&mut client).await
            }
            "opcua" => {
                let config = crate::plc_programming::opcua::OpcUaConfig {
                    name: "remote".to_string(),
                    endpoint_url: format!(
                        "opc.tcp://{}:{}",
                        address,
                        params.get("port").and_then(|v| v.as_u64()).unwrap_or(4840)
                    ),
                    security_policy: Default::default(),
                    security_mode: Default::default(),
                    username: None,
                    password: None,
                    client_cert_path: None,
                    client_key_path: None,
                    timeout_secs: 30,
                    session_timeout_ms: 30000,
                    program_namespace: None,
                };
                let mut client = OpcUaClient::new(config);
                Self::get_status_with_client(&mut client).await
            }
            "ethernet_ip" => {
                let config = crate::plc_programming::ethernet_ip::EtherNetIpConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(44818) as u16,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    connection_path: None,
                    timeout_secs: 30,
                    plc_type: Default::default(),
                };
                let mut client = EtherNetIpClient::new(config);
                Self::get_status_with_client(&mut client).await
            }
            "ads" => {
                let ams_net_id = match params.get("ams_net_id").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => {
                        return (
                            false,
                            json!(null),
                            Some("Missing 'ams_net_id' parameter".to_string()),
                        );
                    }
                };
                let config = crate::plc_programming::ads::AdsConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: 48898,
                    target_ams_net_id: ams_net_id,
                    target_ams_port: 851,
                    source_ams_net_id: None,
                    source_ams_port: 32768,
                    timeout_secs: 30,
                    twincat_version: Default::default(),
                };
                match AdsClient::new(config) {
                    Ok(mut client) => Self::get_status_with_client(&mut client).await,
                    Err(e) => Err(e),
                }
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("Unknown protocol: {}", protocol)),
                );
            }
        };

        match status_result {
            Ok(status) => (
                true,
                json!({
                    "connected": status.connected,
                    "run_mode": format!("{:?}", status.run_mode),
                    "model": status.model,
                    "firmware": status.firmware,
                    "current_program": status.current_program,
                    "last_modified": status.last_modified
                }),
                None,
            ),
            Err(e) => (
                false,
                json!(null),
                Some(format!("Status check failed: {}", e)),
            ),
        }
    }

    /// Helper to get status using any PlcProgrammer client
    /// v2.3: Connect with 30-second timeout to prevent command handler freeze
    async fn get_status_with_client<P: PlcProgrammer>(
        client: &mut P,
    ) -> anyhow::Result<crate::plc_programming::PlcStatus> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let status = client.get_status().await;
        let _ = client.disconnect().await;
        status
    }
}
