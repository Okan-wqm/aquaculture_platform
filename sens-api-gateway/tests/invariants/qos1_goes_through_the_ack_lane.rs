#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-27 — the broker's acknowledgement of a result is attributed to
//! that result, exactly.
//!
//! rumqttc 0.25 gives a publisher no token for a publish, so `mqtt_acks` makes
//! the attribution exact by construction: every QoS 1 request goes into the
//! client's channel through the tracker's lane (`AckTracker::enqueue`), which
//! counts it, and the event loop feeds the tracker the packet identifiers it
//! assigns and the acknowledgements the broker sends. The attribution holds only
//! while NO QoS 1 request reaches the channel by another way: a request that
//! skips the lane is not counted, the next result's identifier is then taken
//! from the wrong event, and the result publisher would record a result as
//! acknowledged on another publish's acknowledgement. This scan keeps the lane
//! the only way in.
//!
//! The scan reads the source the release build compiles.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::scan_src;

fn code_of(rel: &str) -> String {
    scan_src()
        .into_iter()
        .find(|f| f.rel == rel)
        .unwrap_or_else(|| panic!("{rel} is scanned"))
        .code
}

/// The text of the call whose `(` is at `open`, up to its matching `)`.
fn call_text(code: &str, open: usize) -> &str {
    let mut depth = 0usize;
    for (i, b) in code.bytes().enumerate().skip(open) {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return &code[open..=i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced parentheses after byte {open}");
}

/// Every `.publish(` of the MQTT client either runs inside the lane
/// (`.enqueue(` in its statement) or is QoS 0, which has no packet identifier.
#[test]
fn every_qos1_publish_of_the_client_goes_through_the_lane() {
    let code = code_of("src/mqtt.rs");
    let mut checked = 0;
    let mut from = 0;
    while let Some(pos) = code[from..].find(".publish(") {
        let at = from + pos;
        from = at + ".publish(".len();
        let statement_start = code[..at].rfind([';', '{', '}']).map_or(0, |i| i + 1);
        let statement = &code[statement_start..at];
        let call = call_text(&code, at + ".publish".len());
        let in_lane = statement.contains(".enqueue(");
        let qos0 = call.contains("AtMostOnce");
        assert!(
            in_lane || qos0,
            "src/mqtt.rs publishes at QoS 1 outside the ack lane: `{}{}`. A request that skips \
             AckTracker::enqueue is not counted, and the result publisher would attribute the \
             broker's acknowledgement to the wrong publish (ADR-048 DEC-27).",
            statement.trim(),
            call
        );
        checked += 1;
    }
    assert!(
        checked >= 8,
        "the scan found only {checked} publishes in src/mqtt.rs"
    );
}

/// No other file puts a QoS 1 request into the client's channel.
#[test]
fn only_the_mqtt_module_and_the_tracker_touch_the_client_s_publish() {
    for file in scan_src() {
        if matches!(file.rel.as_str(), "src/mqtt.rs" | "src/mqtt_acks.rs") {
            continue;
        }
        for needle in ["AtLeastOnce", "ExactlyOnce", "AsyncClient"] {
            assert!(
                file.code_lines_with(needle).is_empty(),
                "{} names `{needle}`: QoS 1 publishes go through src/mqtt.rs, whose lane is what \
                 lets the result publisher tell whose acknowledgement it received",
                file.rel
            );
        }
    }
}

/// The event loop is what tells the tracker about identifiers and acknowledgements.
#[test]
fn the_event_loop_feeds_the_tracker_the_broker_s_side() {
    let code = code_of("src/mqtt.rs");
    for fed in [
        "acks.on_outgoing_publish(",
        "acks.on_puback(",
        "acks.on_connected(",
        "acks.on_disconnected(",
    ] {
        assert!(
            code.contains(fed),
            "the MQTT event loop no longer calls `{fed}`: the tracker would never learn which \
             identifier a publish got, or that the broker acknowledged it"
        );
    }
}
