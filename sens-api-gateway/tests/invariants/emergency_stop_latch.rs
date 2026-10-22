#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-9.7 / DEC-13.6 — the emergency stop is a device-wide state of
//! the output layer (EDGE-HIGH-057, EDGE-HIGH-067).
//!
//! * It lives in the control gate every hardware handle carries, and the HMI
//!   server keeps no stop state of its own: the old flag was checked only by the
//!   HMI write path and cleared on every restart.
//! * The gate asks the latch before anything else.
//! * The agent restores a persisted stop before the hardware is initialised.
//! * The stop drives the outputs' safe values (never a literal zero, which
//!   switches off an aerator) through the output layer.
//! * The latch is cleared by the authenticated reset only.
//!
//! The scan reads the source the release build compiles.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::{functions, scan_src};

fn code_of(rel: &str) -> String {
    scan_src()
        .into_iter()
        .find(|f| f.rel == rel)
        .unwrap_or_else(|| panic!("{rel} is scanned"))
        .code
}

#[test]
fn the_display_keeps_no_emergency_state_of_its_own() {
    let code = code_of("src/scada_server.rs");
    for needle in [
        "emergency_active:",
        "emergency_active.load",
        "emergency_active.store",
        "emergency_tags",
    ] {
        assert!(
            !code.contains(needle),
            "scada_server.rs holds `{needle}`: the stop is the output layer's latch \
             (`crate::emergency`), not a flag of the display"
        );
    }
    assert!(
        code.contains("dyn crate::emergency::EmergencyControl"),
        "the display must reach the stop through EmergencyControl"
    );
}

#[test]
fn the_gate_asks_the_latch_before_it_asks_anything_else() {
    let code = code_of("src/degraded.rs");
    let fns = functions(&code);
    let permit = fns["permit"]
        .iter()
        .find(|b| b.contains("is_latched"))
        .expect("ControlGate::permit consults the emergency latch");
    let latch = permit.find("emergency.is_latched()").unwrap();
    let degraded = permit.find("control_disabled").unwrap();
    assert!(latch < degraded, "the latch is asked first");
}

#[test]
fn a_pending_stop_is_restored_before_the_hardware_is_initialised() {
    let code = code_of("src/main.rs");
    let attach = code
        .find(".attach_store(")
        .expect("main.rs attaches the emergency store");
    let hardware = code
        .find("init_hardware(&state)")
        .expect("run_agent initialises the hardware");
    assert!(
        attach < hardware,
        "the emergency-stop record must be restored before any hardware is initialised"
    );
    assert_eq!(
        code.matches(".attach_store(").count(),
        1,
        "one store, attached once, at boot"
    );
}

#[test]
fn the_stop_drives_safe_values_through_the_output_layer_not_zeros() {
    let code = code_of("src/scada_server.rs");
    let fns = functions(&code);
    for body in &fns["execute_emergency_stop"] {
        assert!(
            body.contains("emergency.stop("),
            "the HMI stop must go through EmergencyControl::stop"
        );
        assert!(
            !body.contains("value: 0.0") && !body.contains("ScadaCommand"),
            "the HMI stop must not write a literal zero to tags itself (it would de-energise \
             a life-support output)"
        );
    }
    let emergency = code_of("src/emergency.rs");
    assert!(
        emergency.contains("Event::EmergencyStop"),
        "the stop runs the behaviour table's EmergencyStop pass"
    );
}

#[test]
fn only_the_authenticated_reset_clears_the_latch() {
    for file in scan_src() {
        if file.rel == "src/emergency.rs" {
            continue;
        }
        for needle in ["emergency().clear(", "latch.clear("] {
            assert!(
                file.code_lines_with(needle).is_empty(),
                "{} clears the emergency latch (`{needle}`): only EmergencyControl::reset may, \
                 and the display reaches it only after a PIN (or an explicit package opt-out)",
                file.rel
            );
        }
    }
    let code = code_of("src/scada_server.rs");
    let fns = functions(&code);
    for (name, bodies) in &fns {
        if name == "do_emergency_reset" || name == "handle_emergency_reset" {
            continue;
        }
        for body in bodies {
            assert!(
                !body.contains("do_emergency_reset("),
                "{name} resets the emergency stop; only handle_emergency_reset (after \
                 authentication) may"
            );
        }
    }
    // The decision is one pure function (table-tested in src/scada_server.rs,
    // and driven through the real handler there): the handler asks it, and it
    // is the place the PIN is verified and the opt-out and the lockout count.
    let reset = &fns["handle_emergency_reset"][0];
    assert!(
        reset.contains("decide_reset(") && reset.contains("reset_requires_pin"),
        "the reset must be decided by decide_reset from the PIN or the package's explicit opt-out"
    );
    let decide = &fns["decide_reset"][0];
    assert!(
        decide.contains("verify_pin(") && decide.contains("locked_out"),
        "decide_reset must verify the PIN and honour the lockout"
    );
    assert_eq!(
        reset.matches("do_emergency_reset(").count(),
        2,
        "the reset is cleared on exactly two outcomes of the decision: a verified PIN and the \
         package's opt-out"
    );
}
