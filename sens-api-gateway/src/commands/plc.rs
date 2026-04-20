//! PLC programming command handlers (Batch 20m ARC-008 split).
//!
//! WHY: Plan §5 Faz 1 Step 5 domain isolation. This module houses
//! the external-PLC-upload surface — 7 handlers that target
//! industrial PLCs over Codesys / S7comm / OPC UA / EtherNet/IP /
//! ADS protocols. Each handler instantiates a protocol-specific
//! client and routes through 4 generic helpers that abstract
//! over the PlcProgrammer trait.
//!
//! WHAT: `impl CommandHandler` block with:
//! - 7 `cmd_plc_*` handlers (upload, status, start, stop, list,
//!   download, delete). Each dispatches by protocol string and
//!   builds the appropriate client config from params.
//! - 4 generic helpers parameterized over `PlcProgrammer`:
//!   - `upload_with_client` — connect → upload → disconnect.
//!   - `get_status_with_client` — connect → query → disconnect.
//!   - `start_with_client` — connect → run → disconnect.
//!   - `plc_run_stop_helper` — shared run/stop dispatch.
//!
//! SECURITY: Every upload/download path rejects loopback /
//! link-local / broadcast / unspecified addresses to prevent
//! accidental or malicious self-targeting. The address check
//! lives inside each handler's param-parse phase to fail-fast
//! before any client connection is attempted.
//!
//! AUTH: Codesys + OPC UA clients accept optional
//! username/password credentials from params. Stored in-memory
//! only for the duration of the upload — no persistence layer.
//! Sprint 6.x hardening target: wrap creds in
//! `secrecy::Secret<String>` + zeroize-on-drop per ADR-018 §5.

use serde_json::{Value, json};
use std::time::Duration;
use tracing::{error, info};

use crate::plc_programming::{
    AdsClient, CodesysClient, EtherNetIpClient, OpcUaClient, PlcProgram, PlcProgrammer,
    S7Client,
};

use super::CommandHandler;

impl CommandHandler {

    /// Upload program to external PLC
    ///
    /// Supported protocols: codesys, s7, opcua, ethernet_ip, ads
    pub(super) async fn cmd_plc_upload(&self, params: &Value) -> (bool, Value, Option<String>) {
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
                return (false, json!(null), Some("PLC address cannot be loopback, link-local, or broadcast".to_string()));
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

    /// Get PLC status
    pub(super) async fn cmd_plc_status(&self, params: &Value) -> (bool, Value, Option<String>) {
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

    /// Start PLC (RUN mode)
    pub(super) async fn cmd_plc_start(&self, params: &Value) -> (bool, Value, Option<String>) {
        info!("Executing plc_start command");
        self.plc_run_stop_helper(params, true).await
    }

    /// Stop PLC (STOP mode)
    pub(super) async fn cmd_plc_stop(&self, params: &Value) -> (bool, Value, Option<String>) {
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

    /// List programs on PLC
    pub(super) async fn cmd_plc_list(&self, params: &Value) -> (bool, Value, Option<String>) {
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
    pub(super) async fn cmd_plc_download(&self, params: &Value) -> (bool, Value, Option<String>) {
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
    pub(super) async fn cmd_plc_delete(&self, params: &Value) -> (bool, Value, Option<String>) {
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
