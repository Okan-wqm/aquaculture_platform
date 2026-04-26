//! IEC 61131-3 Program definition + persisted state.
//!
//! ## Why this module exists (Batch #296 ULTRA-HIGH-013 closure)
//!
//! Pre-Batch-#296 these types lived inline in `commands/mod.rs`,
//! contributing ~55 lines to a 1279-line file that violated the
//! ULTRA-HIGH-013 ≤500-line ceiling. They were originally added
//! in v2.1 (cloud-pushed program deploy) but have since accreted
//! enough surface area (FBs, scripts, scan cycle, replace-existing
//! flag, persistence shape) to warrant their own home.
//!
//! ## Visibility / SSoT
//!
//! `ProgramDefinition` is the canonical wire shape for program
//! deploy commands; consumed by `commands::program::cmd_deploy_program`
//! + `commands::deploy_bytecode_program`. `ProgramState` is the
//! persisted equivalent (deployed program + previous version for
//! rollback). Both are `pub` because callers across the
//! `commands::` sub-module tree construct them directly.
//!
//! ## Wire status (Batch #296)
//!
//! Pure data definitions — no behavior. The pre-Batch-#296
//! callers continue to compile unchanged via the `use
//! commands::{ProgramDefinition, ProgramState}` re-export at the
//! `mod.rs` level (`pub use program_def::*`).

use serde::{Deserialize, Serialize};

use crate::scripting::{ExecutionMode, FBDefinition, ScriptDefinition};

/// IEC 61131-3 Program definition received from cloud.
/// Contains everything needed to run a program on the edge device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramDefinition {
    /// Unique program ID.
    pub id: String,
    /// Program name.
    pub name: String,
    /// Program version.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Description.
    #[serde(default)]
    pub description: String,
    /// Execution mode.
    #[serde(default)]
    pub execution_mode: ExecutionMode,
    /// Scan cycle time in milliseconds (for ScanCycle mode).
    #[serde(default = "default_scan_cycle")]
    pub scan_cycle_ms: u64,
    /// Function block definitions.
    #[serde(default)]
    pub function_blocks: Vec<FBDefinition>,
    /// Script definition (triggers, conditions, actions).
    pub script: ScriptDefinition,
    /// Whether to replace existing program with same ID.
    #[serde(default)]
    pub replace_existing: bool,
}

pub(crate) fn default_version() -> u32 {
    1
}

pub(crate) fn default_scan_cycle() -> u64 {
    100 // 100ms default
}

/// Persisted program state (for reload after restart).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProgramState {
    /// Currently deployed program.
    pub program: Option<ProgramDefinition>,
    /// Deployment timestamp.
    pub deployed_at: Option<String>,
    /// Previous version (for rollback).
    pub previous_version: Option<Box<ProgramDefinition>>,
}
