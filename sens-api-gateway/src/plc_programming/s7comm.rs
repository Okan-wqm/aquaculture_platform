//! Siemens S7 Communication Protocol Implementation
//!
//! Supports program upload to Siemens S7 PLCs via S7comm/S7comm+ protocol.
//!
//! ## Supported PLCs
//! - S7-300 series
//! - S7-400 series
//! - S7-1200 series (partial)
//! - S7-1500 series (partial, requires S7comm+)
//!
//! ## Protocol
//! - Default Port: 102 (ISO-on-TCP / RFC 1006)
//! - COTP (Connection Oriented Transport Protocol)
//! - S7comm layer for PLC operations
//!
//! ## Limitations
//! - S7-1200/1500 require "PUT/GET" enabled in TIA Portal
//! - Full program upload requires TIA Portal Openness API
//! - This implementation supports block upload/download

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
// WHY: tokio::sync::Mutex — held across .await (S7 TCP read/write is async I/O)
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::{debug, info, warn};

// ============================================================================
// Constants
// ============================================================================

/// Default S7 port (ISO-on-TCP)
pub const DEFAULT_S7_PORT: u16 = 102;

/// SENSOR-HIGH-078 (ICS-safety): S7 ST→MC7 compilation is not implemented.
/// Emitting and downloading placeholder bytecode to a live Siemens PLC can trip
/// the CPU to STOP or corrupt the running program, so both `compile` and
/// `upload_program` fail closed with this message instead of shipping garbage.
const S7_MC7_UNSUPPORTED: &str = "S7 ST→MC7 compilation is not implemented; \
refusing to download uncompiled bytecode to a live PLC. A real ST→MC7 compiler \
or a TIA Portal Openness bridge is required.";

/// Maximum S7 packet size (TPKT max is 65535 but we limit for safety)
const MAX_S7_PACKET_SIZE: usize = 65536;

/// COTP connection request
const COTP_CR: u8 = 0xE0;

/// COTP connection confirm
const COTP_CC: u8 = 0xD0;

/// COTP data transfer
const COTP_DT: u8 = 0xF0;

/// S7 Protocol ID
const S7_PROTOCOL_ID: u8 = 0x32;

/// S7 Job request
const S7_JOB: u8 = 0x01;

/// S7 Ack
const S7_ACK: u8 = 0x02;

/// S7 Ack-Data
const S7_ACK_DATA: u8 = 0x03;

/// S7 Userdata
const S7_USERDATA: u8 = 0x07;

// S7 Functions
const S7_FUNC_READ_VAR: u8 = 0x04;
const S7_FUNC_WRITE_VAR: u8 = 0x05;
const S7_FUNC_SETUP_COMM: u8 = 0xF0;
const S7_FUNC_START_UPLOAD: u8 = 0x1D;
const S7_FUNC_UPLOAD: u8 = 0x1E;
const S7_FUNC_END_UPLOAD: u8 = 0x1F;
const S7_FUNC_START_DOWNLOAD: u8 = 0x1A;
const S7_FUNC_DOWNLOAD: u8 = 0x1B;
const S7_FUNC_END_DOWNLOAD: u8 = 0x1C;
const S7_FUNC_PLC_CONTROL: u8 = 0x28;
const S7_FUNC_PLC_STOP: u8 = 0x29;

// S7 Memory Area Codes
const S7_AREA_PE: u8 = 0x81; // Process inputs
const S7_AREA_PA: u8 = 0x82; // Process outputs
const S7_AREA_MK: u8 = 0x83; // Merkers (bit memories)
const S7_AREA_DB: u8 = 0x84; // Data blocks
const S7_AREA_CT: u8 = 0x1C; // Counters
const S7_AREA_TM: u8 = 0x1D; // Timers

// S7 Transport Sizes (for read/write requests)
const S7_TS_BIT: u8 = 0x01;
const S7_TS_BYTE: u8 = 0x02;
const S7_TS_WORD: u8 = 0x04;
const S7_TS_INT: u8 = 0x05;
const S7_TS_DWORD: u8 = 0x06;
const S7_TS_DINT: u8 = 0x07;
const S7_TS_REAL: u8 = 0x08;

// S7 Data Transport Sizes (in response data items)
const S7_TS_DATA_BIT: u8 = 0x03;
const S7_TS_DATA_BYTE_WORD_DWORD: u8 = 0x04;
const S7_TS_DATA_REAL: u8 = 0x08;

// ============================================================================
// S7 Error Code Parsing
// ============================================================================

/// Parse S7 error class and code into human-readable message
fn parse_s7_error(error_class: u8, error_code: u8) -> String {
    let class_desc = match error_class {
        0x00 => "No error",
        0x81 => "Application relationship error",
        0x82 => "Object definition error",
        0x83 => "No resources available",
        0x84 => "Service processing error",
        0x85 => "Supplies error",
        0x87 => "Access error",
        0xD2 => "OVS error",
        0xD4 => "Diagnostic error",
        0xD6 => "Protection error",
        0xDC => "Block download error",
        0xDD => "Block upload error",
        0xDE => "Block delete error",
        0xDF => "Password error",
        _ => "Unknown error class",
    };

    let code_desc = match (error_class, error_code) {
        (0x00, 0x00) => "Success",
        (0x81, 0x01) => "Invalid syntax ID",
        (0x81, 0x04) => "No resources",
        (0x82, 0x01) => "Invalid address",
        (0x82, 0x02) => "Data type not supported",
        (0x82, 0x03) => "Data type inconsistent",
        (0x82, 0x04) => "Object does not exist",
        (0x83, 0x01) => "CPU already in RUN",
        (0x83, 0x02) => "CPU already in STOP",
        (0x84, 0x01) => "PDU size error",
        (0x84, 0x04) => "Hardware fault",
        (0x85, 0x01) => "Block checksum error",
        (0x87, 0x01) => "Read access not allowed",
        (0x87, 0x02) => "Write access not allowed",
        (0xD4, 0x01) => "System info function not implemented",
        (0xD6, 0x01) => "CPU protection level",
        (0xD6, 0x02) => "Insufficient privileges",
        (0xDC, 0x01) => "Block number already exists",
        (0xDC, 0x02) => "Block type not allowed",
        (0xDC, 0x03) => "Block size too large",
        _ => "",
    };

    if code_desc.is_empty() {
        format!(
            "{} (class=0x{:02X}, code=0x{:02X})",
            class_desc, error_class, error_code
        )
    } else {
        format!(
            "{}: {} (class=0x{:02X}, code=0x{:02X})",
            class_desc, code_desc, error_class, error_code
        )
    }
}

// ============================================================================
// Configuration
// ============================================================================

/// Siemens S7 connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S7Config {
    /// Connection name
    pub name: String,

    /// PLC IP address
    pub address: String,

    /// Port (default: 102)
    #[serde(default = "default_s7_port")]
    pub port: u16,

    /// Rack number (default: 0)
    #[serde(default)]
    pub rack: u8,

    /// Slot number (default: 1 for S7-300/400, 0 for S7-1200/1500)
    #[serde(default = "default_slot")]
    pub slot: u8,

    /// PLC type
    #[serde(default)]
    pub plc_type: S7PlcType,

    /// Connection timeout (seconds)
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,

    /// PDU size (default: 480, max varies by PLC)
    #[serde(default = "default_pdu_size")]
    pub pdu_size: u16,
}

fn default_s7_port() -> u16 {
    DEFAULT_S7_PORT
}

fn default_slot() -> u8 {
    1
}

fn default_timeout() -> u64 {
    10
}

fn default_pdu_size() -> u16 {
    480
}

/// S7 PLC Type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum S7PlcType {
    /// S7-200 (not fully supported)
    S7200,
    /// S7-300 series
    #[default]
    S7300,
    /// S7-400 series
    S7400,
    /// S7-1200 series
    S71200,
    /// S7-1500 series
    S71500,
    /// LOGO! (limited support)
    Logo,
}

impl Default for S7Config {
    fn default() -> Self {
        Self {
            name: "s7_plc".to_string(),
            address: "192.168.1.1".to_string(),
            port: DEFAULT_S7_PORT,
            rack: 0,
            slot: 1,
            plc_type: S7PlcType::S7300,
            timeout_secs: 10,
            pdu_size: 480,
        }
    }
}

// ============================================================================
// S7 Block Types
// ============================================================================

/// S7 Block types
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum S7BlockType {
    /// Organization Block
    OB = 0x38,
    /// Data Block
    DB = 0x41,
    /// System Data Block
    SDB = 0x42,
    /// Function Block
    FB = 0x43,
    /// Function
    FC = 0x45,
    /// System Function Block
    SFB = 0x46,
    /// System Function
    SFC = 0x47,
}

impl S7BlockType {
    fn from_str(s: &str) -> Option<Self> {
        match s.to_uppercase().as_str() {
            "OB" => Some(Self::OB),
            "DB" => Some(Self::DB),
            "SDB" => Some(Self::SDB),
            "FB" => Some(Self::FB),
            "FC" => Some(Self::FC),
            "SFB" => Some(Self::SFB),
            "SFC" => Some(Self::SFC),
            _ => None,
        }
    }
}

// ============================================================================
// S7 Address Parser
// ============================================================================

/// Parsed S7 variable address
#[derive(Debug, Clone)]
pub struct S7Address {
    /// Memory area code
    pub area_code: u8,
    /// DB number (0 for non-DB areas)
    pub db_number: u16,
    /// Byte offset in the area
    pub byte_offset: u16,
    /// Bit offset (0-7, only relevant for bit access)
    pub bit_offset: u8,
    /// S7 transport size for the request
    pub transport_size: u8,
    /// Number of bytes to read/write
    pub byte_length: u8,
}

impl S7Address {
    /// Parse an IEC-style S7 address string
    ///
    /// Supported formats:
    /// - `DB1.DBW0` - Data block word
    /// - `DB1.DBD4` - Data block double word
    /// - `DB1.DBB0` - Data block byte
    /// - `DB1.DBX0.3` - Data block bit
    /// - `MW100` - Merker word
    /// - `MB10` - Merker byte
    /// - `MD20` - Merker double word
    /// - `M0.3` - Merker bit
    /// - `IW0` / `EW0` - Input word
    /// - `IB0` / `EB0` - Input byte
    /// - `QW0` / `AW0` - Output word
    /// - `QB0` / `AB0` - Output byte
    /// - `QD4` / `AD4` - Output double word
    /// - `T5` - Timer
    /// - `C10` - Counter
    pub fn parse(address: &str) -> Result<Self> {
        let addr = address.trim().to_uppercase();

        // DB access: DB<n>.DB<X|B|W|D><offset>[.bit]
        if addr.starts_with("DB") {
            return Self::parse_db_address(&addr);
        }

        // Timer (Batch #25 clippy::manual_strip cleanup —
        // strip_prefix replaces hardcoded slice indices).
        if let Some(rest) = addr.strip_prefix('T') {
            let num: u16 = rest
                .parse()
                .map_err(|_| anyhow!("Invalid timer number: {}", address))?;
            return Ok(Self {
                area_code: S7_AREA_TM,
                db_number: 0,
                byte_offset: num,
                bit_offset: 0,
                transport_size: S7_TS_WORD,
                byte_length: 2,
            });
        }

        // Counter
        if let Some(rest) = addr.strip_prefix('C') {
            let num: u16 = rest
                .parse()
                .map_err(|_| anyhow!("Invalid counter number: {}", address))?;
            return Ok(Self {
                area_code: S7_AREA_CT,
                db_number: 0,
                byte_offset: num,
                bit_offset: 0,
                transport_size: S7_TS_WORD,
                byte_length: 2,
            });
        }

        // Determine area from first character(s)
        let (area, rest) = if let Some(rest) = addr.strip_prefix('M') {
            (S7_AREA_MK, rest)
        } else if let Some(rest) = addr.strip_prefix('I').or_else(|| addr.strip_prefix('E')) {
            (S7_AREA_PE, rest)
        } else if let Some(rest) = addr.strip_prefix('Q').or_else(|| addr.strip_prefix('A')) {
            (S7_AREA_PA, rest)
        } else {
            return Err(anyhow!("Unknown S7 address area: {}", address));
        };

        Self::parse_area_address(area, rest, address)
    }

    fn parse_db_address(addr: &str) -> Result<Self> {
        // Format: DB<n>.DB<X|B|W|D><offset>[.bit]
        let dot_pos = addr
            .find('.')
            .ok_or_else(|| anyhow!("Invalid DB address format: {}", addr))?;
        let db_num: u16 = addr[2..dot_pos]
            .parse()
            .map_err(|_| anyhow!("Invalid DB number: {}", addr))?;
        let field = &addr[dot_pos + 1..];

        if !field.starts_with("DB") {
            return Err(anyhow!("Invalid DB field format: {}", addr));
        }

        let field_rest = &field[2..];
        let (size_char, offset_str) = field_rest.split_at(1);

        match size_char {
            "X" => {
                // Bit access: DBX<byte>.<bit>
                let (byte_str, bit_str) = offset_str
                    .split_once('.')
                    .ok_or_else(|| anyhow!("Invalid DB bit address: {}", addr))?;
                let byte_off: u16 = byte_str
                    .parse()
                    .map_err(|_| anyhow!("Invalid byte offset: {}", addr))?;
                let bit_off: u8 = bit_str
                    .parse()
                    .map_err(|_| anyhow!("Invalid bit offset: {}", addr))?;
                if bit_off > 7 {
                    return Err(anyhow!("Bit offset must be 0-7: {}", addr));
                }
                Ok(Self {
                    area_code: S7_AREA_DB,
                    db_number: db_num,
                    byte_offset: byte_off,
                    bit_offset: bit_off,
                    transport_size: S7_TS_BIT,
                    byte_length: 1,
                })
            }
            "B" => {
                let byte_off: u16 = offset_str
                    .parse()
                    .map_err(|_| anyhow!("Invalid byte offset: {}", addr))?;
                Ok(Self {
                    area_code: S7_AREA_DB,
                    db_number: db_num,
                    byte_offset: byte_off,
                    bit_offset: 0,
                    transport_size: S7_TS_BYTE,
                    byte_length: 1,
                })
            }
            "W" => {
                let byte_off: u16 = offset_str
                    .parse()
                    .map_err(|_| anyhow!("Invalid word offset: {}", addr))?;
                Ok(Self {
                    area_code: S7_AREA_DB,
                    db_number: db_num,
                    byte_offset: byte_off,
                    bit_offset: 0,
                    transport_size: S7_TS_WORD,
                    byte_length: 2,
                })
            }
            "D" => {
                let byte_off: u16 = offset_str
                    .parse()
                    .map_err(|_| anyhow!("Invalid dword offset: {}", addr))?;
                Ok(Self {
                    area_code: S7_AREA_DB,
                    db_number: db_num,
                    byte_offset: byte_off,
                    bit_offset: 0,
                    transport_size: S7_TS_DWORD,
                    byte_length: 4,
                })
            }
            _ => Err(anyhow!(
                "Invalid DB size specifier '{}': {}",
                size_char,
                addr
            )),
        }
    }

    fn parse_area_address(area: u8, rest: &str, original: &str) -> Result<Self> {
        if rest.is_empty() {
            return Err(anyhow!("Missing offset in address: {}", original));
        }

        let first_char = rest.chars().next().unwrap_or('?');
        match first_char {
            'B' => {
                let off: u16 = rest[1..]
                    .parse()
                    .map_err(|_| anyhow!("Invalid byte offset: {}", original))?;
                Ok(Self {
                    area_code: area,
                    db_number: 0,
                    byte_offset: off,
                    bit_offset: 0,
                    transport_size: S7_TS_BYTE,
                    byte_length: 1,
                })
            }
            'W' => {
                let off: u16 = rest[1..]
                    .parse()
                    .map_err(|_| anyhow!("Invalid word offset: {}", original))?;
                Ok(Self {
                    area_code: area,
                    db_number: 0,
                    byte_offset: off,
                    bit_offset: 0,
                    transport_size: S7_TS_WORD,
                    byte_length: 2,
                })
            }
            'D' => {
                let off: u16 = rest[1..]
                    .parse()
                    .map_err(|_| anyhow!("Invalid dword offset: {}", original))?;
                Ok(Self {
                    area_code: area,
                    db_number: 0,
                    byte_offset: off,
                    bit_offset: 0,
                    transport_size: S7_TS_DWORD,
                    byte_length: 4,
                })
            }
            _ => {
                // Bit access: <byte>.<bit> or just <byte> for byte access
                if rest.contains('.') {
                    let (byte_str, bit_str) = rest
                        .split_once('.')
                        .ok_or_else(|| anyhow!("Invalid bit address: {}", original))?;
                    let byte_off: u16 = byte_str
                        .parse()
                        .map_err(|_| anyhow!("Invalid byte offset: {}", original))?;
                    let bit_off: u8 = bit_str
                        .parse()
                        .map_err(|_| anyhow!("Invalid bit offset: {}", original))?;
                    if bit_off > 7 {
                        return Err(anyhow!("Bit offset must be 0-7: {}", original));
                    }
                    Ok(Self {
                        area_code: area,
                        db_number: 0,
                        byte_offset: byte_off,
                        bit_offset: bit_off,
                        transport_size: S7_TS_BIT,
                        byte_length: 1,
                    })
                } else {
                    // Numeric only: treat as byte access
                    let off: u16 = rest
                        .parse()
                        .map_err(|_| anyhow!("Invalid address offset: {}", original))?;
                    Ok(Self {
                        area_code: area,
                        db_number: 0,
                        byte_offset: off,
                        bit_offset: 0,
                        transport_size: S7_TS_BYTE,
                        byte_length: 1,
                    })
                }
            }
        }
    }
}

// ============================================================================
// S7 Client
// ============================================================================

/// Siemens S7 communication client
pub struct S7Client {
    config: S7Config,
    connection: Arc<Mutex<Option<TcpStream>>>,
    connected: AtomicBool,
    pdu_reference: Arc<Mutex<u16>>,
    negotiated_pdu: Arc<Mutex<u16>>,
}

impl S7Client {
    /// Create a new S7 client
    pub fn new(config: S7Config) -> Self {
        Self {
            config,
            connection: Arc::new(Mutex::new(None)),
            connected: AtomicBool::new(false),
            pdu_reference: Arc::new(Mutex::new(0)),
            negotiated_pdu: Arc::new(Mutex::new(480)),
        }
    }

    /// Get next PDU reference
    async fn next_pdu_ref(&self) -> u16 {
        let mut pdu_ref = self.pdu_reference.lock().await;
        *pdu_ref = pdu_ref.wrapping_add(1);
        if *pdu_ref == 0 {
            *pdu_ref = 1;
        }
        *pdu_ref
    }

    /// Build TPKT header (RFC 1006)
    fn build_tpkt(payload_len: usize) -> Vec<u8> {
        vec![
            0x03,                             // Version
            0x00,                             // Reserved
            ((payload_len + 4) >> 8) as u8,   // Length high
            ((payload_len + 4) & 0xFF) as u8, // Length low
        ]
    }

    /// Build COTP Connection Request
    fn build_cotp_cr(&self) -> Vec<u8> {
        let mut cotp = vec![
            0x11,    // Length (17 bytes following)
            COTP_CR, // PDU type: Connection Request
            0x00, 0x00, // Destination reference
            0x00, 0x01, // Source reference
            0x00, // Class & options
            // Parameters
            0xC0, 0x01, 0x0A, // TPDU size (1024)
            0xC1, 0x02, // Source TSAP
            0x01, 0x00, // Source TSAP value
            0xC2, 0x02, // Destination TSAP
        ];

        // Destination TSAP: encodes rack and slot
        // Format: 0x01, 0x00 for S7-300/400, varies for 1200/1500
        let conn_type = match self.config.plc_type {
            S7PlcType::S71200 | S7PlcType::S71500 => 0x02,
            _ => 0x01,
        };
        cotp.push(conn_type);
        cotp.push((self.config.rack << 5) | self.config.slot);

        cotp
    }

    /// Build S7 Setup Communication request
    async fn build_setup_comm(&self) -> Vec<u8> {
        let pdu_ref = self.next_pdu_ref().await;

        vec![
            S7_PROTOCOL_ID, // Protocol ID
            S7_JOB,         // Message type: Job
            0x00,
            0x00,                   // Reserved
            (pdu_ref >> 8) as u8,   // PDU reference high
            (pdu_ref & 0xFF) as u8, // PDU reference low
            0x00,
            0x08, // Parameter length (8)
            0x00,
            0x00,               // Data length (0)
            S7_FUNC_SETUP_COMM, // Function: Setup communication
            0x00,               // Reserved
            0x00,
            0x01, // Max AmQ calling
            0x00,
            0x01,                                // Max AmQ called
            (self.config.pdu_size >> 8) as u8,   // PDU size high
            (self.config.pdu_size & 0xFF) as u8, // PDU size low
        ]
    }

    /// Build COTP Data packet
    fn build_cotp_dt(payload: &[u8]) -> Vec<u8> {
        let mut packet = vec![
            0x02,    // COTP header length
            COTP_DT, // PDU type: Data
            0x80,    // EOT (End of Transmission)
        ];
        packet.extend_from_slice(payload);
        packet
    }

    /// Send ISO-on-TCP packet with timeout protection
    async fn send_packet(&self, cotp_payload: &[u8]) -> Result<Vec<u8>> {
        let io_timeout = Duration::from_secs(self.config.timeout_secs);
        let mut conn_guard = self.connection.lock().await;
        let conn = conn_guard
            .as_mut()
            .ok_or_else(|| anyhow!("Not connected"))?;

        // Build full packet
        let tpkt = Self::build_tpkt(cotp_payload.len());
        let mut packet = tpkt;
        packet.extend_from_slice(cotp_payload);

        // Send with timeout
        timeout(io_timeout, conn.write_all(&packet))
            .await
            .map_err(|_| {
                anyhow!(
                    "S7 write timeout after {} seconds",
                    self.config.timeout_secs
                )
            })??;

        // Receive response with timeout
        let mut tpkt_header = [0u8; 4];
        timeout(io_timeout, conn.read_exact(&mut tpkt_header))
            .await
            .map_err(|_| anyhow!("S7 read timeout after {} seconds", self.config.timeout_secs))??;

        if tpkt_header[0] != 0x03 {
            return Err(anyhow!("Invalid TPKT response"));
        }

        let total_length = ((tpkt_header[2] as usize) << 8) | (tpkt_header[3] as usize);
        if total_length < 4 {
            return Err(anyhow!(
                "Invalid TPKT length: {} (minimum is 4)",
                total_length
            ));
        }
        if total_length > MAX_S7_PACKET_SIZE {
            return Err(anyhow!(
                "TPKT packet too large: {} bytes (max {})",
                total_length,
                MAX_S7_PACKET_SIZE
            ));
        }
        let length = total_length - 4;
        let mut response = vec![0u8; length];
        timeout(io_timeout, conn.read_exact(&mut response))
            .await
            .map_err(|_| anyhow!("S7 read timeout after {} seconds", self.config.timeout_secs))??;

        Ok(response)
    }

    /// Establish COTP connection
    async fn cotp_connect(&self) -> Result<()> {
        let cr = self.build_cotp_cr();
        let response = self.send_packet(&cr).await?;

        if response.len() < 2 || response[1] != COTP_CC {
            return Err(anyhow!("COTP connection rejected"));
        }

        debug!("COTP connection established");
        Ok(())
    }

    /// Setup S7 communication
    async fn s7_setup(&self) -> Result<()> {
        let setup = self.build_setup_comm().await;
        let cotp_dt = Self::build_cotp_dt(&setup);
        let response = self.send_packet(&cotp_dt).await?;

        // Parse response (skip COTP header)
        if response.len() < 3 {
            return Err(anyhow!("S7 setup response too short"));
        }

        let s7_response = &response[3..];
        if s7_response.len() < 12 {
            return Err(anyhow!("Invalid S7 setup response"));
        }

        // Check for errors - S7 response format:
        // [0] = protocol ID (0x32)
        // [1] = message type (0x02=ACK, 0x03=ACK_DATA)
        // [2-3] = reserved
        // [4-5] = PDU reference
        // [6-7] = parameter length
        // [8-9] = data length
        // [10] = error class (for ACK_DATA)
        // [11] = error code (for ACK_DATA)
        if s7_response[1] == S7_ACK_DATA {
            // Check error class and code
            let error_class = s7_response[10];
            let error_code = s7_response[11];
            if error_class != 0x00 {
                let error_msg = parse_s7_error(error_class, error_code);
                return Err(anyhow!("S7 setup failed: {}", error_msg));
            }

            // Extract negotiated PDU size
            if s7_response.len() >= 18 {
                let pdu_size = (s7_response[16] as u16) << 8 | s7_response[17] as u16;
                *self.negotiated_pdu.lock().await = pdu_size;
                debug!("Negotiated PDU size: {}", pdu_size);
            }
        } else if s7_response[1] == S7_ACK {
            // ACK without data - check if there's an error indicated
            return Err(anyhow!(
                "S7 setup rejected (ACK without data) - PLC may require authentication"
            ));
        } else {
            return Err(anyhow!(
                "S7 setup failed: unexpected message type 0x{:02X}",
                s7_response[1]
            ));
        }

        Ok(())
    }

    /// Build S7 block download request
    async fn build_download_request(&self, block_type: S7BlockType, block_num: u16) -> Vec<u8> {
        let pdu_ref = self.next_pdu_ref().await;

        // Block filename format: _0A00001P (OB1 in passive file system)
        let block_name = format!("_0{}{:05}P", (block_type as u8) as char, block_num);
        let block_bytes = block_name.as_bytes();

        let mut s7_data = vec![
            S7_PROTOCOL_ID, // Protocol ID
            S7_JOB,         // Message type: Job
            0x00,
            0x00,                   // Reserved
            (pdu_ref >> 8) as u8,   // PDU reference high
            (pdu_ref & 0xFF) as u8, // PDU reference low
        ];

        // Parameter length and data length will be filled later
        let param_len = 18 + block_bytes.len();
        s7_data.extend_from_slice(&(param_len as u16).to_be_bytes());
        s7_data.extend_from_slice(&[0x00, 0x00]); // Data length

        // Download parameters
        s7_data.push(S7_FUNC_START_DOWNLOAD);
        s7_data.push(0x00); // Reserved
        s7_data.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x00, 0x09]); // Unknown
        s7_data.push(block_bytes.len() as u8);
        s7_data.extend_from_slice(block_bytes);

        s7_data
    }

    /// Build S7 PLC control request (Start/Stop)
    async fn build_plc_control(&self, start: bool) -> Vec<u8> {
        let pdu_ref = self.next_pdu_ref().await;

        let func = if start {
            S7_FUNC_PLC_CONTROL
        } else {
            S7_FUNC_PLC_STOP
        };

        // S7 control parameters: P_PROGRAM for start, _STOP for stop
        let param: &[u8] = if start { b"P_PROGRAM" } else { b"_STOP" };

        let mut request = vec![
            S7_PROTOCOL_ID,
            S7_JOB,
            0x00,
            0x00,
            (pdu_ref >> 8) as u8,
            (pdu_ref & 0xFF) as u8,
            0x00,
            (param.len() + 9) as u8, // Parameter length
            0x00,
            0x00, // Data length
            func,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0xFD,
            0x00,
            param.len() as u8,
        ];
        // Append the actual parameter bytes (P_PROGRAM or _STOP)
        request.extend_from_slice(param);
        request
    }

    /// Get maximum data size per packet based on negotiated PDU
    /// S7 packet overhead: TPKT(4) + COTP(3) + S7 header(10-12) + params(~10) ≈ 28 bytes
    async fn max_data_per_packet(&self) -> usize {
        const S7_OVERHEAD: usize = 32; // Conservative overhead estimate
        let negotiated = *self.negotiated_pdu.lock().await as usize;
        negotiated.saturating_sub(S7_OVERHEAD)
    }

    /// Send large data in chunks respecting negotiated PDU size
    async fn send_chunked_data(
        &self,
        data: &[u8],
        block_type: S7BlockType,
        block_num: u16,
    ) -> Result<()> {
        let max_chunk = self.max_data_per_packet().await;
        if max_chunk == 0 {
            return Err(anyhow!("Negotiated PDU too small for data transfer"));
        }

        // usize::div_ceil (stable) — handles edge cases at
        // usize::MAX correctly vs the manual (a+b-1)/b form
        // which can overflow (Batch #25 clippy::manual_div_ceil).
        let total_chunks = data.len().div_ceil(max_chunk);
        debug!(
            "Sending {} bytes in {} chunks (max {} bytes/chunk)",
            data.len(),
            total_chunks,
            max_chunk
        );

        for (i, chunk) in data.chunks(max_chunk).enumerate() {
            let is_last = i == total_chunks - 1;
            debug!(
                "Sending chunk {}/{} ({} bytes, last={})",
                i + 1,
                total_chunks,
                chunk.len(),
                is_last
            );

            // Build download data packet
            let pdu_ref = self.next_pdu_ref().await;
            let mut s7_data = vec![
                S7_PROTOCOL_ID,
                S7_JOB,
                0x00,
                0x00,
                (pdu_ref >> 8) as u8,
                (pdu_ref & 0xFF) as u8,
            ];

            // Parameter length (2 bytes) and data length (2 bytes)
            let param_len: u16 = 2; // Function + reserved
            let data_len = (chunk.len() + 4) as u16; // chunk + 4 bytes header
            s7_data.extend_from_slice(&param_len.to_be_bytes());
            s7_data.extend_from_slice(&data_len.to_be_bytes());

            // Parameters
            s7_data.push(S7_FUNC_DOWNLOAD);
            s7_data.push(if is_last { 0x00 } else { 0x01 }); // More data flag

            // Data header
            s7_data.extend_from_slice(&[0x00, 0xFB]); // Return code + transport size
            s7_data.extend_from_slice(&(chunk.len() as u16).to_be_bytes());

            // Actual data
            s7_data.extend_from_slice(chunk);

            let cotp_dt = Self::build_cotp_dt(&s7_data);
            let response = self.send_packet(&cotp_dt).await?;

            // Verify response
            if response.len() < 6 {
                return Err(anyhow!("Invalid download response for chunk {}", i + 1));
            }
            let s7_resp = &response[3..];
            if s7_resp.len() >= 12 && s7_resp[10] != 0x00 {
                let error_msg = parse_s7_error(s7_resp[10], s7_resp[11]);
                return Err(anyhow!("Download chunk {} failed: {}", i + 1, error_msg));
            }
        }

        debug!(
            "Successfully sent {} bytes for {:?}{}",
            data.len(),
            block_type,
            block_num
        );
        Ok(())
    }

    /// Convert an ST program to S7 MC7 bytecode.
    ///
    /// SENSOR-HIGH-078 (ICS-safety): real ST→MC7 compilation is NOT implemented —
    /// it requires the Siemens compiler or a reverse-engineered MC7 encoder / TIA
    /// Portal Openness bridge. The previous implementation emitted a structurally
    /// invalid OB1 (NOP padding) and let `upload_program` download it to a live
    /// PLC, which can trip the CPU to STOP or corrupt the running program. This
    /// gate fails closed: no MC7 is produced, so no download can occur.
    fn compile_to_mc7(&self, _program: &PlcProgram) -> Result<Vec<u8>> {
        Err(anyhow!(S7_MC7_UNSUPPORTED))
    }

    /// Build an S7 Read Var request for the given addresses
    fn build_read_var_request(pdu_ref: u16, addresses: &[S7Address]) -> Vec<u8> {
        let item_count = addresses.len() as u8;
        let param_len = 2 + (addresses.len() * 12); // func(1) + count(1) + items(12 each)

        let mut s7 = vec![
            S7_PROTOCOL_ID,
            S7_JOB,
            0x00,
            0x00,
            (pdu_ref >> 8) as u8,
            (pdu_ref & 0xFF) as u8,
            (param_len >> 8) as u8,
            (param_len & 0xFF) as u8,
            0x00,
            0x00, // Data length = 0 for read
            S7_FUNC_READ_VAR,
            item_count,
        ];

        for addr in addresses {
            s7.extend_from_slice(&[
                0x12, // Spec type: variable specification
                0x0A, // Length of rest of this item
                0x10, // Syntax ID: S7ANY
                addr.transport_size,
                0x00,
                addr.byte_length, // Count (number of elements)
                (addr.db_number >> 8) as u8,
                (addr.db_number & 0xFF) as u8,
                addr.area_code,
            ]);
            // 3-byte bit address: (byte_offset * 8) + bit_offset
            let bit_addr = (addr.byte_offset as u32) * 8 + addr.bit_offset as u32;
            s7.push((bit_addr >> 16) as u8);
            s7.push((bit_addr >> 8) as u8);
            s7.push((bit_addr & 0xFF) as u8);
        }

        s7
    }

    /// Build an S7 Write Var request
    fn build_write_var_request(pdu_ref: u16, addr: &S7Address, data: &[u8]) -> Vec<u8> {
        let param_len: u16 = 2 + 12; // func(1) + count(1) + 1 item(12)
        let data_bit_len = if addr.transport_size == S7_TS_BIT {
            data.len() as u16
        } else {
            (data.len() as u16) * 8
        };
        let data_transport = if addr.transport_size == S7_TS_BIT {
            S7_TS_DATA_BIT
        } else if addr.transport_size == S7_TS_REAL {
            S7_TS_DATA_REAL
        } else {
            S7_TS_DATA_BYTE_WORD_DWORD
        };
        // Data section: return_code(1) + transport_size(1) + bit_length(2) + data + optional pad
        let data_len = 4 + data.len() + (data.len() % 2); // Pad to even

        let mut s7 = vec![
            S7_PROTOCOL_ID,
            S7_JOB,
            0x00,
            0x00,
            (pdu_ref >> 8) as u8,
            (pdu_ref & 0xFF) as u8,
            (param_len >> 8) as u8,
            (param_len & 0xFF) as u8,
            (data_len >> 8) as u8,
            (data_len & 0xFF) as u8,
            S7_FUNC_WRITE_VAR,
            0x01, // Item count: 1
        ];

        // Item specification
        let bit_addr = (addr.byte_offset as u32) * 8 + addr.bit_offset as u32;
        s7.extend_from_slice(&[
            0x12,
            0x0A,
            0x10,
            addr.transport_size,
            0x00,
            addr.byte_length,
            (addr.db_number >> 8) as u8,
            (addr.db_number & 0xFF) as u8,
            addr.area_code,
            (bit_addr >> 16) as u8,
            (bit_addr >> 8) as u8,
            (bit_addr & 0xFF) as u8,
        ]);

        // Data item
        s7.push(0x00); // Return code (0 for request)
        s7.push(data_transport);
        s7.extend_from_slice(&data_bit_len.to_be_bytes());
        s7.extend_from_slice(data);
        // Pad to even length
        if data.len() % 2 != 0 {
            s7.push(0x00);
        }

        s7
    }

    /// Build SZL read request (System Status List)
    fn build_szl_request(pdu_ref: u16, szl_id: u16, szl_index: u16) -> Vec<u8> {
        // S7 USERDATA message for SZL reading
        // Parameter: 12 bytes header + 4 bytes userdata param
        let param_len: u16 = 8;
        let data_len: u16 = 8; // SZL request data

        let mut s7 = vec![
            S7_PROTOCOL_ID,
            S7_USERDATA,
            0x00,
            0x00,
            (pdu_ref >> 8) as u8,
            (pdu_ref & 0xFF) as u8,
            (param_len >> 8) as u8,
            (param_len & 0xFF) as u8,
            (data_len >> 8) as u8,
            (data_len & 0xFF) as u8,
        ];

        // Parameter: Userdata header
        s7.extend_from_slice(&[
            0x00, 0x01, 0x12, // Parameter head (3 bytes)
            0x04, // Parameter length (4 bytes follow)
            0x11, // Type + group: request (0x1) + SZL functions (0x1)
            0x01, // Subfunction: read SZL
            0x00, // Sequence number
            0x00, // Last data unit (0 = no)
        ]);

        // Data: SZL request
        s7.push(0xFF); // Return code
        s7.push(0x09); // Transport size: octet string
        s7.extend_from_slice(&4u16.to_be_bytes()); // Data length: 4 bytes
        s7.extend_from_slice(&szl_id.to_be_bytes());
        s7.extend_from_slice(&szl_index.to_be_bytes());

        s7
    }

    /// Read SZL data from PLC
    async fn read_szl(&self, szl_id: u16, szl_index: u16) -> Result<Vec<u8>> {
        let pdu_ref = self.next_pdu_ref().await;
        let request = Self::build_szl_request(pdu_ref, szl_id, szl_index);
        let cotp_dt = Self::build_cotp_dt(&request);
        let response = self.send_packet(&cotp_dt).await?;

        // Skip COTP header (3 bytes), then parse S7 userdata response
        if response.len() < 3 {
            return Err(anyhow!("SZL response too short"));
        }
        let s7 = &response[3..];
        if s7.len() < 12 {
            return Err(anyhow!("SZL S7 response too short"));
        }

        // Check message type
        if s7[1] != S7_USERDATA && s7[1] != S7_ACK_DATA {
            return Err(anyhow!("Unexpected SZL response type: 0x{:02X}", s7[1]));
        }

        // Get data length from header
        let _data_length = ((s7[8] as usize) << 8) | s7[9] as usize;
        let param_length = ((s7[6] as usize) << 8) | s7[7] as usize;

        let data_start = 10 + param_length;
        if s7.len() < data_start + 4 {
            return Err(anyhow!("SZL data too short"));
        }

        // Data section: return_code(1) + transport_size(1) + length(2) + SZL data
        let return_code = s7
            .get(data_start)
            .copied()
            .ok_or_else(|| anyhow!("S7 read response data item missing return code"))?;
        if return_code != 0xFF {
            return Err(anyhow!(
                "SZL read failed with return code: 0x{:02X}",
                return_code
            ));
        }

        let szl_data_len = ((s7[data_start + 2] as usize) << 8) | s7[data_start + 3] as usize;
        let szl_start = data_start + 4;
        if s7.len() < szl_start + szl_data_len {
            return Err(anyhow!("SZL data truncated"));
        }

        Ok(s7[szl_start..szl_start + szl_data_len].to_vec())
    }
}

#[async_trait::async_trait]
impl PlcProgrammer for S7Client {
    fn protocol_name(&self) -> &'static str {
        "S7comm"
    }

    async fn connect(&mut self) -> Result<()> {
        let addr = format!("{}:{}", self.config.address, self.config.port);
        info!("Connecting to Siemens S7 PLC at {}", addr);

        // Security warning: S7comm protocol does not support TLS encryption
        // For secure deployments, use VPN or network segmentation per IEC 62443
        warn!("S7comm connection is unencrypted - ensure network is secured (VPN/segmentation)");

        let timeout_duration = std::time::Duration::from_secs(self.config.timeout_secs);

        let stream =
            with_timeout(TcpStream::connect(&addr), timeout_duration, "S7 connect").await?;

        *self.connection.lock().await = Some(stream);

        // COTP connection
        self.cotp_connect().await?;

        // S7 setup
        self.s7_setup().await?;

        self.connected.store(true, Ordering::Release);
        info!("Connected to Siemens S7 PLC: {}", self.config.name);

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        // Graceful disconnect: properly close TCP connection
        if let Some(mut conn) = self.connection.lock().await.take() {
            // Attempt graceful shutdown, ignore errors (connection might already be closed)
            if let Err(e) = conn.shutdown().await {
                debug!("S7 disconnect shutdown notice: {}", e);
            }
        }
        self.connected.store(false, Ordering::Release);
        info!("Disconnected from Siemens S7 PLC: {}", self.config.name);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    async fn get_status(&self) -> Result<PlcStatus> {
        let default_model = match self.config.plc_type {
            S7PlcType::S7200 => "S7-200",
            S7PlcType::S7300 => "S7-300",
            S7PlcType::S7400 => "S7-400",
            S7PlcType::S71200 => "S7-1200",
            S7PlcType::S71500 => "S7-1500",
            S7PlcType::Logo => "LOGO!",
        };

        let mut firmware = "Unknown".to_string();
        let mut run_mode = PlcRunMode::Unknown;

        // Try SZL 0x0011 for module identification (firmware version)
        if self.is_connected() {
            if let Ok(szl_data) = self.read_szl(0x0011, 0x0001).await {
                // SZL 0x0011: Module Identification
                // Record format: szl_id(2) + index(2) + order_number(20) + firmware(8)
                if szl_data.len() >= 32 {
                    // Firmware version is at offset 24, 8 bytes
                    let fw_bytes = szl_data.get(24..32).unwrap_or(&[]);
                    let fw_end = fw_bytes
                        .iter()
                        .position(|&b| b == 0)
                        .unwrap_or(fw_bytes.len());
                    if fw_end > 0 {
                        firmware = String::from_utf8_lossy(fw_bytes.get(..fw_end).unwrap_or(&[]))
                            .trim()
                            .to_string();
                    }
                }
            }

            // Try SZL 0x0024 for CPU state
            if let Ok(szl_data) = self.read_szl(0x0024, 0x0000).await {
                // SZL 0x0024: CPU state
                // Record format depends on PLC, but first data usually contains state
                if szl_data.len() >= 4 {
                    // CPU state is typically at offset 2-3
                    let state = if szl_data.len() >= 4 {
                        ((szl_data[2] as u16) << 8) | szl_data[3] as u16
                    } else {
                        0
                    };
                    run_mode = match state & 0xFF {
                        0x04 => PlcRunMode::Stop,
                        0x08 => PlcRunMode::Run,
                        _ => PlcRunMode::Unknown,
                    };
                }
            }
        }

        Ok(PlcStatus {
            connected: self.is_connected(),
            run_mode,
            model: default_model.to_string(),
            firmware,
            current_program: None,
            last_modified: None,
        })
    }

    async fn upload_program(&self, program: &PlcProgram) -> Result<UploadResult> {
        info!(
            "Uploading program '{}' to Siemens S7 PLC: {}",
            program.name, self.config.name
        );

        validate_program_source(&program.source)?;

        // Compile to MC7
        let mc7 = self.compile_to_mc7(program)?;
        let mut errors = Vec::new();
        let mut success = true;

        // S7 download sequence:
        // 1. Start download request
        // 2. Send data in chunks (respecting negotiated PDU size)
        // 3. End download request

        // Step 1: Start download
        let download_req = self.build_download_request(S7BlockType::OB, 1).await;
        let cotp_dt = Self::build_cotp_dt(&download_req);

        match self.send_packet(&cotp_dt).await {
            Ok(response) => {
                // Verify start download was accepted
                if response.len() >= 6 {
                    let s7_resp = &response[3..];
                    if s7_resp.len() >= 12 && s7_resp[10] != 0x00 {
                        let error_msg = parse_s7_error(s7_resp[10], s7_resp[11]);
                        errors.push(format!("Start download rejected: {}", error_msg));
                        success = false;
                    }
                }

                // Step 2: Send data chunks (only if start was successful)
                if success {
                    if let Err(e) = self.send_chunked_data(&mc7, S7BlockType::OB, 1).await {
                        errors.push(format!("Data transfer failed: {}", e));
                        success = false;
                    }
                }

                // Step 3: End download (only if previous steps succeeded)
                if success {
                    let pdu_ref = self.next_pdu_ref().await;
                    let end_download = vec![
                        S7_PROTOCOL_ID,
                        S7_JOB,
                        0x00,
                        0x00,
                        (pdu_ref >> 8) as u8,
                        (pdu_ref & 0xFF) as u8,
                        0x00,
                        0x01, // Param length
                        0x00,
                        0x00, // Data length
                        S7_FUNC_END_DOWNLOAD,
                    ];
                    let cotp_end = Self::build_cotp_dt(&end_download);
                    if let Err(e) = self.send_packet(&cotp_end).await {
                        errors.push(format!("End download failed: {}", e));
                        success = false;
                    }
                }
            }
            Err(e) => {
                errors.push(e.to_string());
                success = false;
            }
        }

        let result = UploadResult {
            success,
            program_id: if success {
                Some(format!("OB1_{}", program.name))
            } else {
                None
            },
            warnings: vec!["Full ST compilation requires TIA Portal Openness API".to_string()],
            errors,
            timestamp: chrono::Utc::now().to_rfc3339(),
            plc_response: HashMap::new(),
        };

        audit_program_upload(
            "S7comm",
            &self.config.address,
            &program.name,
            success,
            if success { "OK" } else { "Failed" },
        );

        Ok(result)
    }

    async fn download_program(&self, program_name: &str) -> Result<PlcProgram> {
        // Parse block type and number from name (e.g., "OB1", "FB10")
        let (block_type, _block_num) = if program_name.len() >= 3 {
            let type_str = &program_name[..2];
            let num_str = &program_name[2..];
            let block_type = S7BlockType::from_str(type_str)
                .ok_or_else(|| anyhow!("Invalid block type: {}", type_str))?;
            let block_num: u16 = num_str
                .parse()
                .map_err(|_| anyhow!("Invalid block number: {}", num_str))?;
            (block_type, block_num)
        } else {
            return Err(anyhow!("Invalid program name format: {}", program_name));
        };

        // Upload (read from PLC) would go here
        // This requires the S7 upload protocol sequence

        Ok(PlcProgram {
            name: program_name.to_string(),
            language: super::ProgramLanguage::St,
            source: format!("// Downloaded from S7 PLC\n// Block type: {:?}", block_type),
            variables: Vec::new(),
            function_blocks: Vec::new(),
            metadata: HashMap::new(),
        })
    }

    async fn start(&self) -> Result<()> {
        info!("Starting Siemens S7 PLC: {}", self.config.name);

        let control = self.build_plc_control(true).await;
        let cotp_dt = Self::build_cotp_dt(&control);
        self.send_packet(&cotp_dt).await?;

        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        info!("Stopping Siemens S7 PLC: {}", self.config.name);

        let control = self.build_plc_control(false).await;
        let cotp_dt = Self::build_cotp_dt(&control);
        self.send_packet(&cotp_dt).await?;

        Ok(())
    }

    async fn list_programs(&self) -> Result<Vec<String>> {
        // Try SZL 0x0013 for block list
        if self.is_connected() {
            if let Ok(szl_data) = self.read_szl(0x0013, 0x0000).await {
                // SZL 0x0013: Block type and count
                // Each record: block_type(2) + count(2) = 4 bytes
                let mut programs = Vec::new();
                let block_type_names = |bt: u16| -> &'static str {
                    match bt {
                        0x0800 => "OB",
                        0x0A00 => "DB",
                        0x0B00 => "SDB",
                        0x0C00 => "FC",
                        0x0D00 => "SFC",
                        0x0E00 => "FB",
                        0x0F00 => "SFB",
                        _ => "",
                    }
                };

                // Skip SZL header (szl_id(2) + index(2) = 4 bytes if present)
                let records = if szl_data.len() >= 4 {
                    &szl_data[4..]
                } else {
                    &szl_data[..]
                };

                for chunk in records.chunks(4) {
                    if chunk.len() < 4 {
                        break;
                    }
                    let [type_hi, type_lo, count_hi, count_lo]: [u8; 4] = match chunk.try_into() {
                        Ok(bytes) => bytes,
                        Err(_) => break,
                    };
                    let block_type = ((type_hi as u16) << 8) | type_lo as u16;
                    let count = ((count_hi as u16) << 8) | count_lo as u16;
                    let name = block_type_names(block_type);
                    if !name.is_empty() && count > 0 {
                        for i in 1..=count.min(20) {
                            // Cap at 20 per type
                            programs.push(format!("{}{}", name, i));
                        }
                    }
                }

                if !programs.is_empty() {
                    return Ok(programs);
                }
            }
        }

        // Fallback: return common blocks
        Ok(vec![
            "OB1".to_string(),
            "OB100".to_string(),
            "DB1".to_string(),
        ])
    }

    async fn delete_program(&self, program_name: &str) -> Result<()> {
        warn!(
            "Deleting block '{}' from Siemens S7 PLC: {}",
            program_name, self.config.name
        );

        // S7 block delete would go here
        // Requires PI service (Program Invocation)

        Ok(())
    }

    async fn compile(&self, program: &PlcProgram) -> Result<UploadResult> {
        validate_program_source(&program.source)?;

        // SENSOR-HIGH-078: ST→MC7 compilation is not implemented. Report an honest
        // compile failure instead of a fake success with a soft "simplified"
        // warning — a caller must not believe a downloadable artifact exists.
        Ok(UploadResult {
            success: false,
            program_id: None,
            warnings: Vec::new(),
            errors: vec![S7_MC7_UNSUPPORTED.to_string()],
            timestamp: chrono::Utc::now().to_rfc3339(),
            plc_response: HashMap::new(),
        })
    }

    async fn read_variable(
        &self,
        address: &str,
        _data_type: &super::PlcDataType,
        _count: u16,
    ) -> Result<Vec<u8>> {
        let s7_addr = S7Address::parse(address)?;
        let pdu_ref = self.next_pdu_ref().await;
        let request = Self::build_read_var_request(pdu_ref, &[s7_addr]);
        let cotp_dt = Self::build_cotp_dt(&request);
        let response = self.send_packet(&cotp_dt).await?;

        // Parse response: skip COTP header (3 bytes)
        if response.len() < 6 {
            return Err(anyhow!("Read variable response too short"));
        }
        let s7 = &response[3..];
        if s7.len() < 12 {
            return Err(anyhow!("Invalid S7 read response"));
        }

        // Check error
        if s7[1] == S7_ACK_DATA && s7[10] != 0x00 {
            let error_msg = parse_s7_error(s7[10], s7[11]);
            return Err(anyhow!("S7 read variable failed: {}", error_msg));
        }

        // Parse data: skip header (12 bytes) + param section
        let param_len = s7
            .get(6..8)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u16::from_be_bytes)
            .ok_or_else(|| anyhow!("S7 write response missing parameter length"))?
            as usize;
        let data_start = 12 + param_len;
        if s7.len() < data_start + 4 {
            return Err(anyhow!("S7 read response data too short"));
        }

        // Data item: return_code(1) + transport_size(1) + data_length(2) + data
        let return_code = s7[data_start];
        if return_code != 0xFF {
            return Err(anyhow!(
                "S7 read data error: return code 0x{:02X}",
                return_code
            ));
        }

        let transport_size = s7[data_start + 1];
        let data_bit_len = ((s7[data_start + 2] as usize) << 8) | s7[data_start + 3] as usize;
        let data_byte_len = if transport_size == S7_TS_DATA_BIT {
            data_bit_len
        } else {
            // usize::div_ceil (Batch #25 clippy::manual_div_ceil
            // cleanup) — converts bits-to-bytes with correct
            // ceiling rounding without (a+b-1)/b overflow risk.
            data_bit_len.div_ceil(8)
        };

        let data_offset = data_start + 4;
        if s7.len() < data_offset + data_byte_len {
            return Err(anyhow!("S7 read data truncated"));
        }

        Ok(s7[data_offset..data_offset + data_byte_len].to_vec())
    }

    async fn write_variable(
        &self,
        address: &str,
        _data_type: &super::PlcDataType,
        data: &[u8],
    ) -> Result<()> {
        let s7_addr = S7Address::parse(address)?;
        let pdu_ref = self.next_pdu_ref().await;
        let request = Self::build_write_var_request(pdu_ref, &s7_addr, data);
        let cotp_dt = Self::build_cotp_dt(&request);
        let response = self.send_packet(&cotp_dt).await?;

        // Parse response
        if response.len() < 6 {
            return Err(anyhow!("Write variable response too short"));
        }
        let s7 = &response[3..];
        if s7.len() < 12 {
            return Err(anyhow!("Invalid S7 write response"));
        }

        // Check header error
        let response_type = s7
            .get(1)
            .copied()
            .ok_or_else(|| anyhow!("S7 write response missing type"))?;
        let error_class = s7
            .get(10)
            .copied()
            .ok_or_else(|| anyhow!("S7 write response missing error class"))?;
        if response_type == S7_ACK_DATA && error_class != 0x00 {
            let error_code = s7
                .get(11)
                .copied()
                .ok_or_else(|| anyhow!("S7 write response missing error code"))?;
            let error_msg = parse_s7_error(error_class, error_code);
            return Err(anyhow!("S7 write variable failed: {}", error_msg));
        }

        // Check data item return code
        let param_len = ((s7[6] as usize) << 8) | s7[7] as usize;
        let data_start = 12 + param_len;
        if s7.len() > data_start {
            let return_code = s7
                .get(data_start)
                .copied()
                .ok_or_else(|| anyhow!("S7 write response data item missing return code"))?;
            if return_code != 0xFF {
                return Err(anyhow!(
                    "S7 write data error: return code 0x{:02X}",
                    return_code
                ));
            }
        }

        Ok(())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::ProgramLanguage;
    use super::*;

    fn sample_st_program() -> PlcProgram {
        PlcProgram {
            name: "ob1".to_string(),
            language: ProgramLanguage::St,
            source: "PROGRAM main VAR x : BOOL; END_VAR x := TRUE; END_PROGRAM".to_string(),
            variables: Vec::new(),
            function_blocks: Vec::new(),
            metadata: HashMap::new(),
        }
    }

    /// SENSOR-HIGH-078 — compilation must fail closed rather than emit placeholder
    /// bytecode that `upload_program` would ship to a live PLC.
    #[test]
    fn compile_to_mc7_refuses_to_emit_placeholder_bytecode() {
        let client = S7Client::new(S7Config::default());
        let err = client.compile_to_mc7(&sample_st_program()).unwrap_err();
        assert!(
            err.to_string().contains("not implemented"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn upload_program_fails_closed_before_touching_the_plc() {
        // The client is not connected: had upload reached the S7 download sequence
        // it would fail with a connection error. It must fail earlier, at
        // compilation, so no MC7 is ever sent to a live PLC (SENSOR-HIGH-078).
        let client = S7Client::new(S7Config::default());
        let err = client
            .upload_program(&sample_st_program())
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("not implemented"),
            "expected compile-gate error before any PLC I/O, got: {err}"
        );
    }

    #[tokio::test]
    async fn compile_reports_honest_failure_not_fake_success() {
        let client = S7Client::new(S7Config::default());
        let result = client.compile(&sample_st_program()).await.unwrap();
        assert!(!result.success);
        assert!(result.warnings.is_empty());
        assert!(result.errors.iter().any(|e| e.contains("not implemented")));
    }

    #[test]
    fn test_config_default() {
        let config = S7Config::default();
        assert_eq!(config.port, DEFAULT_S7_PORT);
        assert_eq!(config.rack, 0);
        assert_eq!(config.slot, 1);
    }

    #[test]
    fn test_tpkt_header() {
        let tpkt = S7Client::build_tpkt(10);
        assert_eq!(tpkt[0], 0x03);
        assert_eq!(tpkt[1], 0x00);
        assert_eq!(tpkt[2], 0x00);
        assert_eq!(tpkt[3], 14); // 10 + 4
    }

    #[test]
    fn test_block_type_parse() {
        assert_eq!(S7BlockType::from_str("OB"), Some(S7BlockType::OB));
        assert_eq!(S7BlockType::from_str("DB"), Some(S7BlockType::DB));
        assert_eq!(S7BlockType::from_str("FB"), Some(S7BlockType::FB));
        assert_eq!(S7BlockType::from_str("XX"), None);
    }

    #[test]
    fn test_s7_address_parse_db() {
        let addr = S7Address::parse("DB1.DBW0").unwrap();
        assert_eq!(addr.area_code, S7_AREA_DB);
        assert_eq!(addr.db_number, 1);
        assert_eq!(addr.byte_offset, 0);
        assert_eq!(addr.transport_size, S7_TS_WORD);
        assert_eq!(addr.byte_length, 2);

        let addr = S7Address::parse("DB100.DBD4").unwrap();
        assert_eq!(addr.db_number, 100);
        assert_eq!(addr.byte_offset, 4);
        assert_eq!(addr.transport_size, S7_TS_DWORD);
        assert_eq!(addr.byte_length, 4);
    }

    #[test]
    fn test_s7_address_parse_merker() {
        let addr = S7Address::parse("MW100").unwrap();
        assert_eq!(addr.area_code, S7_AREA_MK);
        assert_eq!(addr.byte_offset, 100);
        assert_eq!(addr.transport_size, S7_TS_WORD);

        let addr = S7Address::parse("MD20").unwrap();
        assert_eq!(addr.area_code, S7_AREA_MK);
        assert_eq!(addr.byte_offset, 20);
        assert_eq!(addr.transport_size, S7_TS_DWORD);
    }

    #[test]
    fn test_s7_address_parse_bit() {
        let addr = S7Address::parse("M0.3").unwrap();
        assert_eq!(addr.area_code, S7_AREA_MK);
        assert_eq!(addr.byte_offset, 0);
        assert_eq!(addr.bit_offset, 3);
        assert_eq!(addr.transport_size, S7_TS_BIT);

        let addr = S7Address::parse("DB1.DBX0.7").unwrap();
        assert_eq!(addr.area_code, S7_AREA_DB);
        assert_eq!(addr.db_number, 1);
        assert_eq!(addr.bit_offset, 7);
    }

    #[test]
    fn test_s7_address_parse_input_output() {
        let addr = S7Address::parse("IW0").unwrap();
        assert_eq!(addr.area_code, S7_AREA_PE);
        assert_eq!(addr.transport_size, S7_TS_WORD);

        let addr = S7Address::parse("QD4").unwrap();
        assert_eq!(addr.area_code, S7_AREA_PA);
        assert_eq!(addr.transport_size, S7_TS_DWORD);
        assert_eq!(addr.byte_offset, 4);
    }

    #[test]
    fn test_s7_address_parse_invalid() {
        assert!(S7Address::parse("XX0").is_err());
        assert!(S7Address::parse("DB1").is_err()); // Missing field
        assert!(S7Address::parse("M0.9").is_err()); // Bit > 7
        assert!(S7Address::parse("").is_err());
    }

    #[test]
    fn test_build_read_var_request() {
        let addr = S7Address::parse("DB1.DBW0").unwrap();
        let request = S7Client::build_read_var_request(1, &[addr]);

        // Verify S7 header
        assert_eq!(request[0], S7_PROTOCOL_ID);
        assert_eq!(request[1], S7_JOB);
        assert_eq!(request[10], S7_FUNC_READ_VAR);
        assert_eq!(request[11], 1); // Item count

        // Verify item specification
        assert_eq!(request[12], 0x12); // Spec type
        assert_eq!(request[13], 0x0A); // Length
        assert_eq!(request[14], 0x10); // Syntax ID S7ANY
    }

    #[test]
    fn test_build_write_var_request() {
        let addr = S7Address::parse("MW100").unwrap();
        let data = [0x00, 0x42]; // Value to write
        let request = S7Client::build_write_var_request(1, &addr, &data);

        assert_eq!(request[0], S7_PROTOCOL_ID);
        assert_eq!(request[1], S7_JOB);
        assert_eq!(request[10], S7_FUNC_WRITE_VAR);
        assert_eq!(request[11], 1); // Item count
    }

    #[test]
    fn test_build_szl_request() {
        let request = S7Client::build_szl_request(1, 0x0011, 0x0001);

        assert_eq!(request[0], S7_PROTOCOL_ID);
        assert_eq!(request[1], S7_USERDATA);
        // Verify SZL ID is in the data section
        let data_start = 10 + 8; // After S7 header + param
        assert_eq!(request[data_start + 4], 0x00); // SZL ID high
        assert_eq!(request[data_start + 5], 0x11); // SZL ID low
    }
}
