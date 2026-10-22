#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-13.3 — the safe-state passes run from the behaviour table over
//! the live configuration, and the commander-loss supervisor is wired.
//!
//! * **No snapshot** (EDGE-HIGH-060). The registry of outputs is built from the
//!   configuration as it is when a pass runs. `SafeStateManager` has no public
//!   constructor and `main.rs` cannot name it, so the old shape (a registry
//!   built once at boot and applied again at shutdown, blind to a device
//!   provisioned or an output a reload granted in between) cannot be written
//!   again without changing this module.
//! * **The table decides.** Boot and shutdown run `apply_event` with the events
//!   the table names for them; they do not carry their own opinion.
//! * **A remote command is a hold** (EDGE-HIGH-065). Every handler that
//!   executes an actuator write on behalf of a remote command records the
//!   output, and the supervisor that drives those outputs safe when the cloud
//!   link has been down for the hold is spawned and registered for shutdown.
//!
//! The scan reads the source the release build compiles.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::{functions, scan_src};

fn scanned(rel: &str) -> source_scan_support::Scanned {
    scan_src()
        .into_iter()
        .find(|f| f.rel == rel)
        .unwrap_or_else(|| panic!("{rel} is scanned"))
}

fn code_of(rel: &str) -> String {
    scanned(rel).code
}

#[test]
fn the_registry_cannot_be_built_or_held_outside_the_safe_state_module() {
    let code = code_of("src/safe_state.rs");
    assert!(
        code.contains("\nstruct SafeStateManager"),
        "`SafeStateManager` must stay private to src/safe_state.rs: a public registry is a \
         registry somebody keeps (EDGE-HIGH-060)"
    );
    assert!(
        !code.contains("pub struct SafeStateManager") && !code.contains("pub fn from_config"),
        "the registry's constructor must stay private"
    );
    for file in scan_src() {
        if file.rel == "src/safe_state.rs" {
            continue;
        }
        assert!(
            file.code_lines_with("SafeStateManager").is_empty(),
            "{} names SafeStateManager: passes go through safe_state::apply_event / \
             apply_leased, which build the registry from the live configuration",
            file.rel
        );
    }
}

#[test]
fn boot_and_shutdown_run_the_events_the_table_names_over_the_live_config() {
    let main = code_of("src/main.rs");
    let boot = main
        .find("Event::AgentStart")
        .expect("main.rs runs the boot pass as Event::AgentStart");
    let stop = main
        .find("behaviour::GRACEFUL_STOP")
        .expect("main.rs runs the shutdown pass as behaviour::GRACEFUL_STOP");
    assert!(boot < stop, "the boot pass comes before the shutdown pass");
    assert_eq!(
        main.matches("safe_state::apply_event(").count(),
        2,
        "exactly the boot pass and the shutdown pass"
    );
    // Both read `state_guard.config`: the configuration now, not a copy kept
    // from boot.
    for at in [boot, stop] {
        let from = main[..at].rfind("apply_event(").expect("call site");
        let call = &main[from..at];
        assert!(
            call.contains("&state_guard.config"),
            "a safe-state pass must take the live configuration: {call}"
        );
    }
}

/// The remote actuator writers record the output they wrote.
#[test]
fn every_remote_actuator_write_records_its_output_as_a_hold() {
    // (file, function) of every handler that writes an actuator on behalf of a
    // command from the cloud.
    let writers = [
        ("src/commands/write.rs", "cmd_write_modbus"),
        ("src/commands/write.rs", "cmd_write_gpio"),
        ("src/commands/io_config.rs", "cmd_set_output"),
    ];
    for (file, name) in writers {
        let fns = functions(&code_of(file));
        let bodies = fns
            .get(name)
            .unwrap_or_else(|| panic!("{file} no longer defines {name}"));
        assert!(
            bodies
                .iter()
                .any(|b| b.contains("hold_remote(") || b.contains("remote_holds.record(")),
            "{file}::{name} writes an actuator for a remote command without recording the \
             output as a remote hold: it would stay as commanded when the cloud goes away \
             (EDGE-HIGH-065)"
        );
    }
}

#[test]
fn the_comms_loss_supervisor_is_spawned_and_registered_for_shutdown() {
    let main = scanned("src/main.rs");
    assert!(
        main.code.contains("comms_loss::run_supervisor("),
        "main.rs no longer spawns the comms-loss supervisor"
    );
    // The scan blanks string contents: the task name is a literal of its own.
    assert!(
        main.literals
            .iter()
            .any(|l| l.text == "comms_loss_supervisor")
            && main.code.contains("register_task("),
        "the comms-loss supervisor must be registered with the shutdown coordinator: an \
         orphaned task could drive an output after the shutdown safe-state"
    );
}

/// The supervisor never reads a wall clock (DEC-7): a monotonic hold only.
#[test]
fn the_supervisor_reads_no_wall_clock() {
    let code = code_of("src/safe_state/comms_loss.rs");
    for needle in ["SystemTime", "Utc::now", "chrono::", "Local::now"] {
        assert!(
            code.code_lines_with_str(needle).is_empty(),
            "comms_loss.rs reads the wall clock ({needle}): the hold is a monotonic duration"
        );
    }
}

trait CodeLines {
    fn code_lines_with_str(&self, needle: &str) -> Vec<usize>;
}

impl CodeLines for String {
    fn code_lines_with_str(&self, needle: &str) -> Vec<usize> {
        self.lines()
            .enumerate()
            .filter(|(_, l)| l.contains(needle))
            .map(|(i, _)| i + 1)
            .collect()
    }
}
