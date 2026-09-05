//! Scan-cycle cadence driver — Batch 170 Faz 3 (plan R-1).
//!
//! ## WHY
//!
//! Batch 164 built `run_scan_tick` — the single-tick
//! orchestrator that snapshots ProcessImage, runs every
//! enabled bytecode program, and commits results back.
//! Batch 170 now drives that primitive at the configured
//! `scan_cycle_ms` cadence so deployed programs actually
//! execute without manual invocation.
//!
//! The cadence task:
//! - Runs as a spawned tokio task (long-lived async
//!   loop).
//! - Uses `tokio::select!` to interleave the sleep
//!   interval with the shutdown watch channel so it
//!   stops promptly on agent shutdown (no orphaned
//!   scan cycle during teardown).
//! - Logs per-tick outcomes at debug + per-failure
//!   at warn so operators see the scan-cycle
//!   heartbeat + any program halts without having to
//!   instrument elsewhere.
//! - Returns the total tick count when the shutdown
//!   signal fires — makes the loop unit-testable
//!   (drive with a short interval + cancel, assert
//!   tick count > 0).
//!
//! ## Overrun handling
//!
//! If `run_scan_tick` takes longer than `scan_cycle_ms`
//! (complex programs, slow ProcessImage snapshot), the
//! next tick fires immediately without waiting — this
//! matches IEC 61131-3 "best-effort cycle time" semantic
//! for soft-real-time PLCs. The task emits a warn log
//! + an `overrun_count` running total for ops
//! visibility; future batches add a metrics gauge +
//! safe-state trip when overrun exceeds the
//! `max_scan_cycle_ms` config limit.
//!
//! ## Scope boundary
//!
//! The caller (main.rs boot) owns:
//! - Configuring `scan_cycle_ms` from
//!   `config.scripting.default_scan_cycle_ms`.
//! - Building the `declared_types` HashMap from the
//!   tag catalog (ProcessImage + future compiler-side
//!   aggregation).
//! - Spawning this function as a background task via
//!   `tokio::spawn`.
//! - Registering the returned JoinHandle with the
//!   shutdown coordinator so teardown awaits clean
//!   exit.

// Batch #259 wire-audit: D-1 ultra-plan compile/registry
// path is partially orphan (Batch 149-167 primitives wired
// for runtime + scan-cycle, but several stdlib/compile/
// debug helpers wait on the D-1 production wire). Blanket
// allow retained + tracked as ULTRA-HIGH-024; remove
// per-item as the D-1 batch consumes each helper.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, info, warn};

use super::bytecode::StValueType;
use super::bytecode_registry::BytecodeProgramRegistry;
use super::bytecode_runner::{BytecodeRunResult, ScanTickOptions, run_scan_tick};
use crate::process_image::ProcessImage;

/// Summary returned when the scan-cycle loop exits.
/// Operators + tests use these counts to verify the
/// cadence behavior.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScanCycleSummary {
    /// Total scan ticks dispatched (including ones with
    /// zero programs to run).
    pub ticks_executed: u64,
    /// Total program invocations that returned
    /// BytecodeRunResult::Ok across all ticks.
    pub programs_ok: u64,
    /// Total program invocations that returned
    /// BytecodeRunResult::Failed across all ticks.
    pub programs_failed: u64,
    /// Count of ticks whose wall-clock execution
    /// exceeded the configured scan_cycle_ms interval.
    pub overrun_count: u64,
}

/// Long-running cadence driver. Loops until the
/// shutdown watch channel signals `true` or the
/// sender side drops.
///
/// The caller supplies `tick_options` so diagnostic
/// programs can opt into partial-write commits; the
/// default `ScanTickOptions::default()` matches IEC
/// fail-closed semantic.
pub async fn run_scan_cycle_loop(
    registry: Arc<BytecodeProgramRegistry>,
    pi: ProcessImage,
    declared_types: HashMap<String, StValueType>,
    persistence: Option<Arc<super::persistence::SqlitePersistence>>,
    scan_cycle_ms: u64,
    tick_options: ScanTickOptions,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> ScanCycleSummary {
    info!(
        "Bytecode scan-cycle loop starting (scan_cycle_ms={})",
        scan_cycle_ms
    );

    let interval = Duration::from_millis(scan_cycle_ms);
    let mut summary = ScanCycleSummary::default();

    loop {
        let tick_start = std::time::Instant::now();

        // Execute one scan tick.
        let results = run_scan_tick(
            &registry,
            &pi,
            &declared_types,
            persistence.as_deref(),
            &tick_options,
        )
        .await;
        summary.ticks_executed += 1;

        for (program_id, result) in &results {
            match result {
                BytecodeRunResult::Ok { writes_committed } => {
                    summary.programs_ok += 1;
                    debug!(
                        "scan-cycle tick={} program={} ok writes={}",
                        summary.ticks_executed, program_id, writes_committed
                    );
                }
                BytecodeRunResult::Failed { error } => {
                    summary.programs_failed += 1;
                    warn!(
                        "scan-cycle tick={} program={} failed: {}",
                        summary.ticks_executed, program_id, error
                    );
                }
            }
        }

        // Overrun detection — if the tick itself took
        // longer than the configured interval, log +
        // count but still fire the next tick immediately
        // (soft-real-time semantic).
        let elapsed = tick_start.elapsed();
        let sleep_duration = if elapsed >= interval {
            summary.overrun_count += 1;
            warn!(
                "scan-cycle tick={} OVERRUN: elapsed={:?} > interval={:?}",
                summary.ticks_executed, elapsed, interval
            );
            Duration::from_millis(0)
        } else {
            interval - elapsed
        };

        // Interleave sleep + shutdown watch. `select!`
        // picks whichever fires first — sleep completion
        // (next tick) or shutdown signal (exit loop).
        tokio::select! {
            _ = tokio::time::sleep(sleep_duration) => {
                // Next tick.
            }
            changed = shutdown_rx.changed() => {
                match changed {
                    Ok(()) => {
                        if *shutdown_rx.borrow() {
                            info!(
                                "Bytecode scan-cycle loop shutdown signal received, exiting after {} tick(s)",
                                summary.ticks_executed
                            );
                            return summary;
                        }
                        // `changed` fired but value is
                        // still false — continue looping.
                    }
                    Err(_) => {
                        // Sender dropped — treat as
                        // shutdown signal. Normal during
                        // process teardown.
                        info!(
                            "Bytecode scan-cycle shutdown sender dropped, exiting after {} tick(s)",
                            summary.ticks_executed
                        );
                        return summary;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::bytecode::{Bytecode, Opcode, StValue};
    use super::super::bytecode_registry::ProgramEntry;
    use super::*;
    use crate::process_image::{TagQuality, TagSource};
    use chrono::Utc;

    fn mk_entry(program_id: &str, bc: Bytecode) -> ProgramEntry {
        ProgramEntry {
            program_id: program_id.to_string(),
            bytecode: std::sync::Arc::new(bc),
            tenant_id: Some("tenant-a".to_string()),
            policy_version: 1,
            enabled: true,
            deployed_at: Utc::now(),
        }
    }

    fn bc_noop(program_id: &str) -> Bytecode {
        Bytecode {
            program_id: program_id.to_string(),
            program_name: format!("{}-noop", program_id),
            tenant_id: Some("tenant-a".to_string()),
            policy_version: 1,
            max_gas_per_tick: 100,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes: vec![Opcode::Return],
        }
    }

    fn bc_write_setpoint(program_id: &str, value: f64) -> Bytecode {
        Bytecode {
            program_id: program_id.to_string(),
            program_name: format!("{}-writer", program_id),
            tenant_id: Some("tenant-a".to_string()),
            policy_version: 1,
            max_gas_per_tick: 100,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec!["setpoint".to_string()],
            safe_state_pinned_tags: vec![],
            opcodes: vec![
                Opcode::PushConst {
                    value: StValue::Real(value),
                },
                Opcode::WriteTag {
                    name: "setpoint".to_string(),
                },
                Opcode::Return,
            ],
        }
    }

    #[tokio::test]
    async fn scan_cycle_loop_exits_on_shutdown_signal() {
        let registry = Arc::new(BytecodeProgramRegistry::new());
        let pi = ProcessImage::new();
        let (tx, rx) = tokio::sync::watch::channel(false);

        // Spawn the loop with a short interval so tests
        // run fast.
        let registry_clone = registry.clone();
        let pi_clone = pi.clone();
        let handle = tokio::spawn(async move {
            run_scan_cycle_loop(
                registry_clone,
                pi_clone,
                HashMap::new(),
                None,
                10, // 10ms tick
                ScanTickOptions::default(),
                rx,
            )
            .await
        });

        // Let the loop run a few ticks.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Trigger shutdown.
        tx.send(true).expect("send shutdown");

        let summary = handle.await.expect("join ok");
        // Ran at least 1 tick before shutdown.
        assert!(
            summary.ticks_executed >= 1,
            "expected at least 1 tick, got {}",
            summary.ticks_executed
        );
    }

    #[tokio::test]
    async fn scan_cycle_loop_exits_when_sender_drops() {
        let registry = Arc::new(BytecodeProgramRegistry::new());
        let pi = ProcessImage::new();
        let (tx, rx) = tokio::sync::watch::channel(false);

        let registry_clone = registry.clone();
        let pi_clone = pi.clone();
        let handle = tokio::spawn(async move {
            run_scan_cycle_loop(
                registry_clone,
                pi_clone,
                HashMap::new(),
                None,
                10,
                ScanTickOptions::default(),
                rx,
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(30)).await;

        // Drop the sender — loop should exit.
        drop(tx);

        let summary = tokio::time::timeout(Duration::from_secs(1), handle)
            .await
            .expect("no timeout")
            .expect("join ok");
        assert!(summary.ticks_executed >= 1);
    }

    #[tokio::test]
    async fn scan_cycle_loop_counts_successful_programs() {
        let registry = Arc::new(BytecodeProgramRegistry::new());
        let pi = ProcessImage::new();
        pi.update_tag_raw("setpoint", 0.0, TagQuality::Good, TagSource::Modbus)
            .await;

        registry
            .insert(mk_entry("writer1", bc_write_setpoint("writer1", 3.0)))
            .await
            .expect("ok");
        registry
            .insert(mk_entry("noop1", bc_noop("noop1")))
            .await
            .expect("ok");

        let (tx, rx) = tokio::sync::watch::channel(false);
        let registry_clone = registry.clone();
        let pi_clone = pi.clone();
        let handle = tokio::spawn(async move {
            run_scan_cycle_loop(
                registry_clone,
                pi_clone,
                HashMap::new(),
                None,
                10,
                ScanTickOptions::default(),
                rx,
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).expect("send shutdown");

        let summary = handle.await.expect("join ok");
        // Each tick runs 2 programs (writer + noop).
        // Across N ticks: programs_ok = 2*N, programs_failed = 0.
        assert!(summary.ticks_executed >= 1, "expected at least 1 tick");
        assert_eq!(
            summary.programs_ok,
            summary.ticks_executed * 2,
            "each tick runs 2 programs successfully"
        );
        assert_eq!(summary.programs_failed, 0);

        // Verify setpoint was written.
        let sp = pi.get_tag("setpoint").await.expect("exists");
        assert_eq!(sp.value, 3.0);
        assert_eq!(sp.source, TagSource::Script);
    }

    #[tokio::test]
    async fn scan_cycle_loop_counts_failed_programs() {
        let registry = Arc::new(BytecodeProgramRegistry::new());
        let pi = ProcessImage::new();

        // Program that reads a non-existent tag → failed.
        let failing = Bytecode {
            program_id: "fail".into(),
            program_name: "fail".into(),
            tenant_id: Some("tenant-a".into()),
            policy_version: 1,
            max_gas_per_tick: 100,
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
        registry
            .insert(mk_entry("fail", failing))
            .await
            .expect("ok");

        let (tx, rx) = tokio::sync::watch::channel(false);
        let registry_clone = registry.clone();
        let pi_clone = pi.clone();
        let handle = tokio::spawn(async move {
            run_scan_cycle_loop(
                registry_clone,
                pi_clone,
                HashMap::new(),
                None,
                10,
                ScanTickOptions::default(),
                rx,
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(true).expect("send shutdown");

        let summary = handle.await.expect("join ok");
        assert!(summary.programs_failed > 0);
        assert_eq!(summary.programs_ok, 0);
    }

    #[tokio::test]
    async fn scan_cycle_loop_empty_registry_still_ticks() {
        // No programs registered → run_scan_tick returns
        // empty Vec → ticks_executed grows but programs_ok
        // and programs_failed stay at 0.
        let registry = Arc::new(BytecodeProgramRegistry::new());
        let pi = ProcessImage::new();
        let (tx, rx) = tokio::sync::watch::channel(false);

        let registry_clone = registry.clone();
        let pi_clone = pi.clone();
        let handle = tokio::spawn(async move {
            run_scan_cycle_loop(
                registry_clone,
                pi_clone,
                HashMap::new(),
                None,
                10,
                ScanTickOptions::default(),
                rx,
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(true).expect("send shutdown");

        let summary = handle.await.expect("join ok");
        assert!(summary.ticks_executed >= 1);
        assert_eq!(summary.programs_ok, 0);
        assert_eq!(summary.programs_failed, 0);
    }
}
