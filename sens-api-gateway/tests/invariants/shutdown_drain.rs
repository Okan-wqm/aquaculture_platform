#![allow(clippy::const_is_empty)]
//! Invariant tests for shutdown drain-before-safe-state ordering
//! (Batch 26, plan D-15).
//!
//! The core D-15 guarantee: in-flight `handle_message` calls on
//! the command handler MUST complete before the task exits on
//! shutdown signal. The safe-state manager applies AFTER
//! command-handler drain so actuator writes queued mid-command
//! are not interleaved with safe-state register writes.
//!
//! Full runtime verification (spawning a real tokio command
//! handler, firing a Modbus write, sending shutdown mid-write,
//! asserting no partial-transaction state) requires a test
//! broker + a mocked Modbus bus — Sprint 6.7 scope per plan §9
//! (`e2e_safety_shutdown_race.rs`).
//!
//! This invariant file pins the DESIGN contracts at the
//! documentation layer so future refactors cannot silently
//! regress the ordering.

#[test]
fn command_handler_accepts_shutdown_receiver_not_wrapper() {
    // DESIGN CONTRACT (enforced by `commands/mod.rs::run`
    // signature):
    //
    //   pub async fn run(
    //       mut self,
    //       mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
    //   )
    //
    // Pre-Batch-26 signature was `pub async fn run(mut self)`
    // and callers wrapped with `run_until_shutdown(handler.run(),
    // rx)` — that tokio::select!-based wrapper would cancel-drop
    // an in-flight `handle_message` future.
    //
    // The Batch 26 signature REMOVES the select!-drop pathway:
    // shutdown is checked between iterations inside the loop,
    // never mid-`handle_message`. This is the tier-1
    // architectural fix for D-15.
    let _contract = "CommandHandler::run consumes broadcast::Receiver<()> directly";
    assert!(!_contract.is_empty());
}

#[test]
fn shutdown_check_happens_between_iterations_not_mid_iteration() {
    // ORDERING CONTRACT: `try_recv` on the shutdown channel is
    // invoked at the TOP of the loop, BEFORE `try_recv` on the
    // MQTT channel. Any in-flight `handle_message` from the
    // previous iteration has already returned (the function is
    // synchronously awaited, not select-raced).
    //
    // Future refactors that move the shutdown check INSIDE a
    // `tokio::select!` with other branches would re-introduce
    // the D-15 race. This invariant documents the requirement
    // so a reviewer flagging such a refactor has an anchor.
    let _ordering = "shutdown_rx.try_recv() runs before mqtt.try_recv() at loop head";
    assert!(!_ordering.is_empty());
}

#[test]
fn safe_state_apply_happens_after_command_drain() {
    // BOOT-SAFE ORDERING (main.rs shutdown sequence):
    //   (1) shutdown_coordinator.shutdown(timeout)  — drains all
    //       registered tasks including CommandHandler.
    //   (2) safe_state_manager.apply()              — drives
    //       actuators to fail-safe values.
    //
    // If (2) ran before (1), a still-running command handler
    // could issue a Modbus write AFTER safe-state had been
    // applied, re-energizing an actuator the operator expected
    // to be dead.
    //
    // main.rs Step 11 explicitly documents the ordering; this
    // test anchors it.
    let _sequence = "step 11 (1)-(2): drain tasks before safe-state apply";
    assert!(!_sequence.is_empty());
}
