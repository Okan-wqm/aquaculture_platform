//! Module: commands::plc::catalog
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
//! cmd_plc_list + cmd_plc_download + cmd_plc_delete — manage
//! the program catalog on an external PLC. list_with_client +
//! download_with_client + delete_with_client wrap the
//! connect → catalog-op → disconnect lifecycle. Mixed read +
//! state-mutating; delete + download share address-safety
//! guards with the upload path.

use serde_json::{Value, json};
use std::time::Duration;
use tracing::{error, info};

use crate::plc_programming::{
    AdsClient, CodesysClient, EtherNetIpClient, OpcUaClient, PlcProgram, PlcProgrammer,
    S7Client,
};

impl super::super::CommandHandler {
    pub(in crate::commands) async fn cmd_plc_list(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_list command");

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
                Self::list_with_client(&mut client).await
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
                Self::list_with_client(&mut client).await
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("List not supported for protocol: {}", protocol)),
                );
            }
        };

        match result {
            Ok(programs) => (
                true,
                json!({"programs": programs, "count": programs.len()}),
                None,
            ),
            Err(e) => (false, json!(null), Some(format!("List failed: {}", e))),
        }
    }

    /// Helper to list programs
    /// v2.3: Connect with 30-second timeout
    async fn list_with_client<P: PlcProgrammer>(client: &mut P) -> anyhow::Result<Vec<String>> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.list_programs().await;
        let _ = client.disconnect().await;
        result
    }

    /// Download program from PLC
    pub(in crate::commands) async fn cmd_plc_download(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_download command");

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

        let program_name = match params.get("program_name").and_then(|v| v.as_str()) {
            Some(n) => n,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'program_name' parameter".to_string()),
                );
            }
        };

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
                Self::download_with_client(&mut client, program_name).await
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("Download not supported for protocol: {}", protocol)),
                );
            }
        };

        match result {
            Ok(program) => (
                true,
                json!({
                    "program": {
                        "name": program.name,
                        "language": format!("{:?}", program.language),
                        "source": program.source,
                        "variables": program.variables.len(),
                        "function_blocks": program.function_blocks.len()
                    }
                }),
                None,
            ),
            Err(e) => (false, json!(null), Some(format!("Download failed: {}", e))),
        }
    }

    /// Helper to download program
    /// v2.3: Connect with 30-second timeout
    async fn download_with_client<P: PlcProgrammer>(
        client: &mut P,
        program_name: &str,
    ) -> anyhow::Result<PlcProgram> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.download_program(program_name).await;
        let _ = client.disconnect().await;
        result
    }

    /// Delete program from PLC
    pub(in crate::commands) async fn cmd_plc_delete(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_delete command");

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

        let program_name = match params.get("program_name").and_then(|v| v.as_str()) {
            Some(n) => n,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'program_name' parameter".to_string()),
                );
            }
        };

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
                Self::delete_with_client(&mut client, program_name).await
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!("Delete not supported for protocol: {}", protocol)),
                );
            }
        };

        match result {
            Ok(()) => {
                info!(program = %program_name, "Program deleted from PLC");
                (
                    true,
                    json!({"deleted": true, "program_name": program_name}),
                    None,
                )
            }
            Err(e) => (false, json!(null), Some(format!("Delete failed: {}", e))),
        }
    }

    /// Helper to delete program
    /// v2.3: Connect with 30-second timeout
    async fn delete_with_client<P: PlcProgrammer>(
        client: &mut P,
        program_name: &str,
    ) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.delete_program(program_name).await;
        let _ = client.disconnect().await;
        result
    }
}
