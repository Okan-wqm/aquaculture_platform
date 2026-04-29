//! Deploy Orchestrator
//!
//! Unified deploy command routing for multi-target program deployment.
//! Routes deploy commands to the appropriate target:
//! - Yol A: Internal Rust scripting engine (no external PLC needed)
//! - Yol B: Codesys-based PLC (sends ST source, PLC compiles on-device)
//! - Yol C: Closed PLC setpoint writes (OPC-UA, Modbus, S7comm)
//!
//! ## v2.2 Feature

use serde::{Deserialize, Serialize};

// ============================================================================
// Types
// ============================================================================

/// Deploy target types
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeployTarget {
    /// Yol A: Internal Rust scripting engine (no external PLC)
    RustEngine,
    /// Yol B: Codesys-based PLC (send ST source, PLC compiles on-device)
    CodesysPlc,
    /// Yol C: Closed PLC - setpoint write only (OPC-UA/Modbus/S7)
    PlcSetpoint,
}

impl Default for DeployTarget {
    fn default() -> Self {
        Self::RustEngine
    }
}

impl std::fmt::Display for DeployTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RustEngine => write!(f, "rust_engine"),
            Self::CodesysPlc => write!(f, "codesys_plc"),
            Self::PlcSetpoint => write!(f, "plc_setpoint"),
        }
    }
}

/// Unified deploy command payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployCommand {
    /// Target to deploy to
    pub target: DeployTarget,
    /// Program name
    pub program_name: String,
    /// Program ID (UUID)
    pub program_id: String,
    /// Program version
    pub version: u32,

    // -- Yol A: Rust engine fields --
    /// Script definition for Rust engine
    #[serde(default)]
    pub script: Option<serde_json::Value>,
    /// Function block definitions
    #[serde(default)]
    pub function_blocks: Vec<serde_json::Value>,
    /// Execution mode: "scan_cycle" or "event_driven"
    #[serde(default)]
    pub execution_mode: Option<String>,
    /// Scan cycle period in milliseconds
    #[serde(default)]
    pub scan_cycle_ms: Option<u64>,

    // -- Yol B: Codesys PLC fields --
    /// Raw IEC 61131-3 Structured Text source code
    #[serde(default)]
    pub st_source: Option<String>,
    /// PLC IP address (e.g., "192.168.1.100")
    #[serde(default)]
    pub plc_address: Option<String>,
    /// PLC port (default 1217 for Codesys Gateway)
    #[serde(default)]
    pub plc_port: Option<u16>,
    /// PLC protocol identifier
    #[serde(default)]
    pub plc_protocol: Option<String>,
    /// PLC authentication credentials
    #[serde(default)]
    pub plc_credentials: Option<PlcCredentials>,

    // -- Yol C: Setpoint write fields --
    /// Setpoint values to write
    #[serde(default)]
    pub setpoints: Option<Vec<SetpointWrite>>,
    /// Protocol for setpoint writes: "opcua", "modbus", "s7comm"
    #[serde(default)]
    pub setpoint_protocol: Option<String>,
}

/// PLC authentication credentials
/// Note: Debug is implemented manually to redact password from logs (IEC 62443 SL-2 compliance)
/// Password wrapped in Secret<String> for automatic zeroize-on-drop.
#[derive(Clone, Serialize, Deserialize)]
pub struct PlcCredentials {
    pub username: Option<String>,
    #[serde(
        skip_serializing,
        default,
        deserialize_with = "deserialize_plc_password"
    )]
    pub password: Option<secrecy::Secret<String>>,
}

fn deserialize_plc_password<'de, D>(
    deserializer: D,
) -> Result<Option<secrecy::Secret<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(deserializer)?;
    Ok(opt.map(secrecy::Secret::new))
}

impl std::fmt::Debug for PlcCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlcCredentials")
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

/// A single setpoint write operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetpointWrite {
    /// Target address (Modbus register, OPC-UA node, S7 DB address)
    pub address: String,
    /// Value to write
    pub value: serde_json::Value,
    /// IEC 61131-3 data type: "BOOL", "INT", "REAL", etc.
    pub data_type: String,
}

/// Result of a deploy operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployResult {
    /// Whether the deployment succeeded
    pub success: bool,
    /// Which target was used
    pub target: DeployTarget,
    /// Human-readable result message
    pub message: String,
    /// Compilation or deploy warnings
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Compilation or deploy errors
    #[serde(default)]
    pub errors: Vec<String>,
    /// PLC run mode after deploy (e.g., "RUN", "STOP")
    #[serde(default)]
    pub plc_status: Option<String>,
    /// ISO 8601 timestamp
    pub timestamp: String,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deploy_target_serialization() {
        let target = DeployTarget::CodesysPlc;
        let json = serde_json::to_string(&target).unwrap();
        assert_eq!(json, "\"codesys_plc\"");

        let decoded: DeployTarget = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, DeployTarget::CodesysPlc);
    }

    #[test]
    fn test_deploy_target_all_variants() {
        let variants = vec![
            (DeployTarget::RustEngine, "\"rust_engine\""),
            (DeployTarget::CodesysPlc, "\"codesys_plc\""),
            (DeployTarget::PlcSetpoint, "\"plc_setpoint\""),
        ];
        for (target, expected_json) in variants {
            let json = serde_json::to_string(&target).unwrap();
            assert_eq!(json, expected_json);
            let decoded: DeployTarget = serde_json::from_str(&json).unwrap();
            assert_eq!(decoded, target);
        }
    }

    #[test]
    fn test_deploy_command_rust_engine() {
        let cmd = DeployCommand {
            target: DeployTarget::RustEngine,
            program_name: "FeedControl".to_string(),
            program_id: "uuid-123".to_string(),
            version: 1,
            script: Some(serde_json::json!({"id": "s1"})),
            function_blocks: vec![serde_json::json!({"fbType": "TON"})],
            execution_mode: Some("scan_cycle".to_string()),
            scan_cycle_ms: Some(100),
            st_source: None,
            plc_address: None,
            plc_port: None,
            plc_protocol: None,
            plc_credentials: None,
            setpoints: None,
            setpoint_protocol: None,
        };

        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["target"], "rust_engine");
        assert_eq!(json["program_name"], "FeedControl");
        assert_eq!(json["scan_cycle_ms"], 100);

        let decoded: DeployCommand = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.target, DeployTarget::RustEngine);
        assert_eq!(decoded.program_name, "FeedControl");
    }

    #[test]
    fn test_deploy_command_codesys() {
        let cmd = DeployCommand {
            target: DeployTarget::CodesysPlc,
            program_name: "SeraPH".to_string(),
            program_id: "uuid-456".to_string(),
            version: 2,
            script: None,
            function_blocks: vec![],
            execution_mode: None,
            scan_cycle_ms: None,
            st_source: Some("VAR x : INT; END_VAR x := x + 1;".to_string()),
            plc_address: Some("192.168.1.100".to_string()),
            plc_port: Some(1217),
            plc_protocol: Some("codesys_v3".to_string()),
            plc_credentials: Some(PlcCredentials {
                username: Some("admin".to_string()),
                password: Some(secrecy::Secret::new("pass".to_string())),
            }),
            setpoints: None,
            setpoint_protocol: None,
        };

        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["target"], "codesys_plc");
        assert!(json["st_source"].as_str().unwrap().contains("VAR"));

        let decoded: DeployCommand = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.target, DeployTarget::CodesysPlc);
        assert_eq!(decoded.plc_address.unwrap(), "192.168.1.100");
    }

    #[test]
    fn test_deploy_command_setpoint() {
        let cmd = DeployCommand {
            target: DeployTarget::PlcSetpoint,
            program_name: "Setpoints".to_string(),
            program_id: "uuid-789".to_string(),
            version: 1,
            script: None,
            function_blocks: vec![],
            execution_mode: None,
            scan_cycle_ms: None,
            st_source: None,
            plc_address: Some("10.0.0.50".to_string()),
            plc_port: Some(502),
            plc_protocol: None,
            plc_credentials: None,
            setpoints: Some(vec![
                SetpointWrite {
                    address: "40001".to_string(),
                    value: serde_json::json!(350),
                    data_type: "INT".to_string(),
                },
                SetpointWrite {
                    address: "40002".to_string(),
                    value: serde_json::json!(22.5),
                    data_type: "REAL".to_string(),
                },
            ]),
            setpoint_protocol: Some("modbus".to_string()),
        };

        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["setpoints"].as_array().unwrap().len(), 2);

        let decoded: DeployCommand = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.setpoints.as_ref().unwrap().len(), 2);
        assert_eq!(decoded.setpoints.as_ref().unwrap()[0].address, "40001");
    }

    #[test]
    fn test_deploy_result_success() {
        let result = DeployResult {
            success: true,
            target: DeployTarget::CodesysPlc,
            message: "Program deployed successfully".to_string(),
            warnings: vec!["Unused variable 'temp'".to_string()],
            errors: vec![],
            plc_status: Some("Run".to_string()),
            timestamp: "2026-01-15T10:30:00Z".to_string(),
        };

        let json = serde_json::to_value(&result).unwrap();
        assert!(json["success"].as_bool().unwrap());
        assert_eq!(json["plc_status"], "Run");
        assert_eq!(json["warnings"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_deploy_result_failure() {
        let result = DeployResult {
            success: false,
            target: DeployTarget::CodesysPlc,
            message: "Compilation failed".to_string(),
            warnings: vec![],
            errors: vec!["Line 5: Type mismatch".to_string()],
            plc_status: None,
            timestamp: "2026-01-15T10:30:00Z".to_string(),
        };

        let json = serde_json::to_value(&result).unwrap();
        assert!(!json["success"].as_bool().unwrap());
        assert_eq!(json["errors"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_deploy_target_default() {
        assert_eq!(DeployTarget::default(), DeployTarget::RustEngine);
    }

    #[test]
    fn test_deploy_target_display() {
        assert_eq!(DeployTarget::RustEngine.to_string(), "rust_engine");
        assert_eq!(DeployTarget::CodesysPlc.to_string(), "codesys_plc");
        assert_eq!(DeployTarget::PlcSetpoint.to_string(), "plc_setpoint");
    }
}
