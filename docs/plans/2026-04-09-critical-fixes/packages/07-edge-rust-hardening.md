# Package 07: edge-rust-hardening

## Metadata
Status: PENDING
Estimated Tokens: 40K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1, no prerequisites among Sprint 1 packages)
Prerequisites: none
Sprint: 1
Closing-Findings: [EDGE-CRITICAL-001, EDGE-CRITICAL-002, EDGE-CRITICAL-003, EDGE-CRITICAL-005]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Four compounding edge agent defects: (1) Clippy lint level is `warn` not `deny`, allowing `unwrap()` calls to reach production -- any malformed sensor payload panics the agent; (2) MQTT connection has no max_packet_size, enabling pre-authentication OOM DoS via oversized PUBLISH; (3) clean_session:true with random client_id loses QoS 1/2 messages on every reconnect (sensor data loss); (4) LoRa crypto path uses `expect()` which panics on every uplink with unexpected MAC commands.

Note: EDGE-CRITICAL-004 (LIFE-SAFETY shutdown) is in its own dedicated Package 01.

## Findings
- **EDGE-CRITICAL-001**: Clippy lint wall uses warn not deny -- unwrap reaches production
  - File: `sens-api-gateway/Cargo.toml` (~7.7K chars)
  - `#![warn(clippy::unwrap_used)]` should be `#![deny(clippy::unwrap_used)]`

- **EDGE-CRITICAL-002**: MQTT MqttOptions missing set_max_packet_size -- pre-auth OOM DoS
  - File: `sens-api-gateway/src/mqtt.rs` (~29.6K chars)
  - No `set_max_packet_size()` call on MqttOptions; broker can send arbitrarily large packets
  - Attacker: send oversized PUBLISH before auth completes, trigger OOM kill

- **EDGE-CRITICAL-003**: clean_session:true default + random client_id -- QoS messages lost on reconnect
  - File: `sens-api-gateway/src/config.rs` (~66.7K chars), `sens-api-gateway/src/mqtt.rs`
  - clean_session:true discards server-side session state; random client_id means server cannot resume
  - Root cause: config defaults not tuned for production reliability

- **EDGE-CRITICAL-005**: expect() in LoRa crypto path -- panics on every uplink
  - Files: `sens-api-gateway/src/lora/crypto.rs` (~15K chars), `sens-api-gateway/src/lora/mac.rs` (~43.7K chars)
  - `expect("valid key")` and similar calls in hot crypto path -- any unexpected MAC command panics

## Affected Files
- `/var/aqua-saas/sens-api-gateway/Cargo.toml` (~7.7K chars)
- `/var/aqua-saas/sens-api-gateway/src/mqtt.rs` (~29.6K chars)
- `/var/aqua-saas/sens-api-gateway/src/config.rs` (~66.7K chars -- large; read MQTT config section only)
- `/var/aqua-saas/sens-api-gateway/src/lora/crypto.rs` (~15K chars)
- `/var/aqua-saas/sens-api-gateway/src/lora/mac.rs` (~43.7K chars)

## Dependencies
None. Independent of backend TypeScript packages.

## Atomic Commit Plan
```
security(edge): harden Rust edge agent -- deny unwrap, MQTT packet limit, persistent session, LoRa error handling

1. Cargo.toml: change clippy::unwrap_used from warn to deny
2. mqtt.rs: add set_max_packet_size(256 * 1024) to MqttOptions
3. config.rs + mqtt.rs: set clean_session:false and use deterministic
   client_id derived from device serial number for session persistence
4. lora/crypto.rs + lora/mac.rs: replace all expect() with proper
   Result<> propagation, returning Err on unexpected MAC commands
   instead of panicking

Closes: docs/reviews/2026-04-09-critical-fixes#EDGE-CRITICAL-001
Closes: docs/reviews/2026-04-09-critical-fixes#EDGE-CRITICAL-002
Closes: docs/reviews/2026-04-09-critical-fixes#EDGE-CRITICAL-003
Closes: docs/reviews/2026-04-09-critical-fixes#EDGE-CRITICAL-005
Plan: docs/plans/2026-04-09-critical-fixes/packages/07-edge-rust-hardening.md
```

## Test Plan
- Lint: `cargo clippy -- -D warnings` must pass (verifies deny level)
- Unit test: MQTT options include max_packet_size assertion
- Unit test: client_id is deterministic given same device serial
- Unit test: LoRa crypto with malformed MAC command returns Err, does not panic
- Unit test: LoRa crypto with valid MAC command succeeds

## Verification Command
```bash
cd /var/aqua-saas/sens-api-gateway && cargo clippy -- -D warnings && cargo test --lib -- --nocapture
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
