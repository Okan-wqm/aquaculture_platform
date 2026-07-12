//! Invariant: the always-on control-loop tasks are registered with the
//! ShutdownCoordinator, and the shutdown sequence has a whole-sequence
//! deadline backstop.
//!
//! WHY (EDGE-HIGH-015): `io_poll_loop` (the default-on sensor/actuator
//! poll loop) and the SCADA command executor were spawned orphaned —
//! never signalled or awaited at shutdown — so they kept driving the
//! fieldbus and could execute an HMI actuator write in the window
//! between safe-state apply and hardware disconnect, and pinned
//! Arc<AppState> so it never Dropped. Both are now shutdown-coordinated.
//! Separately, the coordinator bounds each task individually but nothing
//! bounded the full drain→safe-state→flush→disconnect sequence; a
//! detached watchdog force-exits at a hard ceiling below systemd's
//! TimeoutStopSec.
//!
//! WHY grep (Tier-3): driving a real graceful shutdown needs a booted
//! agent + hardware fixtures; a source-read catches the orphan-task
//! regression at negligible cost.

const MAIN_PATH: &str = "src/main.rs";

fn read_main() -> String {
    std::fs::read_to_string(MAIN_PATH).unwrap_or_else(|e| {
        panic!(
            "BUG: shutdown-registration invariant cannot read {} — runs from the \
             sens-api-gateway/ working dir per cargo convention. err={}",
            MAIN_PATH, e
        )
    })
}

/// io_poll and the SCADA command executor MUST be registered with the
/// coordinator (not orphaned).
#[test]
fn control_loops_are_registered_with_shutdown_coordinator() {
    let src = read_main();
    assert!(
        src.contains("register_task(\"io_poll\""),
        "EDGE-HIGH-015 regression: {} no longer registers io_poll with the ShutdownCoordinator \
         — the always-on poll loop would again race safe-state at shutdown.",
        MAIN_PATH
    );
    assert!(
        src.contains("register_task(\"scada_cmd_executor\""),
        "EDGE-HIGH-015 regression: {} no longer registers the SCADA command executor — an HMI \
         write could again overwrite the safe-state value during shutdown.",
        MAIN_PATH
    );
}

/// The orphaned bare spawn of io_poll_loop must not reappear.
#[test]
fn io_poll_is_not_orphaned() {
    let src = read_main();
    assert!(
        !src.contains("tokio::spawn(io_poll::io_poll_loop(state.clone()));"),
        "EDGE-HIGH-015 regression: {} spawns io_poll_loop orphaned (no shutdown receiver, \
         no register_task).",
        MAIN_PATH
    );
}

/// The shutdown sequence must carry a whole-sequence deadline backstop.
#[test]
fn shutdown_has_whole_sequence_deadline() {
    let src = read_main();
    assert!(
        src.contains("hard_deadline_secs") && src.contains("std::process::exit"),
        "EDGE-HIGH-015 regression: {} lost the whole-sequence shutdown deadline watchdog — a \
         wedged shutdown step could exceed systemd TimeoutStopSec and be SIGKILL'd.",
        MAIN_PATH
    );
}

/// PR935-HIGH-003: the deadline watchdog must run on a detached OS thread
/// (immune to runtime starvation) and exit NON-ZERO (fail-visible).
#[test]
fn shutdown_watchdog_is_starvation_proof_and_fail_visible() {
    let src = read_main();
    // The watchdog block must build a named std::thread, not a tokio task —
    // a tokio timer would be starved by the very CPU-bound/blocking wedge it
    // guards against.
    assert!(
        src.contains("\"shutdown-watchdog\"") && src.contains("std::thread::sleep"),
        "PR935-HIGH-003 regression: the shutdown watchdog is no longer a detached OS thread in \
         {} — a tokio-task timer can be starved by a wedged 2-worker runtime and never fire.",
        MAIN_PATH
    );
    // A forced exit that skipped safe-state/flush is a FAILURE — exit(1), never exit(0).
    assert!(
        src.contains("std::process::exit(1)") && !src.contains("std::process::exit(0)"),
        "PR935-HIGH-003 regression: the shutdown watchdog must exit NON-ZERO so systemd \
         Restart=on-failure + the hardware/PLC fail-safe see the forced termination as a failure."
    );
}

/// PR935-HIGH-002: the coordinator's drain must ABORT a timed-out task, not
/// detach it, and must drain concurrently (bounded to one budget).
#[test]
fn shutdown_drain_aborts_and_is_concurrent() {
    let src = std::fs::read_to_string("src/shutdown.rs").unwrap_or_else(|e| {
        panic!("cannot read src/shutdown.rs: {e}");
    });
    // `timeout(_, &mut handle)` + `handle.abort()` on the Err arm: the handle
    // survives the timeout and the wedged task is cancelled before safe-state.
    assert!(
        src.contains("&mut handle") && src.contains("handle.abort()"),
        "PR935-HIGH-002 regression: src/shutdown.rs no longer aborts a timed-out task — moving \
         the handle into timeout() detaches (does not cancel) a wedged actuator write, which can \
         then overwrite the safe-state value."
    );
    // Concurrent drain: all handles awaited together, not in a sequential for-loop.
    assert!(
        src.contains("futures::future::join_all(drains)"),
        "PR935-HIGH-003 regression: src/shutdown.rs no longer drains tasks concurrently — a \
         sequential drain lets a few wedged tasks exceed the whole-sequence deadline before \
         safe-state is reached."
    );
}
