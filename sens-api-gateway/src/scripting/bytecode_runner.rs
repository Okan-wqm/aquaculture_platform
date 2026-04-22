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

#![allow(dead_code)]

use std::collections::HashMap;

use super::bytecode::StValueType;
use super::bytecode_registry::BytecodeProgramRegistry;
use super::bytecode_vm::{ScriptVm, VmError, VmOutcome};
use super::process_image_tagio::{
    commit_pending_writes, snapshot_process_image, SnapshotTagIo,
};
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
/// Returns a Vec of `(program_id, BytecodeRunResult)` so
/// the engine can decide what to do per program (disable
/// on failure, emit metrics, log, etc).
pub async fn run_scan_tick(
    registry: &BytecodeProgramRegistry,
    pi: &ProcessImage,
    declared_types: &HashMap<String, StValueType>,
    options: &ScanTickOptions,
) -> Vec<(String, BytecodeRunResult)> {
    // Step 1 — one snapshot per tick, shared across all
    // enabled programs. Respects IEC 61131-3 "all
    // programs see the same process image" semantic.
    let snapshot = snapshot_process_image(pi).await;

    // Step 2 — enumerate enabled programs.
    let enabled = registry.list_enabled().await;

    let mut results: Vec<(String, BytecodeRunResult)> =
        Vec::with_capacity(enabled.len());

    for entry in enabled {
        // Fresh SnapshotTagIo per program so pending-
        // writes buffers don't leak across programs.
        // Snapshot + declared_types are cloned — cheap
        // vs the alternative of mutex-shared state.
        let io = SnapshotTagIo::new(snapshot.clone(), declared_types.clone());

        let mut vm = ScriptVm::new(&entry.bytecode);
        let outcome = vm.run_with_io(&entry.bytecode, &io);

        let result = match outcome {
            VmOutcome::Returned => {
                let writes = io.drain_pending_writes();
                let count = writes.len();
                commit_pending_writes(pi, writes).await;
                BytecodeRunResult::Ok {
                    writes_committed: count,
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
    use super::*;
    use super::super::bytecode::{Bytecode, Opcode, StValue};
    use super::super::bytecode_registry::ProgramEntry;
    use chrono::Utc;
    use crate::process_image::{TagQuality, TagSource};

    fn mk_entry(
        program_id: &str,
        bytecode: Bytecode,
        enabled: bool,
    ) -> ProgramEntry {
        ProgramEntry {
            program_id: program_id.to_string(),
            bytecode,
            tenant_id: Some("tenant-a".to_string()),
            policy_version: 1,
            enabled,
            deployed_at: Utc::now(),
        }
    }

    fn bc_loopback(
        tag_name: &str,
        allowed: Vec<String>,
    ) -> Bytecode {
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
                Opcode::LoadTag { name: tag_name.to_string() },
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
            &ScanTickOptions::default(),
        )
        .await;
        assert!(results.is_empty());
        // Setpoint must still be 0 — disabled program did NOT run.
        assert_eq!(
            pi.get_tag("setpoint").await.expect("exists").value,
            0.0
        );
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
        assert!(matches!(
            results[1].1,
            BytecodeRunResult::Failed { .. }
        ));

        // ok_output must have been updated by aa_ok despite
        // zz_fail erroring.
        assert_eq!(
            pi.get_tag("ok_output").await.expect("exists").value,
            7.0
        );
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
            &ScanTickOptions::default(),
        )
        .await;

        assert_eq!(results[0].0, "a_first");
        assert_eq!(results[1].0, "b_last");
        assert_eq!(results[2].0, "m_middle");
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
                Opcode::PushConst { value: StValue::Real(100.0) },
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
            &ScanTickOptions::default(),
        )
        .await;

        // Setpoint reflects A's write.
        assert_eq!(
            pi.get_tag("setpoint").await.expect("exists").value,
            100.0
        );
        // Observed reflects the snapshot (pre-tick) value,
        // not A's in-tick write.
        assert_eq!(
            pi.get_tag("observed").await.expect("exists").value,
            0.0
        );
    }
}
