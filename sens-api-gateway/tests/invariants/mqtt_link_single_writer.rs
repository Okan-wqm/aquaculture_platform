#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-13.3 / EDGE-HIGH-065, EDGE-HIGH-133 — whether the broker is
//! reachable has one writer and one owner.
//!
//! The MQTT event loop is the only thing that knows when the connection dies,
//! and an MQTT 3.1.1 broker never says so: a network loss arrives as an error of
//! the poll, not as a DISCONNECT packet. A flag cleared only on DISCONNECT stays
//! "connected" for the rest of the process, and everything that decides on it
//! (the offline-queue dispatcher, its drain, the comms-loss supervisor) goes
//! blind: publishes go to a dead socket instead of the queue, and a remote
//! command's output is never driven safe.
//!
//! * `link_up` / `link_down` in `src/mqtt.rs` are the only writers of the link
//!   state and of the health gauge that mirrors it.
//! * The event loop calls `link_down` on every way it can lose the connection,
//!   the error arm before anything that waits.
//! * The consumers read the MQTT client's own answer, never the health gauge
//!   (and so need neither the health state nor its listener).
//!
//! The behaviour itself (the link reads down when the socket drops, a publish
//! during the outage is queued and drained, a hold runs out) is exercised
//! against the real event loop in `src/mqtt/link_tests.rs`,
//! `src/safe_state/comms_loss.rs` and `src/main.rs`; this file keeps the
//! structure that makes those tests the whole story.

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

fn body_of(code: &str, name: &str) -> String {
    functions(code)
        .remove(name)
        .unwrap_or_else(|| panic!("fn {name} exists"))
        .into_iter()
        .next()
        .expect("one body")
}

#[test]
fn only_link_up_and_link_down_write_the_link_state() {
    for file in scan_src() {
        // The definitions (and the gauge's own tests) live in these two.
        if file.rel == "src/health.rs" || file.rel == "src/mqtt_acks.rs" {
            continue;
        }
        for writer in ["set_mqtt_connected(", ".on_connected(", ".on_disconnected("] {
            let lines = file.code_lines_with(writer);
            if file.rel == "src/mqtt.rs" {
                continue; // checked below, per function
            }
            assert!(
                lines.is_empty(),
                "{} writes the link state with `{writer}` (line {:?}): only `link_up` / \
                 `link_down` in src/mqtt.rs may",
                file.rel,
                lines
            );
        }
    }

    let code = code_of("src/mqtt.rs");
    let fns = functions(&code);
    for writer in ["set_mqtt_connected(", ".on_connected(", ".on_disconnected("] {
        let owners: Vec<&String> = fns
            .iter()
            .filter(|(_, bodies)| bodies.iter().any(|b| b.contains(writer)))
            .map(|(name, _)| name)
            .collect();
        assert!(
            owners.iter().all(|n| *n == "link_up" || *n == "link_down"),
            "src/mqtt.rs writes the link state with `{writer}` outside link_up/link_down: {owners:?}"
        );
    }
    assert!(body_of(&code, "link_up").contains(".on_connected("));
    assert!(body_of(&code, "link_up").contains("set_mqtt_connected(true)"));
    assert!(body_of(&code, "link_down").contains(".on_disconnected("));
    assert!(body_of(&code, "link_down").contains("set_mqtt_connected(false)"));
}

#[test]
fn the_event_loop_clears_the_link_on_every_way_it_can_lose_the_connection() {
    let code = code_of("src/mqtt.rs");
    let body = body_of(&code, "handle_events");

    // A CONNACK brings it up exactly once.
    assert_eq!(
        body.matches("link_up(").count(),
        1,
        "one link_up, on CONNACK"
    );

    // A DISCONNECT packet, the agent's own disconnect, and the error arm.
    assert_eq!(
        body.matches("link_down(").count(),
        3,
        "link_down on Incoming(Disconnect), Outgoing(Disconnect) and the poll error"
    );
    let disconnect = body
        .split("Packet::Disconnect")
        .nth(1)
        .expect("the DISCONNECT arm");
    assert!(
        disconnect
            .split("Ok(Event::")
            .next()
            .is_some_and(|arm| arm.contains("link_down(")),
        "the DISCONNECT arm clears the link"
    );
    assert!(
        body.split("Outgoing::Disconnect")
            .nth(1)
            .is_some_and(|rest| rest
                .trim_start_matches([' ', '=', '>'])
                .starts_with("link_down(")),
        "the agent's own DISCONNECT clears the link"
    );

    // The error arm: the one a real outage arrives in, before the backoff waits.
    let error_arm = body.split("Err(e) =>").nth(1).expect("the error arm");
    let clears = error_arm
        .find("link_down(")
        .expect("the error arm clears the link");
    let waits = error_arm
        .find("tokio::time::sleep")
        .expect("the error arm backs off");
    assert!(
        clears < waits,
        "the link is cleared before the backoff sleep, not after it"
    );
}

#[test]
fn the_consumers_read_the_clients_link_not_the_health_gauge() {
    // The comms-loss supervisor.
    let supervisor = code_of("src/safe_state/comms_loss.rs");
    let link_is_up = body_of(&supervisor, "link_is_up");
    assert!(link_is_up.contains("mqtt_client"), "{link_is_up}");
    assert!(!link_is_up.contains("health"), "{link_is_up}");

    // The offline-queue dispatcher and its drain: the adapter is the port.
    let publisher = code_of("src/outbound_publisher.rs");
    assert!(
        !publisher.contains("HealthState"),
        "the dispatcher's connectivity port is not implemented by the health state"
    );
    let mqtt = code_of("src/mqtt.rs");
    assert!(
        mqtt.contains("BrokerConnectivity for MqttPublishAdapter"),
        "the publish adapter is the dispatcher's connectivity port"
    );
    let main = code_of("src/main.rs");
    let init = body_of(&main, "init_outbound_publisher");
    assert!(
        !init.contains("health"),
        "the outbound publisher is built without the health state (EDGE-HIGH-133)"
    );

    // Nothing reads the gauge back as a signal.
    for file in scan_src() {
        assert!(
            file.code_lines_with("is_mqtt_connected").is_empty(),
            "{} reads the MQTT health gauge: ask the client",
            file.rel
        );
    }
}
