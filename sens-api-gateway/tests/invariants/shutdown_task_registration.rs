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
