#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-27 — root's results are published by a task that is started where
//! the MQTT client exists.
//!
//! The publisher publishes through the client's sink. The client is created, and
//! stored in `AppState.mqtt_client`, by exactly one place: `run_connectivity`.
//! The publisher used to be started in `run_agent` before that task was spawned,
//! so it found no client, took its "not started" branch on every boot, and root's
//! results (an install's outcome, an update, a rollback, a lockdown) never left
//! the device. `src/main.rs`'s tests spawn it from a state that has a tenant and a
//! client and watch the broker receive the result; this file keeps the call where
//! the client is.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::{functions, scan_src};

fn main_code() -> String {
    scan_src()
        .into_iter()
        .find(|f| f.rel == "src/main.rs")
        .expect("src/main.rs is scanned")
        .code
}

#[test]
fn the_result_publisher_is_started_by_the_task_that_creates_the_client() {
    let code = main_code();
    let fns = functions(&code);

    let callers: Vec<&String> = fns
        .iter()
        .filter(|(name, bodies)| {
            *name != "spawn_result_publisher"
                && bodies.iter().any(|b| b.contains("spawn_result_publisher("))
        })
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        callers,
        ["run_connectivity"],
        "spawn_result_publisher must be called from run_connectivity and nowhere else"
    );

    let body = &fns["run_connectivity"][0];
    let client_stored = body
        .find("mqtt_client = Some(")
        .expect("run_connectivity stores the MQTT client");
    let publisher_spawned = body
        .find("spawn_result_publisher(")
        .expect("run_connectivity starts the result publisher");
    assert!(
        client_stored < publisher_spawned,
        "the result publisher is started after the MQTT client is stored, not before"
    );
}

#[test]
fn run_agent_builds_no_result_publisher_of_its_own() {
    let code = main_code();
    let fns = functions(&code);
    let agent = &fns["run_agent"][0];
    for needle in ["ResultPublisher", "result_sink", "ResultCursor"] {
        assert!(
            !agent.contains(needle),
            "run_agent mentions `{needle}`: it runs before the MQTT client exists"
        );
    }
}
