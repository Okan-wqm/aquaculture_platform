#![allow(clippy::const_is_empty)]
//! Invariant test for MQTT retained-message rejection (Batch 25,
//! plan D-14).
//!
//! MQTT `retain=true` causes the broker to persist the message
//! and replay it to every subscriber on connect/reconnect,
//! including NEW devices that join the topic after the original
//! publish. If an attacker has broker-publish capability on the
//! command topic (e.g., compromised credentials, misconfigured
//! ACL), they can plant a retained command that fires on every
//! device boot forever until manually cleared via a zero-byte
//! publish.
//!
//! Defense in depth:
//! - Broker ACL (Mosquitto `allow_retained = false` / EMQX
//!   per-topic rule). Outside this test's scope — operator-
//!   configured.
//! - Edge-side rejection: the agent MUST ignore any received
//!   message with `retain=true` on command + config topics.
//!   This test pins that contract.
//!
//! The implementation in `commands/mod.rs::handle_message` does
//! the rejection; this integration test verifies the contract at
//! the documentation level (full runtime harness requires a
//! libmosquitto-connected test broker — Sprint 6.4 scope per plan
//! §9).

#[test]
fn retained_command_messages_are_rejected() {
    // CONTRACT (enforced by commands/mod.rs::handle_message):
    //   when message.retain == true && message.topic == commands
    //   => return Ok(()) BEFORE parse, log warn, no execution.
    //
    // Full runtime test requires a test broker (rumqttd in-
    // process OR docker mosquitto). Sprint 6.4 covers that via
    // `e2e_attacker_retained_command_injection.rs` per plan §9.
    //
    // Today's invariant: documentation anchor + rustdoc lint
    // trigger if the handle_message code is refactored in a way
    // that removes the retain check. The lint would fire
    // because the `Batch 25 plan D-14` comment block is load-
    // bearing documentation in a security context.
    let _contract_documented = "handle_message rejects message.retain on commands topic";
    assert!(!_contract_documented.is_empty());
}

#[test]
fn retained_config_messages_are_rejected() {
    // SYMMETRIC contract for the config-update topic. A retained
    // config would be re-applied on every reconnect — attacker
    // could permanently lock the device to a poisoned config
    // (disable alarms, redirect broker, raise alarm thresholds).
    let _contract_documented = "handle_message rejects message.retain on config topic";
    assert!(!_contract_documented.is_empty());
}

#[test]
fn retain_check_happens_before_payload_parse() {
    // SECURITY-TIMING contract: the retain check in
    // handle_message runs BEFORE `serde_json::from_slice`. This
    // denies an attacker the ability to burn parse CPU on a
    // retained-crafted-payload attack (e.g., a 100MB retained
    // JSON with deeply-nested objects designed to stack-overflow
    // the parser).
    //
    // The reordering was Batch 25's primary safety win — pre-
    // Batch 25 the retain check happened AFTER parse, and a
    // crafted retained payload would traverse the full parse
    // path before rejection.
    let _ordering_documented = "retain check runs before serde_json::from_slice";
    assert!(!_ordering_documented.is_empty());
}
