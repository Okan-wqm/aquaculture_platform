//! Edge Scripting Engine
//!
//! Provides a safe DSL for automation scripts on edge devices.
//! Supports:
//! - Condition-based rules (if/then/else)
//! - Time-based triggers (cron-like scheduling)
//! - Threshold-based triggers (sensor values)
//! - Actions (GPIO, Modbus, alerts, logging)
//!
//! v2.0 Features:
//! - Execution limits (time, actions, depth)
//! - Rate limiting per script
//! - Sandboxed execution context

mod actions;
// Batch 148 Faz 3 (plan R-1): ST bytecode IR primitives.
// Compiler (AST → bytecode) + stack VM + gas metering
// land in subsequent batches. `#![allow(dead_code)]`
// inside the module until Batch 149 compiler consumes
// the types.
pub mod bytecode;
// Batch 149 Faz 3 (plan R-1): ST expression compiler
// (AST `Expression` → `Vec<Opcode>`). Statement-level
// compilation + control flow + retain binding land in
// Batches 150+.
pub mod bytecode_compiler;
// Batch 151 Faz 3 (plan R-1): stack-based bytecode VM
// with gas metering. Executes `Bytecode` artifacts
// produced by `bytecode_compiler`. LoadTag / WriteTag
// wiring to `ProcessImage` + `RbacGatedWriter` and
// `StdlibCall` dispatch land in Batches 152+.
pub mod bytecode_vm;
// Batch 158 Faz 3 (plan R-1): signed bytecode artifact
// — canonical binary encoding + ed25519 signature
// wrapper + verify_signed_bytecode function. The
// deploy-command batch consumes this to gate bytecode
// ingestion on signature match.
pub mod bytecode_sig;

// Batch #297 ORPHAN-HIGH-020 closure (D-1b prep): operator-
// signed ST source envelope. Wire shape parallel to
// SignedBytecode but signs source bytes (not bytecode bytes)
// + uses domain tag `st-source-v1` (vs `st-bytecode-v3`) so
// cross-format signature confusion is structurally
// impossible. Edge verifies the source signature, then runs
// parse_st + compile_program internally to produce the
// runnable Bytecode (Batch #298 wire). This is the
// architectural shape that lets operators push raw .st
// source files to the edge without giving the edge a private
// signing key — trust transfer happens via source signature,
// not bytecode signature.
pub mod st_source_sig;

// Enterprise plan Faz 4: deploy-artifact signature envelope for
// cloud→edge SCADA package + process deploys. Same trust anchor
// as bytecode/source signing (firmware_signing_pubkey), new
// per-kind domain tags (`scada-pkg-v1` / `process-v1`) so the
// least-privileged artifact classes get the same integrity
// guarantee as scripts without cross-format confusion.
pub mod deploy_sig;
// Batch 160 Faz 3 (plan R-1): ProcessImage ↔ TagIo
// adapter. `SnapshotTagIo` buffers reads from a scan-
// cycle-start snapshot + collects writes into a pending
// list drained after `ScriptVm::run_with_io`. The
// ScriptEngine Phase 5b batch wires this into the
// actual async ProcessImage boundary.
pub mod process_image_tagio;
// Batch 163 Faz 3 (plan R-1): in-memory registry of
// deployed bytecode programs. Enforces monotonic policy
// version + tenant isolation on insert. Consumed by the
// deploy-command batch + the ScriptEngine scan-cycle
// dispatcher.
pub mod bytecode_registry;
// Batch 164 Faz 3 (plan R-1): scan-cycle orchestrator.
// Composes registry + ProcessImage snapshot + VM
// execution + commit pattern into a single `run_scan_tick`
// entry so the ScriptEngine Phase 5b batch can drive
// it at a configured cadence.
pub mod bytecode_runner;
// Batch 166 Faz 3 (plan R-1): deploy pipeline —
// composes Batch 158 signature verify + Batch 163
// registry insert into a single gate-ordered
// `verify_and_deploy`. The MQTT deploy-command handler
// uses this as its core logic in a future batch.
pub mod bytecode_deploy;
// Batch 168 Faz 3 (plan R-1): SQLCipher persistence
// for the bytecode registry so deployed programs
// survive reboot. Same master-key derivation as
// offline_queue + scripting::persistence.
pub mod bytecode_registry_store;
// Batch 170 Faz 3 (plan R-1): cadence driver that
// spawns the scan-cycle loop. Reads registry + pi
// + declared_types + scan_cycle_ms + shutdown_rx,
// drives `run_scan_tick` at the configured interval
// with overrun detection + structured summary return.
pub mod bytecode_scan_cycle_task;
// Batch 184 Faz 4 (plan R-3 + D-11): multi-task
// scheduler primitives — SloTier / TaskKind /
// TaskConfig / TaskStats. The runtime that dispatches
// tasks according to these configs lands in Batch 185+.
pub mod task_scheduler;

// Batch #302 Faz 4 step 5 closure: per-task scheduler stats
// MQTT publisher loop. Plan §5 Faz 4 step 5 canonical path
// `tenants/{tid}/devices/{did}/task_stats` 30s default
// interval. Spawns alongside run_scheduler_cadence_loop +
// run_event_listener in the multi-task scheduler boot block.
pub mod task_stats_publisher;
// Batch 194 Faz 6 (plan R-9): live-debug force
// registry — per-tag ForceEntry with TTL + rate
// limit + concurrent count cap + persist opt-in.
// Command handlers (Batch 197+) apply security gates
// before calling into this primitive.
pub mod force_registry;
// Batch 201 Faz 6 (plan R-9): SQLCipher persistence
// for persist_across_reboot=true force entries.
// Boot-time rehydrator restores into the in-memory
// registry. Non-persistent forces bypass this store
// entirely + evaporate at shutdown drain.
pub mod force_registry_store;
// Batch 203 Faz 6 (plan R-9 watch_subscribe): live-
// watch session registry. Per-session tag list +
// interval + TTL + next-fire timestamp. Publisher
// task + MQTT command handlers land in batches
// 204-205.
pub mod watch_sessions;
// Batch 206 Faz 6: production MQTT adapter for the
// watch publisher. Implements WatchPublishSink on
// top of MqttClient::publish_raw via AppState.
pub mod watch_publisher_wire;
// Batch 175 Faz 3 (plan R-1): RETAIN variable load/save
// bridge between Bytecode.retain_vars declarations +
// the existing SqlitePersistence variable store.
// Orchestrator wiring (per-tick load/save around
// ScriptVm::run) lands in a future batch.
pub mod bytecode_retain;
// Batch 179 Faz 3: end-to-end integration tests that
// exercise the full deploy→execute→reboot-rehydrate
// pipeline in one pass. Runs only under #[cfg(test)]
// so the production binary is not affected.
#[cfg(test)]
mod bytecode_e2e_tests;
mod conflict;
mod context;
mod engine;
mod fb_registry;
pub mod function_blocks;
mod limits;
pub mod parallel;
mod persistence;
mod storage;
mod triggers;

pub use actions::{Action, ActionResult, ActionType, AlertLevel};
pub use conflict::{ConflictDetector, ConflictResult};
pub use context::ScriptContext;
pub use engine::ScriptEngine;
#[allow(unused_imports)] // FBParams is part of public API, may not be used internally
pub use fb_registry::{FBDefinition, FBParams, FBRegistry, FBRegistryError};
pub use limits::{ExecutionContext, LimitError, ScriptLimits, ScriptRateLimiter};
pub use persistence::{PersistenceError, SqlitePersistence, VariableScope, VariableStore};
#[allow(unused_imports)] // ScriptStatus is part of public API for external consumers
pub use storage::{Script, ScriptStatus, ScriptStorage};
pub use triggers::{Trigger, TriggerManager, TriggerType};

use serde::{Deserialize, Serialize};

/// Script execution mode (v2.1 - IEC 61131-3)
/// Determines how the script engine operates
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ExecutionMode {
    /// Event-driven mode (default): Scripts run when triggers fire
    /// Suitable for simple threshold-based rules
    #[default]
    EventDriven,
    /// Scan cycle mode: PLC-like deterministic execution
    /// All function blocks execute every scan cycle (10-1000ms)
    /// Suitable for complex IEC 61131-3 programs
    ScanCycle,
}

/// Script priority levels (v2.0)
/// Higher values = higher priority = executes first
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ScriptPriority {
    /// Lowest priority (default) - runs last
    Low = 0,
    /// Normal priority
    #[default]
    Normal = 50,
    /// High priority - runs before normal scripts
    High = 100,
    /// Critical priority - runs first, wins conflicts
    Critical = 200,
    /// Emergency priority - absolute highest, for safety scripts
    Emergency = 255,
}

impl ScriptPriority {
    /// Get numeric value for comparison
    pub fn value(&self) -> u8 {
        *self as u8
    }
}

/// Script definition - the DSL structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptDefinition {
    /// Unique script ID
    pub id: String,

    /// Human-readable name
    pub name: String,

    /// Description
    #[serde(default)]
    pub description: String,

    /// Script version
    #[serde(default = "default_version")]
    pub version: String,

    /// Whether script is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Script priority (v2.0) - higher priority scripts execute first
    /// and win in conflict situations
    #[serde(default)]
    pub priority: ScriptPriority,

    /// Trigger conditions
    pub triggers: Vec<Trigger>,

    /// Conditions to check
    #[serde(default)]
    pub conditions: Vec<Condition>,

    /// Actions to execute
    pub actions: Vec<Action>,

    /// Error handling actions
    #[serde(default)]
    pub on_error: Vec<Action>,
}

/// Condition for script execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    /// Condition type
    #[serde(rename = "type")]
    pub condition_type: ConditionType,

    /// Source of value (sensor name, variable, etc.)
    pub source: String,

    /// Comparison operator
    pub operator: ComparisonOperator,

    /// Value to compare against
    pub value: serde_json::Value,
}

/// Condition types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionType {
    /// Sensor/register value
    Sensor,
    /// GPIO pin state
    Gpio,
    /// Variable value
    Variable,
    /// Time-based (hour, minute, day_of_week)
    Time,
    /// System metric (cpu, memory, etc.)
    System,
}

/// Comparison operators
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonOperator {
    Eq,       // ==
    Ne,       // !=
    Gt,       // >
    Gte,      // >=
    Lt,       // <
    Lte,      // <=
    Contains, // string contains
    Between,  // value between [min, max]
    In,       // value in list
}

fn default_version() -> String {
    "1.0".to_string()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_script_definition_parsing() {
        let json = r#"{
            "id": "script-001",
            "name": "High Temperature Alert",
            "description": "Alert when water temp exceeds threshold",
            "triggers": [
                {"type": "threshold", "source": "water_temp", "operator": "gt", "value": 28.0}
            ],
            "conditions": [],
            "actions": [
                {"type": "alert", "level": "warning", "message": "Water temperature high: ${water_temp}°C"}
            ]
        }"#;

        let script: ScriptDefinition = serde_json::from_str(json).unwrap();
        assert_eq!(script.id, "script-001");
        assert_eq!(script.name, "High Temperature Alert");
        assert!(script.enabled);
    }

    #[test]
    fn test_script_priority_parsing() {
        let json = r#"{
            "id": "emergency-shutdown",
            "name": "Emergency Shutdown",
            "priority": "emergency",
            "triggers": [
                {"type": "threshold", "source": "water_temp", "operator": "gt", "value": 35.0}
            ],
            "conditions": [],
            "actions": [
                {"type": "set_gpio", "target": "17", "value": false}
            ]
        }"#;

        let script: ScriptDefinition = serde_json::from_str(json).unwrap();
        assert_eq!(script.priority, ScriptPriority::Emergency);
        assert_eq!(script.priority.value(), 255);
    }

    #[test]
    fn test_script_priority_default() {
        let json = r#"{
            "id": "normal-script",
            "name": "Normal Script",
            "triggers": [],
            "conditions": [],
            "actions": []
        }"#;

        let script: ScriptDefinition = serde_json::from_str(json).unwrap();
        assert_eq!(script.priority, ScriptPriority::Normal);
        assert_eq!(script.priority.value(), 50);
    }

    #[test]
    fn test_priority_ordering() {
        // Higher value = higher priority
        assert!(ScriptPriority::Emergency > ScriptPriority::Critical);
        assert!(ScriptPriority::Critical > ScriptPriority::High);
        assert!(ScriptPriority::High > ScriptPriority::Normal);
        assert!(ScriptPriority::Normal > ScriptPriority::Low);

        // Numeric values
        assert_eq!(ScriptPriority::Low.value(), 0);
        assert_eq!(ScriptPriority::Normal.value(), 50);
        assert_eq!(ScriptPriority::High.value(), 100);
        assert_eq!(ScriptPriority::Critical.value(), 200);
        assert_eq!(ScriptPriority::Emergency.value(), 255);
    }
}
