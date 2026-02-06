//! Common utilities for PLC programming protocols
//!
//! Shared functionality across all PLC programming implementations.

use anyhow::{Result, anyhow};
use super::{PlcDataType, PlcVariableValue, VariableScope};
use std::time::Duration;
use tokio::time::timeout;
use tracing::{info, warn};

/// Default connection timeout
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Default operation timeout
pub const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

/// Default program upload timeout (longer for large programs)
pub const DEFAULT_UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Maximum program size (10 MB)
pub const MAX_PROGRAM_SIZE: usize = 10 * 1024 * 1024;

/// Validate program source code
pub fn validate_program_source(source: &str) -> Result<()> {
    if source.is_empty() {
        return Err(anyhow!("Program source cannot be empty"));
    }

    if source.len() > MAX_PROGRAM_SIZE {
        return Err(anyhow!(
            "Program size {} bytes exceeds maximum {} bytes",
            source.len(),
            MAX_PROGRAM_SIZE
        ));
    }

    // Basic ST syntax validation
    let source_upper = source.to_uppercase();

    // Check for common ST keywords
    let has_var = source_upper.contains("VAR") || source_upper.contains("PROGRAM");
    if !has_var {
        warn!("Program may not contain valid IEC 61131-3 declarations");
    }

    Ok(())
}

/// Parsed ST variable with full scope and initial value information
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedStVariable {
    pub name: String,
    pub data_type: String,
    pub scope: VariableScope,
    pub initial_value: Option<String>,
}

/// Parse Structured Text variable declarations with scope awareness
pub fn parse_st_variables(source: &str) -> Vec<ParsedStVariable> {
    let mut variables = Vec::new();

    let lines: Vec<&str> = source.lines().collect();
    let mut in_var_block = false;
    let mut current_scope = VariableScope::Local;

    for line in lines {
        let trimmed = line.trim();
        let upper = trimmed.to_uppercase();

        // Detect VAR block openings with scope
        if !in_var_block {
            if upper.starts_with("VAR_INPUT") {
                in_var_block = true;
                current_scope = VariableScope::Input;
                continue;
            } else if upper.starts_with("VAR_OUTPUT") {
                in_var_block = true;
                current_scope = VariableScope::Output;
                continue;
            } else if upper.starts_with("VAR_IN_OUT") {
                in_var_block = true;
                current_scope = VariableScope::InOut;
                continue;
            } else if upper.starts_with("VAR_GLOBAL") {
                in_var_block = true;
                current_scope = VariableScope::Global;
                continue;
            } else if upper.starts_with("VAR") {
                in_var_block = true;
                current_scope = VariableScope::Local;
                continue;
            }
        }

        if upper == "END_VAR" {
            in_var_block = false;
            continue;
        }

        if in_var_block && trimmed.contains(':') {
            // Parse variable declaration: name : type [:= initial];
            if let Some(colon_pos) = trimmed.find(':') {
                let name = trimmed[..colon_pos].trim().to_string();
                let rest = &trimmed[colon_pos + 1..];

                // Extract type (before := or ;)
                let type_end = rest
                    .find(":=")
                    .or_else(|| rest.find(';'))
                    .unwrap_or(rest.len());
                let data_type = rest[..type_end].trim().to_string();

                // Extract initial value (between := and ;)
                let initial_value = if let Some(assign_pos) = rest.find(":=") {
                    let after_assign = &rest[assign_pos + 2..];
                    let val_end = after_assign.find(';').unwrap_or(after_assign.len());
                    let val = after_assign[..val_end].trim();
                    if val.is_empty() { None } else { Some(val.to_string()) }
                } else {
                    None
                };

                if !name.is_empty() && !data_type.is_empty() {
                    variables.push(ParsedStVariable {
                        name,
                        data_type,
                        scope: current_scope,
                        initial_value,
                    });
                }
            }
        }
    }

    variables
}

/// Convert a PlcVariableValue to its byte representation (little-endian)
pub fn variable_value_to_bytes(value: &PlcVariableValue) -> Vec<u8> {
    match value {
        PlcVariableValue::Bool(v) => vec![if *v { 1 } else { 0 }],
        PlcVariableValue::Sint(v) => vec![*v as u8],
        PlcVariableValue::Int(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::Dint(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::Lint(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::Usint(v) => vec![*v],
        PlcVariableValue::Uint(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::Udint(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::Ulint(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::Real(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::Lreal(v) => v.to_le_bytes().to_vec(),
        PlcVariableValue::String(v) => v.as_bytes().to_vec(),
        PlcVariableValue::WString(v) => v.encode_utf16().flat_map(|c| c.to_le_bytes()).collect(),
        PlcVariableValue::Raw(v) => v.clone(),
    }
}

/// Convert bytes to a PlcVariableValue based on data type (little-endian)
pub fn bytes_to_variable_value(bytes: &[u8], data_type: &PlcDataType) -> Result<PlcVariableValue> {
    match data_type {
        PlcDataType::Bool => {
            if bytes.is_empty() { return Err(anyhow!("Not enough bytes for BOOL")); }
            Ok(PlcVariableValue::Bool(bytes[0] != 0))
        }
        PlcDataType::Sint | PlcDataType::Byte => {
            if bytes.is_empty() { return Err(anyhow!("Not enough bytes for SINT")); }
            Ok(PlcVariableValue::Sint(bytes[0] as i8))
        }
        PlcDataType::Int | PlcDataType::Word => {
            if bytes.len() < 2 { return Err(anyhow!("Not enough bytes for INT")); }
            Ok(PlcVariableValue::Int(i16::from_le_bytes([bytes[0], bytes[1]])))
        }
        PlcDataType::Dint | PlcDataType::Dword | PlcDataType::Time => {
            if bytes.len() < 4 { return Err(anyhow!("Not enough bytes for DINT")); }
            Ok(PlcVariableValue::Dint(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        PlcDataType::Lint | PlcDataType::Lword => {
            if bytes.len() < 8 { return Err(anyhow!("Not enough bytes for LINT")); }
            Ok(PlcVariableValue::Lint(i64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5], bytes[6], bytes[7],
            ])))
        }
        PlcDataType::Usint => {
            if bytes.is_empty() { return Err(anyhow!("Not enough bytes for USINT")); }
            Ok(PlcVariableValue::Usint(bytes[0]))
        }
        PlcDataType::Uint => {
            if bytes.len() < 2 { return Err(anyhow!("Not enough bytes for UINT")); }
            Ok(PlcVariableValue::Uint(u16::from_le_bytes([bytes[0], bytes[1]])))
        }
        PlcDataType::Udint => {
            if bytes.len() < 4 { return Err(anyhow!("Not enough bytes for UDINT")); }
            Ok(PlcVariableValue::Udint(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        PlcDataType::Ulint => {
            if bytes.len() < 8 { return Err(anyhow!("Not enough bytes for ULINT")); }
            Ok(PlcVariableValue::Ulint(u64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5], bytes[6], bytes[7],
            ])))
        }
        PlcDataType::Real => {
            if bytes.len() < 4 { return Err(anyhow!("Not enough bytes for REAL")); }
            Ok(PlcVariableValue::Real(f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
        }
        PlcDataType::Lreal => {
            if bytes.len() < 8 { return Err(anyhow!("Not enough bytes for LREAL")); }
            Ok(PlcVariableValue::Lreal(f64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5], bytes[6], bytes[7],
            ])))
        }
        PlcDataType::String => {
            Ok(PlcVariableValue::String(String::from_utf8_lossy(bytes).to_string()))
        }
        PlcDataType::Wstring => {
            // UTF-16 LE decoding
            let chars: Vec<u16> = bytes.chunks(2)
                .filter(|c| c.len() == 2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            Ok(PlcVariableValue::WString(String::from_utf16_lossy(&chars)))
        }
        _ => Ok(PlcVariableValue::Raw(bytes.to_vec())),
    }
}

/// Generate ST program header
pub fn generate_st_header(program_name: &str, author: &str) -> String {
    let timestamp = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC");
    format!(
        r#"(*
 * Program: {}
 * Author: {}
 * Generated: {}
 * Generator: Suderra Edge Agent v1.3.0
 *)

"#,
        program_name, author, timestamp
    )
}

/// Sanitize program name for PLC compatibility
pub fn sanitize_program_name(name: &str) -> String {
    let mut result = String::with_capacity(name.len());

    for (i, c) in name.chars().enumerate() {
        if i == 0 {
            // First character must be letter or underscore
            if c.is_ascii_alphabetic() || c == '_' {
                result.push(c);
            } else {
                result.push('_');
            }
        } else {
            // Subsequent characters: letter, digit, or underscore
            if c.is_ascii_alphanumeric() || c == '_' {
                result.push(c);
            } else {
                result.push('_');
            }
        }
    }

    // Truncate to reasonable length (most PLCs limit to 32-64 chars)
    if result.len() > 32 {
        result.truncate(32);
    }

    // Ensure not empty
    if result.is_empty() {
        result = "Program1".to_string();
    }

    result
}

/// Convert IEC 61131-3 data type to byte size
pub fn data_type_size(data_type: &str) -> usize {
    match data_type.to_uppercase().as_str() {
        "BOOL" => 1,
        "BYTE" | "SINT" | "USINT" => 1,
        "WORD" | "INT" | "UINT" => 2,
        "DWORD" | "DINT" | "UDINT" | "REAL" => 4,
        "LWORD" | "LINT" | "ULINT" | "LREAL" => 8,
        "TIME" | "DATE" | "TOD" | "DT" => 4,
        "STRING" => 256, // Default string length
        "WSTRING" => 512,
        _ => 4, // Default to DWORD size
    }
}

/// Async operation with timeout wrapper
pub async fn with_timeout<T, E, F>(
    operation: F,
    timeout_duration: Duration,
    operation_name: &str,
) -> Result<T>
where
    F: std::future::Future<Output = std::result::Result<T, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    match timeout(timeout_duration, operation).await {
        Ok(result) => result.map_err(|e| anyhow!(e)),
        Err(_) => Err(anyhow!(
            "Operation '{}' timed out after {:?}",
            operation_name,
            timeout_duration
        )),
    }
}

/// Log program upload audit event
pub fn audit_program_upload(
    protocol: &str,
    plc_address: &str,
    program_name: &str,
    success: bool,
    details: &str,
) {
    if success {
        info!(
            target: "audit",
            protocol = %protocol,
            plc = %plc_address,
            program = %program_name,
            action = "program_upload",
            status = "success",
            details = %details,
            "PLC program uploaded successfully"
        );
    } else {
        warn!(
            target: "audit",
            protocol = %protocol,
            plc = %plc_address,
            program = %program_name,
            action = "program_upload",
            status = "failed",
            details = %details,
            "PLC program upload failed"
        );
    }
}

/// Connection state management
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

impl std::fmt::Display for ConnectionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected => write!(f, "Disconnected"),
            Self::Connecting => write!(f, "Connecting"),
            Self::Connected => write!(f, "Connected"),
            Self::Error => write!(f, "Error"),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_program_source() {
        assert!(validate_program_source("").is_err());
        assert!(validate_program_source("VAR x : INT; END_VAR").is_ok());
    }

    #[test]
    fn test_parse_st_variables() {
        let source = r#"
            VAR
                counter : INT := 0;
                temperature : REAL;
                active : BOOL := FALSE;
            END_VAR
        "#;

        let vars = parse_st_variables(source);
        assert_eq!(vars.len(), 3);
        assert_eq!(vars[0].name, "counter");
        assert_eq!(vars[0].data_type, "INT");
        assert_eq!(vars[0].scope, super::VariableScope::Local);
        assert_eq!(vars[0].initial_value, Some("0".to_string()));
        assert_eq!(vars[1].name, "temperature");
        assert_eq!(vars[1].data_type, "REAL");
        assert_eq!(vars[1].initial_value, None);
        assert_eq!(vars[2].name, "active");
        assert_eq!(vars[2].initial_value, Some("FALSE".to_string()));
    }

    #[test]
    fn test_parse_st_variables_all_scopes() {
        let source = r#"
            VAR_INPUT
                setpoint : REAL := 50.0;
            END_VAR
            VAR_OUTPUT
                result : INT;
            END_VAR
            VAR_IN_OUT
                buffer : DINT;
            END_VAR
            VAR
                local_counter : INT := 0;
            END_VAR
        "#;

        let vars = parse_st_variables(source);
        assert_eq!(vars.len(), 4);
        assert_eq!(vars[0].scope, super::VariableScope::Input);
        assert_eq!(vars[0].initial_value, Some("50.0".to_string()));
        assert_eq!(vars[1].scope, super::VariableScope::Output);
        assert_eq!(vars[1].initial_value, None);
        assert_eq!(vars[2].scope, super::VariableScope::InOut);
        assert_eq!(vars[3].scope, super::VariableScope::Local);
    }

    #[test]
    fn test_variable_value_bytes_roundtrip() {
        use super::{PlcDataType, PlcVariableValue};

        let test_cases: Vec<(PlcVariableValue, PlcDataType)> = vec![
            (PlcVariableValue::Bool(true), PlcDataType::Bool),
            (PlcVariableValue::Sint(-42), PlcDataType::Sint),
            (PlcVariableValue::Int(-1234), PlcDataType::Int),
            (PlcVariableValue::Dint(-123456), PlcDataType::Dint),
            (PlcVariableValue::Lint(-1234567890), PlcDataType::Lint),
            (PlcVariableValue::Usint(200), PlcDataType::Usint),
            (PlcVariableValue::Uint(50000), PlcDataType::Uint),
            (PlcVariableValue::Udint(3000000000), PlcDataType::Udint),
            (PlcVariableValue::Ulint(10000000000), PlcDataType::Ulint),
            (PlcVariableValue::Real(3.14), PlcDataType::Real),
            (PlcVariableValue::Lreal(3.14159265358979), PlcDataType::Lreal),
        ];

        for (value, dt) in &test_cases {
            let bytes = variable_value_to_bytes(value);
            let decoded = bytes_to_variable_value(&bytes, dt).unwrap();
            assert_eq!(*value, decoded, "Roundtrip failed for {:?}", dt);
        }
    }

    #[test]
    fn test_sanitize_program_name() {
        assert_eq!(sanitize_program_name("MyProgram"), "MyProgram");
        assert_eq!(sanitize_program_name("123Start"), "_23Start");
        assert_eq!(sanitize_program_name("Test-Program.1"), "Test_Program_1");
        assert_eq!(sanitize_program_name(""), "Program1");
    }

    #[test]
    fn test_data_type_size() {
        assert_eq!(data_type_size("BOOL"), 1);
        assert_eq!(data_type_size("INT"), 2);
        assert_eq!(data_type_size("DINT"), 4);
        assert_eq!(data_type_size("LREAL"), 8);
    }
}
