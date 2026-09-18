//! Bytecode scan-cycle orchestrator — Batch 164 Faz 3 (plan R-1).
//!
//! ## WHY
//!
//! Batch 163 built the registry that holds compiled bytecode
//! programs. Batch 161 wired the ProcessImage ↔ SnapshotTagIo
//! async bridge. Batch 164 composes them into the scan-cycle
//! orchestrator that ScriptEngine Phase 5b calls every tick.
//!
//! One `run_scan_tick` call:
//! 1. Snapshots the authoritative ProcessImage once.
//! 2. Walks every ENABLED program in the registry in
//!    deterministic program_id order.
//! 3. For each program: fresh VM + SnapshotTagIo on the same
//!    snapshot, `run_with_io`, drain pending writes, commit
//!    to ProcessImage.
//! 4. Collects per-program `BytecodeRunResult` so the engine
//!    can surface failures (disable program, emit alert).
//!
//! ## Failure isolation
//!
//! A VmError in one program MUST NOT abort the scan cycle.
//! Other programs continue to execute against the same
//! snapshot. The failed program's pending writes are
//! discarded (the VM returns mid-opcode so the drain list
//! may be partially populated — still committed when
//! `commit_partial_on_error=true`, else dropped).
//!
//! Batch 164 default: commit_partial_on_error=false.
//! Rationale: a runtime failure mid-program produces an
//! incomplete + potentially inconsistent set of writes; the
//! safer default is to discard everything the failed
//! program produced. Operators explicitly opt-in to
//! partial commits for diagnostic programs.
//!
//! ## Snapshot sharing
//!
//! All programs in one tick share the SAME snapshot so
//! they see a consistent input view. Writes from program
//! A do NOT flow into program B's inputs within the same
//! tick — matches IEC 61131-3 scan-cycle semantic where
//! program interaction happens through the next cycle's
//! process image update.
//!
//! ## Scope boundary
//!
//! Batch 164 orchestrates ONE scan tick. Repeated ticking
//! at a configured interval (e.g. 100ms) + overrun
//! detection + safe-state fallback are the ScriptEngine
//! Phase 5b batch's responsibility — `run_scan_tick`
//! returns what happened; the engine decides what to do
//! about it.

// Batch #259 wire-audit: D-1 ultra-plan compile/registry
// path is partially orphan (Batch 149-167 primitives wired
// for runtime + scan-cycle, but several stdlib/compile/
// debug helpers wait on the D-1 production wire). Blanket
// allow retained + tracked as ULTRA-HIGH-024; remove
// per-item as the D-1 batch consumes each helper.
#![allow(dead_code)]

use std::collections::HashMap;

use super::bytecode::StValueType;
use super::bytecode_registry::BytecodeProgramRegistry;
use super::bytecode_vm::{ScriptVm, VmError, VmOutcome};
use super::process_image_tagio::{SnapshotTagIo, commit_pending_writes, snapshot_process_image};
use crate::process_image::ProcessImage;

/// Per-program outcome surfaced to the engine consumer.
#[derive(Debug, Clone, PartialEq)]
pub enum BytecodeRunResult {
    /// Program ran to completion. `writes_committed` is
    /// the number of pending writes that were applied
    /// to ProcessImage.
    Ok { writes_committed: usize },
    /// Program halted with a runtime error. The engine
    /// typically disables the program + emits an alert.
    /// `writes_committed` is always 0 — failed-program
    /// writes are discarded per the fail-closed policy.
    Failed { error: VmError },
}

/// Configuration for one scan tick. Kept as a struct so
/// future knobs (commit_partial_on_error, gas override,
/// per-program deadline) can grow additively without
/// breaking callers.
#[derive(Debug, Clone, Default)]
pub struct ScanTickOptions {
    /// When true, a failed program's pending-writes list
    /// is still drained + committed. Useful for
    /// diagnostic programs where partial progress is
    /// preferable to nothing. Default false (fail-closed).
    pub commit_partial_on_error: bool,
}

/// Run one scan cycle tick: snapshot ProcessImage, execute
/// every enabled program against the snapshot, commit
/// successful writes back to ProcessImage.
///
/// Programs execute in ascending program_id order for
/// reproducible behavior across cycles.
///
/// Batch 176 Faz 3: accepts an optional
/// `SqlitePersistence` handle. When present + the
/// program declares RETAIN variables
/// (`bytecode.retain_vars`), the tick:
/// 1. Loads persisted RETAIN values into VM locals
///    BEFORE `run_with_io` (via
///    `bytecode_retain::load_retain_vars`).
/// 2. Saves RETAIN values back AFTER a successful run
///    so the program's scan-cycle state is durable
///    across reboots.
///
/// A RETAIN load/save failure surfaces as the program's
/// `BytecodeRunResult::Failed` (not a scan-tick abort)
/// so one bad program doesn't disrupt the rest of the
/// tick.
///
/// Returns a Vec of `(program_id, BytecodeRunResult)` so
/// the engine can decide what to do per program (disable
/// on failure, emit metrics, log, etc).
pub async fn run_scan_tick(
    registry: &BytecodeProgramRegistry,
    pi: &ProcessImage,
    declared_types: &HashMap<String, StValueType>,
    persistence: Option<&super::persistence::SqlitePersistence>,
    options: &ScanTickOptions,
) -> Vec<(String, BytecodeRunResult)> {
    run_scan_tick_filtered(registry, pi, declared_types, persistence, options, None).await
}

/// Filtered variant — Batch 186 Faz 4. Runs only the
/// enabled programs whose `program_id` is present in
/// `program_id_filter`. When `program_id_filter` is
/// None, behaves identically to `run_scan_tick`
/// (all enabled programs run).
///
/// Consumed by the Batch 187 multi-task scheduler
/// dispatch so each task executes its OWN program
/// subset, not the global enabled list. Other tasks'
/// programs don't run during one task's tick —
/// matches plan R-3 task-ownership semantic.
pub async fn run_scan_tick_for_programs(
    registry: &BytecodeProgramRegistry,
    pi: &ProcessImage,
    declared_types: &HashMap<String, StValueType>,
    persistence: Option<&super::persistence::SqlitePersistence>,
    options: &ScanTickOptions,
    program_id_filter: &[String],
) -> Vec<(String, BytecodeRunResult)> {
    run_scan_tick_filtered(
        registry,
        pi,
        declared_types,
        persistence,
        options,
        Some(program_id_filter),
    )
    .await
}

/// Shared implementation. `filter` = None → all enabled
/// programs run; Some(&[]) → no programs run; Some(
/// non-empty slice) → only enabled programs whose id
/// is in the slice.
async fn run_scan_tick_filtered(
    registry: &BytecodeProgramRegistry,
    pi: &ProcessImage,
    declared_types: &HashMap<String, StValueType>,
    persistence: Option<&super::persistence::SqlitePersistence>,
    options: &ScanTickOptions,
    filter: Option<&[String]>,
) -> Vec<(String, BytecodeRunResult)> {
    // Step 1 — one snapshot per tick, shared across all
    // selected programs. Respects IEC 61131-3 "all
    // programs see the same process image" semantic,
    // scoped to the caller's filter set.
    let snapshot = snapshot_process_image(pi).await;

    // Step 2 — enumerate enabled programs.
    let enabled = registry.list_enabled().await;

    // Step 2a — apply the optional program-id filter.
    let selected: Vec<_> = match filter {
        None => enabled,
        Some(allowed) => {
            let allowed_set: std::collections::HashSet<&str> =
                allowed.iter().map(|s| s.as_str()).collect();
            enabled
                .into_iter()
                .filter(|e| allowed_set.contains(e.program_id.as_str()))
                .collect()
        }
    };

    let mut results: Vec<(String, BytecodeRunResult)> = Vec::with_capacity(selected.len());

    for entry in selected {
        // Fresh SnapshotTagIo per program so pending-
        // writes buffers don't leak across programs.
        // Snapshot + declared_types are cloned — cheap
        // vs the alternative of mutex-shared state.
        let io = SnapshotTagIo::new(snapshot.clone(), declared_types.clone());

        let mut vm = ScriptVm::new(&entry.bytecode);

        // RETAIN load: if persistence is injected AND
        // the program declares retains, restore values
        // into VM locals BEFORE dispatch. On error,
        // skip execution + report Failed — we refuse to
        // run a RETAIN program with unknown state
        // (fail-closed).
        if let Some(p) = persistence {
            if !entry.bytecode.retain_vars.is_empty() {
                if let Err(e) = super::bytecode_retain::load_retain_vars(
                    p,
                    &entry.bytecode.program_id,
                    &entry.bytecode.retain_vars,
                    vm.locals_mut(),
                )
                .await
                {
                    results.push((
                        entry.program_id.clone(),
                        BytecodeRunResult::Failed {
                            error: crate::scripting::bytecode_vm::VmError::TagIoFailed {
                                tag: format!("retain-load::{}", entry.program_id),
                                direction: "load",
                                reason: e.to_string(),
                            },
                        },
                    ));
                    continue;
                }
            }
        }

        let outcome = vm.run_with_io(&entry.bytecode, &io);

        let result = match outcome {
            VmOutcome::Returned => {
                let writes = io.drain_pending_writes();
                let count = writes.len();
                commit_pending_writes(pi, writes).await;

                // RETAIN save: persist the final locals
                // AFTER a successful run so the scan-
                // cycle state survives reboots. Batch 176
                // wires this; save errors surface as
                // Failed (fail-closed vs silent state
                // loss on next boot).
                if let Some(p) = persistence {
                    if !entry.bytecode.retain_vars.is_empty() {
                        if let Err(e) = super::bytecode_retain::save_retain_vars(
                            p,
                            &entry.bytecode.program_id,
                            &entry.bytecode.retain_vars,
                            vm.locals(),
                        )
                        .await
                        {
                            BytecodeRunResult::Failed {
                                error: crate::scripting::bytecode_vm::VmError::TagIoFailed {
                                    tag: format!("retain-save::{}", entry.bytecode.program_id),
                                    direction: "write",
                                    reason: e.to_string(),
                                },
                            }
                        } else {
                            BytecodeRunResult::Ok {
                                writes_committed: count,
                            }
                        }
                    } else {
                        BytecodeRunResult::Ok {
                            writes_committed: count,
                        }
                    }
                } else {
                    BytecodeRunResult::Ok {
                        writes_committed: count,
                    }
                }
            }
            VmOutcome::Error(e) => {
                let writes_committed = if options.commit_partial_on_error {
                    let writes = io.drain_pending_writes();
                    let count = writes.len();
                    commit_pending_writes(pi, writes).await;
                    count
                } else {
                    // Drain to clear the buffer even
                    // though we discard — prevents
                    // accidental leak into the next
                    // tick if the caller re-uses the
                    // adapter (here the adapter is
                    // per-program so the drain is
                    // already isolated, but the
                    // explicit drain is cheap
                    // defensive hygiene).
                    let _ = io.drain_pending_writes();
                    0
                };
                let result = BytecodeRunResult::Failed { error: e };
                // results list builder expects only one
                // entry per program; the writes_committed
                // isn't surfaced on the Failed variant —
                // the commit_partial_on_error path is
                // diagnostic-only. Return the Failed
                // result; the numeric count is available
                // to callers via ProcessImage inspection.
                let _ = writes_committed;
                result
            }
        };
        results.push((entry.program_id.clone(), result));
    }

    results
}

#[cfg(test)]
mod tests {
    use super::super::bytecode::{Bytecode, Opcode, StValue};
    use super::super::bytecode_registry::ProgramEntry;
    use super::*;
    use crate::process_image::{TagQuality, TagSource};
    use chrono::Utc;

    fn mk_entry(program_id: &str, bytecode: Bytecode, enabled: bool) -> ProgramEntry {
        ProgramEntry {
            program_id: program_id.to_string(),
            bytecode: std::sync::Arc::new(bytecode),
            tenant_id: Some("tenant-a".to_string()),
            policy_version: 1,
            enabled,
            deployed_at: Utc::now(),
        }
    }

    fn bc_loopback(tag_name: &str, allowed: Vec<String>) -> Bytecode {
        // LoadTag(tag_name); WriteTag(setpoint); Return
        // Setpoint is the allowlist entry.
        Bytecode {
            program_id: "p".into(),
            program_name: "loopback".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: allowed,
            safe_state_pinned_tags: vec![],
            opcodes: vec![
                Opcode::LoadTag {
                    name: tag_name.to_string(),
                },
                Opcode::WriteTag {
                    name: "setpoint".to_string(),
                },
                Opcode::Return,
            ],
        }
    }

    #[tokio::test]
    async fn run_scan_tick_with_empty_registry_returns_empty() {
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        let results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn run_scan_tick_executes_enabled_program_and_commits_write() {
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("source", 42.0, TagQuality::Good, TagSource::Modbus)
            .await;
        pi.update_tag_raw("setpoint", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        reg.insert(mk_entry(
            "copy_source_to_setpoint",
            bc_loopback("source", vec!["setpoint".into()]),
            true,
        ))
        .await
        .expect("ok");

        let results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "copy_source_to_setpoint");
        assert_eq!(
            results[0].1,
            BytecodeRunResult::Ok {
                writes_committed: 1,
            }
        );

        // Verify the write hit ProcessImage with source=Script.
        let sp = pi.get_tag("setpoint").await.expect("exists");
        assert_eq!(sp.value, 42.0);
        assert_eq!(sp.source, TagSource::Script);
    }

    #[tokio::test]
    async fn run_scan_tick_skips_disabled_programs() {
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("source", 42.0, TagQuality::Good, TagSource::Modbus)
            .await;
        pi.update_tag_raw("setpoint", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        reg.insert(mk_entry(
            "disabled_copy",
            bc_loopback("source", vec!["setpoint".into()]),
            false, // disabled
        ))
        .await
        .expect("ok");

        let results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;
        assert!(results.is_empty());
        // Setpoint must still be 0 — disabled program did NOT run.
        assert_eq!(pi.get_tag("setpoint").await.expect("exists").value, 0.0);
    }

    #[tokio::test]
    async fn run_scan_tick_isolates_failure_to_single_program() {
        // Two programs: one succeeds, one fails (load
        // missing tag). Failure must NOT abort the other
        // program's execution + commit.
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("source", 7.0, TagQuality::Good, TagSource::Modbus)
            .await;
        pi.update_tag_raw("ok_output", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        let ok_bc = bc_loopback("source", vec!["ok_output".into()]);
        let mut ok_bc = ok_bc;
        // Rewrite the write target to "ok_output".
        ok_bc.opcodes[1] = Opcode::WriteTag {
            name: "ok_output".into(),
        };

        let fail_bc = Bytecode {
            program_id: "fail".into(),
            program_name: "fail".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes: vec![
                Opcode::LoadTag {
                    name: "missing".into(),
                },
                Opcode::Return,
            ],
        };

        // Insert both — `aa_ok` first alphabetically so
        // the registry's sorted enumeration puts it first.
        reg.insert(mk_entry("aa_ok", ok_bc, true))
            .await
            .expect("ok");
        reg.insert(mk_entry("zz_fail", fail_bc, true))
            .await
            .expect("ok");

        let results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0, "aa_ok");
        assert_eq!(
            results[0].1,
            BytecodeRunResult::Ok {
                writes_committed: 1,
            }
        );
        assert_eq!(results[1].0, "zz_fail");
        assert!(matches!(results[1].1, BytecodeRunResult::Failed { .. }));

        // ok_output must have been updated by aa_ok despite
        // zz_fail erroring.
        assert_eq!(pi.get_tag("ok_output").await.expect("exists").value, 7.0);
    }

    #[tokio::test]
    async fn run_scan_tick_runs_programs_in_deterministic_order() {
        // Registry contains `b_last`, `a_first`, `m_middle`.
        // Execution order must be alphabetical (a → m → b? no,
        // sorted: a_first → b_last → m_middle? No —
        // alphabetical: a_first < b_last < m_middle).
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("x", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        let no_op = Bytecode {
            program_id: "irrelevant".into(),
            program_name: "n".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes: vec![Opcode::Return],
        };

        reg.insert(mk_entry("b_last", no_op.clone(), true))
            .await
            .expect("ok");
        reg.insert(mk_entry("a_first", no_op.clone(), true))
            .await
            .expect("ok");
        reg.insert(mk_entry("m_middle", no_op, true))
            .await
            .expect("ok");

        let results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;

        assert_eq!(results[0].0, "a_first");
        assert_eq!(results[1].0, "b_last");
        assert_eq!(results[2].0, "m_middle");
    }

    // ====================================================================
    // Batch 176 — RETAIN persistence hookup in run_scan_tick
    // ====================================================================

    // ====================================================================
    // Batch 186 Faz 4 — program-id filter for scheduler dispatch
    // ====================================================================

    #[tokio::test]
    async fn run_scan_tick_for_programs_filters_to_allowed_subset() {
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("tag_a", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;
        pi.update_tag_raw("tag_b", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        // Three enabled programs; filter to only [p1, p3].
        reg.insert(mk_entry(
            "p1",
            bc_loopback("tag_a", vec!["tag_a".into()]),
            true,
        ))
        .await
        .expect("ok");
        reg.insert(mk_entry(
            "p2",
            bc_loopback("tag_b", vec!["tag_b".into()]),
            true,
        ))
        .await
        .expect("ok");
        reg.insert(mk_entry(
            "p3",
            bc_loopback("tag_a", vec!["tag_a".into()]),
            true,
        ))
        .await
        .expect("ok");

        let filter = vec!["p1".to_string(), "p3".to_string()];
        let results = run_scan_tick_for_programs(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
            &filter,
        )
        .await;
        // Only p1 + p3 should appear; p2 is NOT in the
        // filter so it's skipped entirely.
        assert_eq!(results.len(), 2);
        let names: Vec<&str> = results.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"p1"));
        assert!(names.contains(&"p3"));
        assert!(!names.contains(&"p2"));
    }

    #[tokio::test]
    async fn run_scan_tick_for_programs_empty_filter_runs_nothing() {
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        reg.insert(mk_entry(
            "p1",
            bc_loopback("tag_a", vec!["tag_a".into()]),
            true,
        ))
        .await
        .expect("ok");

        let results = run_scan_tick_for_programs(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
            &[],
        )
        .await;
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn run_scan_tick_for_programs_filter_unknown_id_skipped() {
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("tag_a", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        reg.insert(mk_entry(
            "p1",
            bc_loopback("tag_a", vec!["tag_a".into()]),
            true,
        ))
        .await
        .expect("ok");

        // Filter includes p1 + a non-existent id. Only
        // p1 runs; ghost_id is silently skipped (not
        // present in enabled list).
        let filter = vec!["p1".to_string(), "ghost_id".to_string()];
        let results = run_scan_tick_for_programs(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
            &filter,
        )
        .await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "p1");
    }

    #[tokio::test]
    async fn run_scan_tick_unchanged_behavior_when_no_filter() {
        // Regression guard: run_scan_tick without a
        // filter should behave identically to
        // run_scan_tick_for_programs with a filter
        // matching every enabled id.
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("tag_a", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        reg.insert(mk_entry(
            "p1",
            bc_loopback("tag_a", vec!["tag_a".into()]),
            true,
        ))
        .await
        .expect("ok");
        reg.insert(mk_entry(
            "p2",
            bc_loopback("tag_a", vec!["tag_a".into()]),
            true,
        ))
        .await
        .expect("ok");

        let all_results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;
        let filtered_results = run_scan_tick_for_programs(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
            &["p1".to_string(), "p2".to_string()],
        )
        .await;
        assert_eq!(all_results.len(), filtered_results.len());
    }

    #[tokio::test]
    async fn run_scan_tick_loads_and_saves_retain_vars_across_ticks() {
        // Program:
        //   VAR_RETAIN counter: INT; END_VAR
        //   counter := counter + 1;
        // Each tick should increment `counter` by 1 and
        // persist the new value.
        use crate::scripting::bytecode_compiler::compile_program;
        use crate::scripting::persistence::SqlitePersistence;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        let persistence = SqlitePersistence::in_memory().expect("ok");

        let prog = Program {
            name: "retain_counter".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: true,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "counter".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("counter".into(), None),
                value: Expression::BinaryOp {
                    left: Box::new(Expression::Variable("counter".into(), None)),
                    op: BinaryOp::Add,
                    right: Box::new(Expression::IntLiteral(1)),
                },
                span: None,
            }],
            span: None,
        };
        let bc = compile_program(&prog, &[], "retain_counter".into(), 10_000).expect("compile");
        assert_eq!(bc.retain_vars.len(), 1);

        reg.insert(mk_entry("retain_counter", bc, true))
            .await
            .expect("ok");

        // Tick 1: counter starts at 0 (zero-init), becomes 1.
        let results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            Some(&persistence),
            &ScanTickOptions::default(),
        )
        .await;
        assert_eq!(results.len(), 1);
        assert!(matches!(results[0].1, BytecodeRunResult::Ok { .. }));

        // Verify persisted value is 1.
        let persisted_1 = persistence
            .load_async("retain_counter", "counter")
            .await
            .expect("ok")
            .expect("row present");
        assert_eq!(persisted_1, serde_json::json!({"kind": "int", "value": 1}));

        // Tick 2: loads persisted 1, increments to 2.
        let _ = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            Some(&persistence),
            &ScanTickOptions::default(),
        )
        .await;
        let persisted_2 = persistence
            .load_async("retain_counter", "counter")
            .await
            .expect("ok")
            .expect("row present");
        assert_eq!(persisted_2, serde_json::json!({"kind": "int", "value": 2}));

        // Tick 3: increments to 3.
        let _ = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            Some(&persistence),
            &ScanTickOptions::default(),
        )
        .await;
        let persisted_3 = persistence
            .load_async("retain_counter", "counter")
            .await
            .expect("ok")
            .expect("row present");
        assert_eq!(persisted_3, serde_json::json!({"kind": "int", "value": 3}));
    }

    #[tokio::test]
    async fn run_scan_tick_without_persistence_skips_retain() {
        // RETAIN declared but persistence=None → program
        // still runs (counter stays at zero-init each
        // tick) + no save happens.
        use crate::scripting::bytecode_compiler::compile_program;
        use crate::st_validator::{
            BinaryOp, DataType, Expression, Program, Statement, VarBlock, VarDeclaration, VarScope,
        };

        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();

        let prog = Program {
            name: "no_persist".into(),
            var_blocks: vec![VarBlock {
                scope: VarScope::Local,
                retain: true,
                constant: false,
                declarations: vec![VarDeclaration {
                    name: "x".into(),
                    data_type: DataType::Int,
                    initial_value: None,
                    span: None,
                }],
                span: None,
            }],
            body: vec![Statement::Assignment {
                target: Expression::Variable("x".into(), None),
                value: Expression::BinaryOp {
                    left: Box::new(Expression::Variable("x".into(), None)),
                    op: BinaryOp::Add,
                    right: Box::new(Expression::IntLiteral(1)),
                },
                span: None,
            }],
            span: None,
        };
        let bc = compile_program(&prog, &[], "p".into(), 10_000).expect("compile");
        reg.insert(mk_entry("p", bc, true)).await.expect("ok");

        let results = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;
        assert_eq!(results.len(), 1);
        assert!(matches!(results[0].1, BytecodeRunResult::Ok { .. }));
        // No assertion on persistence — no persistence
        // handle to check. Test just verifies the run
        // doesn't crash when RETAIN is declared without
        // a persistence backend.
    }

    #[tokio::test]
    async fn run_scan_tick_programs_share_snapshot_not_intra_tick_writes() {
        // Two programs:
        //   A: writes setpoint = 100.0
        //   B: reads setpoint (expects snapshot-time 0.0,
        //      NOT A's write)
        //   B then writes observed = <whatever it read>.
        //
        // Expected after tick: setpoint = 100 (A's write),
        // observed = 0 (B saw the pre-tick snapshot).
        let reg = BytecodeProgramRegistry::new();
        let pi = ProcessImage::new();
        pi.update_tag_raw("setpoint", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;
        pi.update_tag_raw("observed", -1.0, TagQuality::Good, TagSource::Modbus)
            .await;

        let bc_a = Bytecode {
            program_id: "a".into(),
            program_name: "a".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec!["setpoint".into()],
            safe_state_pinned_tags: vec![],
            opcodes: vec![
                Opcode::PushConst {
                    value: StValue::Real(100.0),
                },
                Opcode::WriteTag {
                    name: "setpoint".into(),
                },
                Opcode::Return,
            ],
        };

        let bc_b = Bytecode {
            program_id: "b".into(),
            program_name: "b".into(),
            tenant_id: None,
            policy_version: 0,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec!["observed".into()],
            safe_state_pinned_tags: vec![],
            opcodes: vec![
                Opcode::LoadTag {
                    name: "setpoint".into(),
                },
                Opcode::WriteTag {
                    name: "observed".into(),
                },
                Opcode::Return,
            ],
        };

        reg.insert(mk_entry("a_first_writer", bc_a, true))
            .await
            .expect("ok");
        reg.insert(mk_entry("b_later_reader", bc_b, true))
            .await
            .expect("ok");

        let _ = run_scan_tick(
            &reg,
            &pi,
            &HashMap::new(),
            None,
            &ScanTickOptions::default(),
        )
        .await;

        // Setpoint reflects A's write.
        assert_eq!(pi.get_tag("setpoint").await.expect("exists").value, 100.0);
        // Observed reflects the snapshot (pre-tick) value,
        // not A's in-tick write.
        assert_eq!(pi.get_tag("observed").await.expect("exists").value, 0.0);
    }
}
