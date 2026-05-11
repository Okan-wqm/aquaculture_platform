//! Module: commands::plc::upload
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
//! cmd_plc_upload — deploy a PlcProgram to an external PLC over
//! the configured protocol. Address-safety guards (reject
//! loopback / link-local / broadcast / unspecified) run before
//! any client connection. upload_with_client wraps the connect
//! → upload → disconnect lifecycle with a 30s connect timeout
//! to prevent command-handler freeze on dead PLCs.

use serde_json::{Value, json};
use std::time::Duration;
use tracing::{error, info};

use crate::plc_programming::{
    AdsClient, CodesysClient, EtherNetIpClient, OpcUaClient, PlcProgram, PlcProgrammer, S7Client,
};

impl super::super::CommandHandler {
    /// Upload program to external PLC
    ///
    /// Supported protocols: codesys, s7, opcua, ethernet_ip, ads
    pub(in crate::commands) async fn cmd_plc_upload(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        info!("Executing plc_upload command");

        // Parse protocol
        let protocol = match params.get("protocol").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some(
                        "Missing 'protocol' parameter (codesys, s7, opcua, ethernet_ip, ads)"
                            .to_string(),
                    ),
                );
            }
        };

        // Parse PLC address
        let address = match params.get("address").and_then(|v| v.as_str()) {
            Some(a) => a,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing 'address' parameter (PLC IP/hostname)".to_string()),
                );
            }
        };

        // Reject loopback, link-local, and broadcast addresses (consistent with deploy_to_codesys)
        if let Ok(ip) = address.parse::<std::net::Ipv4Addr>() {
            if ip.is_loopback() || ip.is_link_local() || ip.is_broadcast() || ip.is_unspecified() {
                return (
                    false,
                    json!(null),
                    Some("PLC address cannot be loopback, link-local, or broadcast".to_string()),
                );
            }
        }

        // Parse program
        let program: PlcProgram = match params
            .get("program")
            .and_then(|p| serde_json::from_value(p.clone()).ok())
        {
            Some(p) => p,
            None => {
                return (
                    false,
                    json!(null),
                    Some("Missing or invalid 'program' parameter".to_string()),
                );
            }
        };

        // Get optional authentication
        let username = params.get("username").and_then(|v| v.as_str());
        let password = params.get("password").and_then(|v| v.as_str());

        info!(
            protocol = %protocol,
            address = %address,
            program = %program.name,
            "Uploading program to PLC"
        );

        // Create appropriate client and upload
        let result = match protocol.to_lowercase().as_str() {
            "codesys" => {
                let config = crate::plc_programming::codesys::CodesysConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(1217) as u16,
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
                Self::upload_with_client(&mut client, &program).await
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
                Self::upload_with_client(&mut client, &program).await
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
                    username: username.map(String::from),
                    password: password.map(String::from),
                    client_cert_path: params
                        .get("client_cert_path")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    client_key_path: params
                        .get("client_key_path")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    timeout_secs: 30,
                    session_timeout_ms: 30000,
                    program_namespace: params
                        .get("program_namespace")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                };
                let mut client = OpcUaClient::new(config);
                Self::upload_with_client(&mut client, &program).await
            }
            "ethernet_ip" => {
                let config = crate::plc_programming::ethernet_ip::EtherNetIpConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(44818) as u16,
                    slot: params.get("slot").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                    connection_path: params
                        .get("connection_path")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    timeout_secs: 30,
                    plc_type: Default::default(),
                };
                let mut client = EtherNetIpClient::new(config);
                Self::upload_with_client(&mut client, &program).await
            }
            "ads" => {
                let ams_net_id = match params.get("ams_net_id").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => {
                        return (
                            false,
                            json!(null),
                            Some("Missing 'ams_net_id' parameter for ADS protocol".to_string()),
                        );
                    }
                };
                let config = crate::plc_programming::ads::AdsConfig {
                    name: "remote".to_string(),
                    address: address.to_string(),
                    port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(48898) as u16,
                    target_ams_net_id: ams_net_id,
                    target_ams_port: params
                        .get("target_ams_port")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(851) as u16,
                    source_ams_net_id: params
                        .get("source_ams_net_id")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    source_ams_port: 32768,
                    timeout_secs: 30,
                    twincat_version: Default::default(),
                };
                match AdsClient::new(config) {
                    Ok(mut client) => Self::upload_with_client(&mut client, &program).await,
                    Err(e) => Err(e),
                }
            }
            _ => {
                return (
                    false,
                    json!(null),
                    Some(format!(
                        "Unknown protocol: {}. Supported: codesys, s7, opcua, ethernet_ip, ads",
                        protocol
                    )),
                );
            }
        };

        match result {
            Ok(upload_result) => {
                if upload_result.success {
                    info!(
                        program = %program.name,
                        protocol = %protocol,
                        "Program uploaded successfully"
                    );
                    (
                        true,
                        json!({
                            "success": true,
                            "program_name": program.name,
                            "program_id": upload_result.program_id,
                            "warnings": upload_result.warnings,
                            "timestamp": upload_result.timestamp
                        }),
                        None,
                    )
                } else {
                    (
                        false,
                        json!({
                            "success": false,
                            "errors": upload_result.errors,
                            "warnings": upload_result.warnings
                        }),
                        Some("Program compilation/upload failed".to_string()),
                    )
                }
            }
            Err(e) => {
                error!(error = %e, "PLC upload failed");
                (false, json!(null), Some(format!("Upload failed: {}", e)))
            }
        }
    }

    /// Helper to upload program using any PlcProgrammer client
    /// v2.3: Connect with 30-second timeout to prevent command handler freeze
    async fn upload_with_client<P: PlcProgrammer>(
        client: &mut P,
        program: &PlcProgram,
    ) -> anyhow::Result<crate::plc_programming::UploadResult> {
        tokio::time::timeout(Duration::from_secs(30), client.connect())
            .await
            .map_err(|_| anyhow::anyhow!("PLC connect timed out after 30s"))??;
        let result = client.upload_program(program).await;
        let _ = client.disconnect().await; // Best effort disconnect
        result
    }
}
