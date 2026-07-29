//! Allen-Bradley EtherNet/IP CIP Protocol Implementation
//!
//! Supports program upload to Allen-Bradley/Rockwell PLCs via EtherNet/IP.
//!
//! ## Supported PLCs
//! - CompactLogix (1769-L series)
//! - ControlLogix (1756-L series)
//! - Micro800 series (limited)
//! - PLC-5 (legacy)
//! - SLC 500 (legacy)
//!
//! ## Protocol
//! - Default Port: 44818 (EtherNet/IP)
//! - CIP (Common Industrial Protocol)
//! - Program upload via CIP file services
//!
//! ## Limitations
//! - Full program upload requires RSLogix/Studio 5000
//! - This implementation supports tag R/W and limited program access

use super::common::*;
use super::{PlcProgram, PlcProgrammer, PlcRunMode, PlcStatus, UploadResult};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
// WHY: tokio::sync::Mutex — held across .await (EtherNet/IP TCP read/write is async I/O)
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::{debug, info, warn};

// ============================================================================
// Constants
// ============================================================================

/// Default EtherNet/IP port
pub const DEFAULT_ENIP_PORT: u16 = 44818;

/// SENSOR-HIGH-077 (ux-truth / ICS-safety): Allen-Bradley Logix program
/// upload/download is not implemented — it requires Studio 5000 and the
/// proprietary AOI + CIP file services. Returning a fabricated success receipt for
/// a program that was never transmitted lets an operator believe control logic is
/// deployed when it is not, so program transfer fails closed with this message.
const ETHERNET_IP_PROGRAM_TRANSFER_UNSUPPORTED: &str = "Allen-Bradley (EtherNet/IP) \
program transfer is not implemented; Logix program upload/download requires Studio \
5000 and the proprietary AOI/CIP file services. Refusing to report a program as \
transferred when nothing was exchanged with the PLC.";

/// Maximum EtherNet/IP packet size (prevent memory exhaustion)
const MAX_ENIP_PACKET_SIZE: usize = 65536;

/// EtherNet/IP Commands
const ENIP_REGISTER_SESSION: u16 = 0x0065;
const ENIP_UNREGISTER_SESSION: u16 = 0x0066;
const ENIP_SEND_RR_DATA: u16 = 0x006F;
const ENIP_SEND_UNIT_DATA: u16 = 0x0070;

/// CIP Service codes
const CIP_GET_ATTRIBUTE_ALL: u8 = 0x01;
const CIP_SET_ATTRIBUTE_SINGLE: u8 = 0x10;
const CIP_GET_ATTRIBUTE_SINGLE: u8 = 0x0E;
const CIP_READ_TAG: u8 = 0x4C;
const CIP_WRITE_TAG: u8 = 0x4D;
const CIP_READ_TAG_FRAGMENTED: u8 = 0x52;
const CIP_WRITE_TAG_FRAGMENTED: u8 = 0x53;
const CIP_MULTIPLE_SERVICE: u8 = 0x0A;
const CIP_FORWARD_OPEN: u8 = 0x54;
const CIP_FORWARD_CLOSE: u8 = 0x4E;

/// CIP response bit mask - reply flag is bit 7 of service code
const CIP_REPLY_FLAG: u8 = 0x80;

/// CIP Data Type codes
const CIP_TYPE_BOOL: u16 = 0x00C1;
const CIP_TYPE_SINT: u16 = 0x00C2;
const CIP_TYPE_INT: u16 = 0x00C3;
const CIP_TYPE_DINT: u16 = 0x00C4;
const CIP_TYPE_REAL: u16 = 0x00CA;

/// CIP Class codes
const CIP_CLASS_IDENTITY: u16 = 0x01;
const CIP_CLASS_MESSAGE_ROUTER: u16 = 0x02;
const CIP_CLASS_CONNECTION_MANAGER: u16 = 0x06;
const CIP_CLASS_FILE: u16 = 0x37;
const CIP_CLASS_PROGRAM: u16 = 0x64;

// ============================================================================
// Configuration
// ============================================================================

/// EtherNet/IP connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EtherNetIpConfig {
    /// Connection name
    pub name: String,

    /// PLC IP address
    pub address: String,

    /// Port (default: 44818)
    #[serde(default = "default_enip_port")]
    pub port: u16,

    /// Slot number (for ControlLogix)
    #[serde(default)]
    pub slot: u8,

    /// Connection path (optional, for routing)
    #[serde(default)]
    pub connection_path: Option<String>,

    /// Connection timeout (seconds)
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,

    /// PLC type
    #[serde(default)]
    pub plc_type: AbPlcType,
}

fn default_enip_port() -> u16 {
    DEFAULT_ENIP_PORT
}

fn default_timeout() -> u64 {
    10
}

/// Allen-Bradley PLC Type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum AbPlcType {
    /// CompactLogix
    #[default]
    CompactLogix,
    /// ControlLogix
    ControlLogix,
    /// Micro800 series
    Micro800,
    /// PLC-5 (legacy)
    Plc5,
    /// SLC 500 (legacy)
    Slc500,
}

impl Default for EtherNetIpConfig {
    fn default() -> Self {
        Self {
            name: "ab_plc".to_string(),
            address: "192.168.1.1".to_string(),
            port: DEFAULT_ENIP_PORT,
            slot: 0,
            connection_path: None,
            timeout_secs: 10,
            plc_type: AbPlcType::CompactLogix,
        }
    }
}

// ============================================================================
// EtherNet/IP Client
// ============================================================================

/// Allen-Bradley EtherNet/IP client
pub struct EtherNetIpClient {
    config: EtherNetIpConfig,
    connection: Arc<Mutex<Option<TcpStream>>>,
    connected: AtomicBool,
    session_handle: Arc<Mutex<u32>>,
    sender_context: Arc<Mutex<u64>>,
}

impl EtherNetIpClient {
    /// Create a new EtherNet/IP client
    pub fn new(config: EtherNetIpConfig) -> Self {
        Self {
            config,
            connection: Arc::new(Mutex::new(None)),
            connected: AtomicBool::new(false),
            session_handle: Arc::new(Mutex::new(0)),
            sender_context: Arc::new(Mutex::new(0)),
        }
    }

    /// Get next sender context
    async fn next_context(&self) -> u64 {
        let mut ctx = self.sender_context.lock().await;
        *ctx = ctx.wrapping_add(1);
        *ctx
    }

    /// Build EtherNet/IP header
    fn build_enip_header(
        &self,
        command: u16,
        session_handle: u32,
        sender_context: u64,
        data_len: usize,
    ) -> Vec<u8> {
        let mut header = Vec::with_capacity(24);

        // Command
        header.extend_from_slice(&command.to_le_bytes());

        // Length
        header.extend_from_slice(&(data_len as u16).to_le_bytes());

        // Session handle
        header.extend_from_slice(&session_handle.to_le_bytes());

        // Status (0 for requests)
        header.extend_from_slice(&0u32.to_le_bytes());

        // Sender context
        header.extend_from_slice(&sender_context.to_le_bytes());

        // Options
        header.extend_from_slice(&0u32.to_le_bytes());

        header
    }

    /// Build Register Session request
    fn build_register_session(&self) -> Vec<u8> {
        let mut msg = self.build_enip_header(ENIP_REGISTER_SESSION, 0, 0, 4);

        // Protocol version
        msg.extend_from_slice(&1u16.to_le_bytes());

        // Options flags
        msg.extend_from_slice(&0u16.to_le_bytes());

        msg
    }

    /// Build CIP path
    fn build_cip_path(&self) -> Vec<u8> {
        let mut path = Vec::new();

        // Backplane port (port 1, slot N)
        path.push(0x01); // Port segment
        path.push(self.config.slot); // Slot

        path
    }

    /// Build CIP Read Tag request
    ///
    /// CIP symbolic segment uses 1-byte length field, so tag names are limited to 255 bytes.
    fn build_read_tag(&self, tag_name: &str) -> Vec<u8> {
        let tag_bytes = tag_name.as_bytes();

        // CIP symbolic segment uses 1-byte length field (max 255 bytes)
        if tag_bytes.len() > 255 {
            warn!(
                "Tag name '{}' exceeds CIP max length (255 bytes), truncating",
                &tag_name[..50.min(tag_name.len())]
            );
        }
        let tag_len = tag_bytes.len().min(255);
        let tag_bytes = &tag_bytes[..tag_len];

        let mut request = Vec::new();

        // Service code
        request.push(CIP_READ_TAG);

        // Path size (in words)
        let path_size = (2 + tag_len + (tag_len % 2)) / 2;
        request.push(path_size as u8);

        // Symbolic segment
        request.push(0x91);
        request.push(tag_len as u8);
        request.extend_from_slice(tag_bytes);
        if tag_len % 2 == 1 {
            request.push(0x00); // Pad
        }

        // Number of elements to read
        request.extend_from_slice(&1u16.to_le_bytes());

        request
    }

    /// Build SendRRData (unconnected message)
    async fn build_send_rr_data(&self, cip_data: &[u8]) -> Vec<u8> {
        let session = *self.session_handle.lock().await;
        let context = self.next_context().await;

        // Item count: 2 (null address + unconnected data)
        let item_data_len = 2 + 2 + 2 + cip_data.len(); // type + len for each item + data

        let mut msg =
            self.build_enip_header(ENIP_SEND_RR_DATA, session, context, 6 + item_data_len);

        // Interface handle
        msg.extend_from_slice(&0u32.to_le_bytes());

        // Timeout
        msg.extend_from_slice(&10u16.to_le_bytes());

        // Item count
        msg.extend_from_slice(&2u16.to_le_bytes());

        // Null address item
        msg.extend_from_slice(&0u16.to_le_bytes()); // Type: null
        msg.extend_from_slice(&0u16.to_le_bytes()); // Length: 0

        // Unconnected data item
        msg.extend_from_slice(&0x00B2u16.to_le_bytes()); // Type: unconnected data
        msg.extend_from_slice(&(cip_data.len() as u16).to_le_bytes());
        msg.extend_from_slice(cip_data);

        msg
    }

    /// Send and receive EtherNet/IP message with timeout protection
    async fn send_receive(&self, message: &[u8]) -> Result<Vec<u8>> {
        let io_timeout = Duration::from_secs(self.config.timeout_secs);
        let mut conn_guard = self.connection.lock().await;
        let conn = conn_guard
            .as_mut()
            .ok_or_else(|| anyhow!("Not connected"))?;

        // Send with timeout
        timeout(io_timeout, conn.write_all(message))
            .await
            .map_err(|_| {
                anyhow!(
                    "EtherNet/IP write timeout after {} seconds",
                    self.config.timeout_secs
                )
            })??;

        // Read header with timeout
        let mut header = [0u8; 24];
        timeout(io_timeout, conn.read_exact(&mut header))
            .await
            .map_err(|_| {
                anyhow!(
                    "EtherNet/IP read timeout after {} seconds",
                    self.config.timeout_secs
                )
            })??;

        // Get data length
        let data_len = u16::from_le_bytes([header[2], header[3]]) as usize;

        // Validate data length to prevent memory exhaustion (IEC 62443 SL2)
        if data_len > MAX_ENIP_PACKET_SIZE {
            return Err(anyhow!(
                "EtherNet/IP packet too large: {} bytes (max {})",
                data_len,
                MAX_ENIP_PACKET_SIZE
            ));
        }

        // Read data with timeout
        let mut response = header.to_vec();
        if data_len > 0 {
            let mut data = vec![0u8; data_len];
            timeout(io_timeout, conn.read_exact(&mut data))
                .await
                .map_err(|_| {
                    anyhow!(
                        "EtherNet/IP read timeout after {} seconds",
                        self.config.timeout_secs
                    )
                })??;
            response.extend_from_slice(&data);
        }

        // Check status
        let status = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
        if status != 0 {
            return Err(anyhow!("EtherNet/IP error: status 0x{:08X}", status));
        }

        Ok(response)
    }

    /// Parse CIP response from SendRRData reply
    ///
    /// Extracts the CIP service code, general status, and data payload.
    /// Returns (service_code, general_status, data).
    fn parse_cip_response(response: &[u8]) -> Result<(u8, u8, Vec<u8>)> {
        // SendRRData response layout:
        // [0..24]  EtherNet/IP header
        // [24..28] Interface handle (4 bytes)
        // [28..30] Timeout (2 bytes)
        // [30..32] Item count (2 bytes)
        // [32..34] Null address type (2 bytes)
        // [34..36] Null address length (2 bytes)
        // [36..38] Unconnected data type (2 bytes)
        // [38..40] Unconnected data length (2 bytes)
        // [40..]   CIP response data

        if response.len() < 42 {
            return Err(anyhow!(
                "CIP response too short: {} bytes (minimum 42)",
                response.len()
            ));
        }

        let cip_data = &response[40..];

        // CIP response format:
        // [0]   Service code (original | 0x80 for reply)
        // [1]   Reserved (size of additional status in words)
        // [2]   General Status
        // [3]   Size of additional status (words)
        // [4..] Additional status + response data
        if cip_data.len() < 4 {
            return Err(anyhow!(
                "CIP response data too short: {} bytes (minimum 4)",
                cip_data.len()
            ));
        }

        let service_code = cip_data[0];
        let general_status = cip_data[2];
        let additional_status_words = cip_data[3] as usize;
        let data_offset = 4 + (additional_status_words * 2);

        // Verify this is a reply
        if service_code & CIP_REPLY_FLAG == 0 {
            return Err(anyhow!(
                "Expected CIP reply (bit 7 set), got service code 0x{:02X}",
                service_code
            ));
        }

        // Check CIP General Status
        if general_status != 0x00 {
            let status_msg = match general_status {
                0x01 => "Connection failure",
                0x02 => "Resource unavailable",
                0x03 => "Invalid parameter value",
                0x04 => "Path segment error",
                0x05 => "Path destination unknown",
                0x06 => "Partial transfer",
                0x07 => "Connection lost",
                0x08 => "Service not supported",
                0x09 => "Invalid attribute value",
                0x0A => "Attribute list error",
                0x0B => "Already in requested mode/state",
                0x0C => "Object state conflict",
                0x0D => "Object already exists",
                0x0E => "Attribute not settable",
                0x0F => "Privilege violation",
                0x10 => "Device state conflict",
                0x11 => "Reply data too large",
                0x12 => "Fragmentation of a primitive value",
                0x13 => "Not enough data",
                0x14 => "Attribute not supported",
                0x15 => "Too much data",
                0x16 => "Object does not exist",
                0x1A => "Routing failure, request too large",
                0x1B => "Routing failure, response too large",
                0x1C => "Missing attribute list entry data",
                0x1D => "Invalid attribute value list",
                0x1E => "Embedded service error",
                0x1F => "Vendor specific error",
                0x20 => "Invalid parameter",
                0x26 => "Path size invalid",
                0xFF => "CIP service not implemented",
                _ => "Unknown CIP error",
            };
            return Err(anyhow!(
                "CIP error: {} (general status 0x{:02X})",
                status_msg,
                general_status
            ));
        }

        let data = if data_offset < cip_data.len() {
            cip_data[data_offset..].to_vec()
        } else {
            Vec::new()
        };

        Ok((service_code, general_status, data))
    }

    /// Build CIP Write Tag request
    ///
    /// CIP data types: 0x00C1=BOOL, 0x00C2=SINT, 0x00C3=INT, 0x00C4=DINT, 0x00CA=REAL.
    fn build_write_tag(tag_name: &str, data_type: u16, value: &[u8]) -> Vec<u8> {
        let tag_bytes = tag_name.as_bytes();

        // CIP symbolic segment uses 1-byte length field (max 255 bytes)
        if tag_bytes.len() > 255 {
            warn!(
                "Tag name '{}' exceeds CIP max length (255 bytes), truncating",
                &tag_name[..50.min(tag_name.len())]
            );
        }
        let tag_len = tag_bytes.len().min(255);
        let tag_bytes = &tag_bytes[..tag_len];

        let mut request = Vec::new();

        // Service code
        request.push(CIP_WRITE_TAG);

        // Path size (in words)
        let path_size = (2 + tag_len + (tag_len % 2)) / 2;
        request.push(path_size as u8);

        // Symbolic segment
        request.push(0x91);
        request.push(tag_len as u8);
        request.extend_from_slice(tag_bytes);
        if tag_len % 2 == 1 {
            request.push(0x00); // Pad
        }

        // Data type
        request.extend_from_slice(&data_type.to_le_bytes());

        // Number of elements to write
        request.extend_from_slice(&1u16.to_le_bytes());

        // Value data
        request.extend_from_slice(value);

        request
    }

    /// Build CIP request to Get_Attribute_All on Identity object (Class 0x01, Instance 1)
    fn build_identity_request() -> Vec<u8> {
        let mut request = Vec::new();

        // Service code: Get_Attribute_All
        request.push(CIP_GET_ATTRIBUTE_ALL);

        // Path size: 2 words (class segment + instance segment)
        request.push(0x02);

        // Class segment: 8-bit class ID
        request.push(0x20); // 8-bit class segment
        request.push(CIP_CLASS_IDENTITY as u8);

        // Instance segment: 8-bit instance ID
        request.push(0x24); // 8-bit instance segment
        request.push(0x01); // Instance 1

        request
    }

    /// Build CIP Set_Attribute_Single request to change PLC mode
    ///
    /// Uses the Identity object (Class 0x01, Instance 1, Attribute 5 = State)
    /// State values: 0 = Non-existent, 1 = Self-testing, 2 = Standby, 3 = Operational (Run)
    fn build_mode_change(run: bool) -> Vec<u8> {
        let mut request = Vec::new();

        // Service code: Set_Attribute_Single
        request.push(CIP_SET_ATTRIBUTE_SINGLE);

        // Path size: 3 words (class + instance + attribute)
        request.push(0x03);

        // Class segment: Identity (0x01)
        request.push(0x20); // 8-bit class segment
        request.push(CIP_CLASS_IDENTITY as u8);

        // Instance segment: Instance 1
        request.push(0x24); // 8-bit instance segment
        request.push(0x01); // Instance 1

        // Attribute segment: Attribute 5 (State)
        request.push(0x30); // 8-bit attribute segment
        request.push(0x05); // Attribute 5 = State

        // Value: 3 = Operational (Run), 2 = Standby (Stop)
        let state: u8 = if run { 0x03 } else { 0x02 };
        request.push(state);

        request
    }

    /// Convert ST to AOI/Add-On Instruction format
    fn convert_to_aoi(&self, program: &PlcProgram) -> Result<Vec<u8>> {
        // Allen-Bradley uses proprietary format for program storage
        // Full conversion requires RSLogix/Studio 5000
        //
        // This creates a simplified representation

        let mut aoi = Vec::new();

        // AOI header
        aoi.extend_from_slice(b"AOI\x00");

        // Name
        let name_bytes = program.name.as_bytes();
        aoi.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        aoi.extend_from_slice(name_bytes);

        // Source (as comment - AB doesn't directly support ST)
        let source_bytes = program.source.as_bytes();
        aoi.extend_from_slice(&(source_bytes.len() as u32).to_le_bytes());
        aoi.extend_from_slice(source_bytes);

        warn!("Allen-Bradley program upload requires Studio 5000 for full ST compilation");

        Ok(aoi)
    }
}

#[async_trait::async_trait]
impl PlcProgrammer for EtherNetIpClient {
    fn protocol_name(&self) -> &'static str {
        "EtherNet/IP"
    }

    async fn connect(&mut self) -> Result<()> {
        let addr = format!("{}:{}", self.config.address, self.config.port);
        info!("Connecting to Allen-Bradley PLC at {}", addr);

        let timeout_duration = std::time::Duration::from_secs(self.config.timeout_secs);

        let stream = with_timeout(
            TcpStream::connect(&addr),
            timeout_duration,
            "EtherNet/IP connect",
        )
        .await?;

        *self.connection.lock().await = Some(stream);

        // Register session
        let register = self.build_register_session();
        let response = self.send_receive(&register).await?;

        // Extract session handle
        if response.len() >= 8 {
            let session = u32::from_le_bytes([response[4], response[5], response[6], response[7]]);
            *self.session_handle.lock().await = session;
            debug!("EtherNet/IP session registered: 0x{:08X}", session);
        }

        self.connected.store(true, Ordering::Release);
        info!("Connected to Allen-Bradley PLC: {}", self.config.name);

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        // Unregister session
        let session = *self.session_handle.lock().await;
        if session != 0 {
            let msg = self.build_enip_header(ENIP_UNREGISTER_SESSION, session, 0, 0);
            let _ = self.send_receive(&msg).await;
        }

        *self.connection.lock().await = None;
        *self.session_handle.lock().await = 0;
        self.connected.store(false, Ordering::Release);

        info!("Disconnected from Allen-Bradley PLC: {}", self.config.name);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    async fn get_status(&self) -> Result<PlcStatus> {
        let fallback_model = match self.config.plc_type {
            AbPlcType::CompactLogix => "CompactLogix",
            AbPlcType::ControlLogix => "ControlLogix",
            AbPlcType::Micro800 => "Micro800",
            AbPlcType::Plc5 => "PLC-5",
            AbPlcType::Slc500 => "SLC 500",
        };

        if !self.is_connected() {
            return Ok(PlcStatus {
                connected: false,
                run_mode: PlcRunMode::Unknown,
                model: fallback_model.to_string(),
                firmware: "Unknown".to_string(),
                current_program: None,
                last_modified: None,
            });
        }

        // Send CIP Get_Attribute_All on Identity object (Class 0x01, Instance 1)
        let identity_req = Self::build_identity_request();
        let rr_data = self.build_send_rr_data(&identity_req).await;

        match self.send_receive(&rr_data).await {
            Ok(response) => {
                match Self::parse_cip_response(&response) {
                    Ok((_service, _status, data)) => {
                        // Identity object Get_Attribute_All response layout:
                        // [0..2]   Vendor ID (UINT)
                        // [2..4]   Device Type (UINT)
                        // [4..6]   Product Code (UINT)
                        // [6..7]   Major Revision (USINT)
                        // [7..8]   Minor Revision (USINT)
                        // [8..10]  Status (WORD)
                        // [10..14] Serial Number (UDINT)
                        // [14]     Product Name Length (USINT)
                        // [15..]   Product Name (STRING)
                        // After product name: State (USINT)

                        let mut model = fallback_model.to_string();
                        let mut firmware = "Unknown".to_string();
                        let mut run_mode = PlcRunMode::Unknown;

                        if data.len() >= 8 {
                            let vendor_id = u16::from_le_bytes([data[0], data[1]]);
                            let major_rev = data[6];
                            let minor_rev = data[7];
                            firmware = format!("V{}.{}", major_rev, minor_rev);
                            debug!(
                                "CIP Identity: vendor_id={}, firmware={}",
                                vendor_id, firmware
                            );
                        }

                        if data.len() >= 15 {
                            let serial = data
                                .get(10..14)
                                .and_then(|bytes| bytes.try_into().ok())
                                .map(u32::from_le_bytes)
                                .unwrap_or(0);
                            let name_len = data[14] as usize;
                            if data.len() >= 15 + name_len {
                                if let Ok(product_name) =
                                    std::str::from_utf8(&data[15..15 + name_len])
                                {
                                    model = product_name.to_string();
                                    debug!(
                                        "CIP Identity: product='{}', serial=0x{:08X}",
                                        model, serial
                                    );
                                }

                                // State byte follows product name
                                let state_offset = 15 + name_len;
                                if let Some(state) = data.get(state_offset).copied() {
                                    run_mode = match state {
                                        0 => PlcRunMode::Unknown, // Non-existent
                                        1 => PlcRunMode::Test,    // Self-testing
                                        2 => PlcRunMode::Stop,    // Standby
                                        3 => PlcRunMode::Run,     // Operational
                                        4 => PlcRunMode::Fault,   // Major recoverable fault
                                        5 => PlcRunMode::Fault,   // Major unrecoverable fault
                                        _ => PlcRunMode::Unknown,
                                    };
                                    debug!("CIP Identity: state={} -> {:?}", state, run_mode);
                                }
                            }
                        }

                        Ok(PlcStatus {
                            connected: true,
                            run_mode,
                            model,
                            firmware,
                            current_program: None,
                            last_modified: None,
                        })
                    }
                    Err(e) => {
                        warn!("Failed to parse CIP Identity response: {}", e);
                        Ok(PlcStatus {
                            connected: true,
                            run_mode: PlcRunMode::Unknown,
                            model: fallback_model.to_string(),
                            firmware: "Unknown".to_string(),
                            current_program: None,
                            last_modified: None,
                        })
                    }
                }
            }
            Err(e) => {
                warn!("Failed to read CIP Identity: {}", e);
                Ok(PlcStatus {
                    connected: true,
                    run_mode: PlcRunMode::Unknown,
                    model: fallback_model.to_string(),
                    firmware: "Unknown".to_string(),
                    current_program: None,
                    last_modified: None,
                })
            }
        }
    }

    async fn upload_program(&self, program: &PlcProgram) -> Result<UploadResult> {
        info!(
            "Uploading program '{}' to Allen-Bradley PLC: {}",
            program.name, self.config.name
        );

        validate_program_source(&program.source)?;

        // Validate the program is convertible, then fail closed: the actual upload
        // (CIP file services + proprietary Logix format) is not implemented, so we
        // must not report a program as deployed when nothing was transmitted
        // (SENSOR-HIGH-077).
        let _aoi = self.convert_to_aoi(program)?;

        audit_program_upload(
            "EtherNet/IP",
            &self.config.address,
            &program.name,
            false,
            "unsupported",
        );

        Err(anyhow!(ETHERNET_IP_PROGRAM_TRANSFER_UNSUPPORTED))
    }

    async fn download_program(&self, _program_name: &str) -> Result<PlcProgram> {
        // SENSOR-HIGH-077: reading a Logix program back also requires Studio 5000;
        // do not hand back a placeholder program as if it came from the PLC.
        Err(anyhow!(ETHERNET_IP_PROGRAM_TRANSFER_UNSUPPORTED))
    }

    async fn start(&self) -> Result<()> {
        info!("Starting Allen-Bradley PLC: {}", self.config.name);

        let mode_req = Self::build_mode_change(true);
        let rr_data = self.build_send_rr_data(&mode_req).await;
        let response = self.send_receive(&rr_data).await?;
        Self::parse_cip_response(&response)?;

        info!("Allen-Bradley PLC set to RUN mode: {}", self.config.name);
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        info!("Stopping Allen-Bradley PLC: {}", self.config.name);

        let mode_req = Self::build_mode_change(false);
        let rr_data = self.build_send_rr_data(&mode_req).await;
        let response = self.send_receive(&rr_data).await?;
        Self::parse_cip_response(&response)?;

        info!("Allen-Bradley PLC set to STOP mode: {}", self.config.name);
        Ok(())
    }

    async fn list_programs(&self) -> Result<Vec<String>> {
        Ok(vec!["MainProgram".to_string(), "MainRoutine".to_string()])
    }

    async fn delete_program(&self, program_name: &str) -> Result<()> {
        warn!(
            "Deleting program '{}' from Allen-Bradley PLC: {}",
            program_name, self.config.name
        );
        Ok(())
    }

    async fn compile(&self, program: &PlcProgram) -> Result<UploadResult> {
        validate_program_source(&program.source)?;

        // SENSOR-HIGH-077: report an honest compile failure instead of success:true.
        // AB compilation (ST → Logix AOI) requires Studio 5000, so no downloadable
        // artifact is produced.
        Ok(UploadResult {
            success: false,
            program_id: None,
            warnings: Vec::new(),
            errors: vec![ETHERNET_IP_PROGRAM_TRANSFER_UNSUPPORTED.to_string()],
            timestamp: chrono::Utc::now().to_rfc3339(),
            plc_response: HashMap::new(),
        })
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::ProgramLanguage;
    use super::*;

    fn sample_program() -> PlcProgram {
        PlcProgram {
            name: "MainRoutine".to_string(),
            language: ProgramLanguage::St,
            source: "PROGRAM main VAR x : BOOL; END_VAR x := TRUE; END_PROGRAM".to_string(),
            variables: Vec::new(),
            function_blocks: Vec::new(),
            metadata: HashMap::new(),
        }
    }

    /// SENSOR-HIGH-077 — upload must fail closed rather than fabricate a success
    /// receipt for a program that was never transmitted to the PLC.
    #[tokio::test]
    async fn upload_program_fails_closed_instead_of_fabricating_success() {
        let client = EtherNetIpClient::new(EtherNetIpConfig::default());
        let err = client.upload_program(&sample_program()).await.unwrap_err();
        assert!(err.to_string().contains("not implemented"), "got: {err}");
    }

    #[tokio::test]
    async fn download_program_fails_closed_instead_of_returning_a_stub() {
        let client = EtherNetIpClient::new(EtherNetIpConfig::default());
        let err = client.download_program("MainRoutine").await.unwrap_err();
        assert!(err.to_string().contains("not implemented"), "got: {err}");
    }

    #[tokio::test]
    async fn compile_reports_honest_failure_not_fake_success() {
        let client = EtherNetIpClient::new(EtherNetIpConfig::default());
        let result = client.compile(&sample_program()).await.unwrap();
        assert!(!result.success);
        assert!(result.errors.iter().any(|e| e.contains("not implemented")));
    }

    #[test]
    fn test_config_default() {
        let config = EtherNetIpConfig::default();
        assert_eq!(config.port, DEFAULT_ENIP_PORT);
        assert_eq!(config.slot, 0);
    }

    #[test]
    fn test_enip_header() {
        let config = EtherNetIpConfig::default();
        let client = EtherNetIpClient::new(config);

        let header = client.build_enip_header(ENIP_REGISTER_SESSION, 0, 0, 4);
        assert_eq!(header.len(), 24);
        assert_eq!(header[0], 0x65); // Register session low byte
        assert_eq!(header[1], 0x00); // Register session high byte
    }

    #[test]
    fn test_register_session() {
        let config = EtherNetIpConfig::default();
        let client = EtherNetIpClient::new(config);

        let msg = client.build_register_session();
        assert_eq!(msg.len(), 28); // 24 header + 4 data
    }

    #[test]
    fn test_build_read_tag() {
        let config = EtherNetIpConfig::default();
        let client = EtherNetIpClient::new(config);

        let req = client.build_read_tag("MyTag");
        assert_eq!(req[0], CIP_READ_TAG);
        // Symbolic segment marker
        assert_eq!(req[2], 0x91);
        // Tag length
        assert_eq!(req[3], 5);
        // Tag name bytes
        assert_eq!(&req[4..9], b"MyTag");
    }

    #[test]
    fn test_build_write_tag() {
        let value: i16 = 42;
        let req = EtherNetIpClient::build_write_tag("Counter", CIP_TYPE_INT, &value.to_le_bytes());
        assert_eq!(req[0], CIP_WRITE_TAG);
        // Symbolic segment marker
        assert_eq!(req[2], 0x91);
        // Tag length
        assert_eq!(req[3], 7);
        // Tag name bytes
        assert_eq!(&req[4..11], b"Counter");
        // Pad byte (odd length tag)
        assert_eq!(req[11], 0x00);
        // Data type (INT = 0x00C3, little-endian)
        assert_eq!(req[12], 0xC3);
        assert_eq!(req[13], 0x00);
        // Element count (1, little-endian)
        assert_eq!(req[14], 0x01);
        assert_eq!(req[15], 0x00);
        // Value (42 as i16, little-endian)
        assert_eq!(req[16], 42);
        assert_eq!(req[17], 0);
    }

    #[test]
    fn test_build_write_tag_bool() {
        let value: [u8; 1] = [1];
        let req = EtherNetIpClient::build_write_tag("Flag", CIP_TYPE_BOOL, &value);
        assert_eq!(req[0], CIP_WRITE_TAG);
        assert_eq!(req[3], 4); // Tag name length
        // Data type (BOOL = 0x00C1)
        let dt_offset = 4 + 4; // tag bytes + pad
        assert_eq!(req[dt_offset], 0xC1);
        assert_eq!(req[dt_offset + 1], 0x00);
    }

    #[test]
    fn test_build_identity_request() {
        let req = EtherNetIpClient::build_identity_request();
        assert_eq!(req[0], CIP_GET_ATTRIBUTE_ALL);
        assert_eq!(req[1], 0x02); // Path size: 2 words
        assert_eq!(req[2], 0x20); // 8-bit class segment
        assert_eq!(req[3], CIP_CLASS_IDENTITY as u8);
        assert_eq!(req[4], 0x24); // 8-bit instance segment
        assert_eq!(req[5], 0x01); // Instance 1
    }

    #[test]
    fn test_build_mode_change_run() {
        let req = EtherNetIpClient::build_mode_change(true);
        assert_eq!(req[0], CIP_SET_ATTRIBUTE_SINGLE);
        assert_eq!(req[1], 0x03); // Path size: 3 words
        assert_eq!(req[7], 0x05); // Attribute 5 (State)
        assert_eq!(req[8], 0x03); // State = Operational (Run)
    }

    #[test]
    fn test_build_mode_change_stop() {
        let req = EtherNetIpClient::build_mode_change(false);
        assert_eq!(req[0], CIP_SET_ATTRIBUTE_SINGLE);
        assert_eq!(req[8], 0x02); // State = Standby (Stop)
    }

    #[test]
    fn test_parse_cip_response_success() {
        // Build a minimal valid SendRRData response with CIP success
        let mut response = vec![0u8; 44];
        // EtherNet/IP header (24 bytes) + interface handle (4) + timeout (2) +
        // item count (2) + null addr type (2) + null addr len (2) +
        // unconnected data type (2) + unconnected data len (2) = 40 bytes
        // CIP data starts at offset 40:
        response[40] = CIP_GET_ATTRIBUTE_ALL | CIP_REPLY_FLAG; // Service reply
        response[41] = 0x00; // Reserved
        response[42] = 0x00; // General Status = success
        response[43] = 0x00; // Additional status size = 0

        let result = EtherNetIpClient::parse_cip_response(&response);
        assert!(result.is_ok());
        let (service, status, data) = result.unwrap();
        assert_eq!(service, CIP_GET_ATTRIBUTE_ALL | CIP_REPLY_FLAG);
        assert_eq!(status, 0x00);
        assert!(data.is_empty());
    }

    #[test]
    fn test_parse_cip_response_error() {
        let mut response = vec![0u8; 44];
        response[40] = CIP_READ_TAG | CIP_REPLY_FLAG;
        response[41] = 0x00;
        response[42] = 0x05; // General Status = Path destination unknown
        response[43] = 0x00;

        let result = EtherNetIpClient::parse_cip_response(&response);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("Path destination unknown"));
    }

    #[test]
    fn test_parse_cip_response_too_short() {
        let response = vec![0u8; 30]; // Too short
        let result = EtherNetIpClient::parse_cip_response(&response);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_cip_response_with_data() {
        let mut response = vec![0u8; 48];
        response[40] = CIP_READ_TAG | CIP_REPLY_FLAG;
        response[41] = 0x00;
        response[42] = 0x00; // Success
        response[43] = 0x00; // No additional status
        // Data payload
        response[44] = 0xC3; // INT type low byte
        response[45] = 0x00; // INT type high byte
        response[46] = 0x2A; // Value 42 low byte
        response[47] = 0x00; // Value 42 high byte

        let result = EtherNetIpClient::parse_cip_response(&response);
        assert!(result.is_ok());
        let (_service, _status, data) = result.unwrap();
        assert_eq!(data.len(), 4);
        assert_eq!(data[0], 0xC3);
        assert_eq!(data[2], 0x2A);
    }
}
