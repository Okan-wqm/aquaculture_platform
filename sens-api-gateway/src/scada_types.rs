//! Shared SCADA types and package format for the embedded HMI/kiosk display.
//!
//! This module defines the wire format for SCADA screen packages, WebSocket
//! messages (server-to-client and client-to-server), alarm rules, control
//! permissions, and trend configuration.
//!
//! Types that already exist in `process_image` (TagQuality, TagValue, TagConfig,
//! ProtocolConfig, IoType, TagSource) are NOT duplicated here.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// SCADA Package (top-level)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScadaPackage {
    pub meta: PackageMeta,
    pub screens: Vec<Screen>,
    #[serde(default)]
    pub alarm_rules: Vec<AlarmRule>,
    #[serde(default)]
    pub control_permissions: ControlPermissions,
    #[serde(default)]
    pub trend_config: TrendConfig,
}

// ---------------------------------------------------------------------------
// PackageMeta
// ---------------------------------------------------------------------------

fn default_package_version() -> String {
    "1.0.0".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageMeta {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_package_version")]
    pub package_version: String,
    #[serde(default)]
    pub deployed_by: Option<String>,
    #[serde(default)]
    pub deployed_at: Option<String>,
    #[serde(default)]
    pub edge_device_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Screen & Layout
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub id: String,
    pub name: String,
    pub screen_type: ScreenType,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub layout: Option<GridLayout>,
    #[serde(default)]
    pub widgets: Vec<Widget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenType {
    Dashboard,
    Process,
    Calibration,
    Trends,
    Alarms,
    Control,
    /// Forward-compat (CONTRACT-H-002): a screen type this firmware does
    /// not know renders as a plain dashboard instead of failing the whole
    /// package deserialization (pre-transform artifacts can carry free
    /// strings here).
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    #[serde(rename = "type")]
    pub layout_type: String,
    pub cols: u32,
    pub rows: u32,
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub id: String,
    pub widget_type: WidgetType,
    #[serde(default)]
    pub position: Option<WidgetPosition>,
    #[serde(default)]
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPosition {
    pub col: u32,
    pub row: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WidgetType {
    // Display widgets
    Gauge,
    NumericDisplay,
    StatusIndicator,
    TankLevel,
    TrendChart,
    AlarmBanner,
    AlarmList,
    // Control widgets
    ToggleSwitch,
    Slider,
    NumericInput,
    PushButton,
    EmergencyStop,
    // Calibration widgets
    CalibrationWizard,
    CalibrationHistory,
    CalibrationStatus,
    // Composite widgets
    ProcessView,
    /// Forward-compat (CONTRACT-H-002): any widget type this firmware does
    /// not know deserializes here instead of failing the WHOLE package
    /// (one unknown string used to make the package undeployable). The
    /// deploy handler counts + logs Unknowns; the renderer skips them.
    /// The cloud's publish-boundary transform strips/rejects unsupported
    /// types up front, so this bucket only fills for rollbacks of
    /// pre-transform artifacts or a newer cloud talking to older firmware.
    #[serde(other)]
    Unknown,
}

// ---------------------------------------------------------------------------
// Alarm Rule & Severity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmRule {
    pub id: String,
    pub tag: String,
    pub condition: String,
    pub value: f64,
    pub severity: AlarmSeverity,
    pub message: String,
    #[serde(default)]
    pub deadband: Option<f64>,
    #[serde(default)]
    pub delay: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlarmSeverity {
    Critical,
    High,
    Warning,
    Info,
}

// ---------------------------------------------------------------------------
// Control Permissions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPermissions {
    pub security_levels: SecurityLevels,
    #[serde(default)]
    pub pin_hash: Option<String>,
    #[serde(default)]
    pub pin_timeout: Option<u32>,
    #[serde(default)]
    pub emergency_stop: Option<EmergencyStopConfig>,
}

impl Default for ControlPermissions {
    fn default() -> Self {
        Self {
            security_levels: SecurityLevels::default(),
            pin_hash: None,
            pin_timeout: None,
            emergency_stop: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityLevels {
    #[serde(default)]
    pub none: Vec<String>,
    #[serde(default)]
    pub confirm: Vec<String>,
    #[serde(default)]
    pub pin: Vec<String>,
}

impl Default for SecurityLevels {
    fn default() -> Self {
        Self {
            none: Vec::new(),
            confirm: Vec::new(),
            pin: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyStopConfig {
    pub hold_duration: u32,
    #[serde(default)]
    pub affected_tags: Vec<String>,
    pub reset_requires_pin: bool,
}

// ---------------------------------------------------------------------------
// Trend Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendConfig {
    #[serde(default)]
    pub retention_days: Option<u32>,
    #[serde(default)]
    pub sample_interval_sec: Option<u32>,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl Default for TrendConfig {
    fn default() -> Self {
        Self {
            retention_days: Some(7),
            sample_interval_sec: Some(10),
            tags: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// TagInfo (for allTags message)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub tag_name: String,
    pub value: f64,
    pub quality: String,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub io_type: Option<String>,
    pub timestamp: String,
}

// ---------------------------------------------------------------------------
// ActiveAlarmInfo
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAlarmInfo {
    pub alarm_id: String,
    pub rule_id: String,
    pub tag: String,
    pub severity: String,
    pub message: String,
    pub triggered_at: String,
    pub value: f64,
    pub acked: bool,
}

// ---------------------------------------------------------------------------
// TrendPoint
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub timestamp: i64,
    pub value: f64,
    pub quality: u8,
}

// ---------------------------------------------------------------------------
// WebSocket Messages: Client -> Server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WsClientMessage {
    Command {
        tag: String,
        value: f64,
    },
    Setpoint {
        tag: String,
        value: f64,
    },
    ConfirmResponse {
        request_id: String,
        confirmed: bool,
    },
    PinResponse {
        request_id: String,
        pin: String,
    },
    AlarmAck {
        alarm_id: String,
    },
    Calibrate {
        tag: String,
        action: String,
        #[serde(default)]
        point_index: Option<u32>,
    },
    RequestTrend {
        tag: String,
        from: i64,
        to: i64,
    },
    EmergencyStop,
    EmergencyReset {
        pin: String,
    },
}

// ---------------------------------------------------------------------------
// ScadaCommand (WS -> I/O routing)
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ScadaCommand {
    pub tag: String,
    pub value: f64,
    pub source_ip: Option<String>,
    pub response_tx: tokio::sync::oneshot::Sender<Result<f64, String>>,
}

// ---------------------------------------------------------------------------
// PinSession
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PinSession {
    pub valid_until: chrono::DateTime<chrono::Utc>,
    pub failed_attempts: u32,
    pub lockout_until: Option<chrono::DateTime<chrono::Utc>>,
}

// ---------------------------------------------------------------------------
// Tests — forward-compat widget/screen type tolerance (CONTRACT-H-002)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod widget_type_tolerance_tests {
    use super::*;

    #[test]
    fn unknown_widget_type_deserializes_to_unknown_not_error() {
        let widget: Widget = serde_json::from_value(serde_json::json!({
            "id": "w1",
            "widgetType": "staticText",
            "position": { "col": 0, "row": 0, "w": 1, "h": 1 },
            "config": {}
        }))
        .expect("an unknown widget type must not fail widget deserialization");
        assert!(matches!(widget.widget_type, WidgetType::Unknown));
    }

    #[test]
    fn every_edge_supported_type_parses_without_falling_to_unknown() {
        // camelCase mirror of EDGE_SUPPORTED_WIDGET_TYPES
        // (libs/sensor-contracts/src/scada-package-doc/edge-widget-support.ts).
        // A rename on either side lands here or in the fixture parity test.
        const SUPPORTED: [&str; 16] = [
            "gauge",
            "numericDisplay",
            "statusIndicator",
            "tankLevel",
            "trendChart",
            "alarmBanner",
            "alarmList",
            "toggleSwitch",
            "slider",
            "numericInput",
            "pushButton",
            "emergencyStop",
            "calibrationWizard",
            "calibrationHistory",
            "calibrationStatus",
            "processView",
        ];
        for name in SUPPORTED {
            let widget: Widget = serde_json::from_value(serde_json::json!({
                "id": "w",
                "widgetType": name,
                "config": {}
            }))
            .unwrap_or_else(|e| panic!("{name} must parse as a Widget: {e}"));
            assert!(
                !matches!(widget.widget_type, WidgetType::Unknown),
                "{name} is edge-supported but fell into WidgetType::Unknown"
            );
        }
    }

    #[test]
    fn unknown_screen_type_deserializes_to_unknown_not_error() {
        let screen: Screen = serde_json::from_value(serde_json::json!({
            "id": "s1",
            "name": "Legacy",
            "screenType": "somethingNew",
            "widgets": []
        }))
        .expect("an unknown screen type must not fail screen deserialization");
        assert!(matches!(screen.screen_type, ScreenType::Unknown));
    }
}
