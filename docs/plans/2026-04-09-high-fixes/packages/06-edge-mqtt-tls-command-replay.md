# Package 06: edge-mqtt-tls-command-replay

## Metadata
Status: PENDING
Estimated Tokens: 30K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [EDGE-HIGH-001, EDGE-HIGH-002]
Source-Reviews:
  - docs/reviews/edge-expert/2026-04-05-s2-high-findings.md

## Context
Two IEC 62443 violations in the Rust edge agent: (1) verify_hostname config field is silently ignored -- dead config that creates false audit assurance, and (2) no command replay protection -- MQTT QoS 1 redelivery, retained messages, and agent restarts can re-execute safety-critical commands (write_modbus, plc_start, reboot, update_firmware).

## Findings

**EDGE-HIGH-001** (edge-expert, HIGH)
File: sens-api-gateway/src/mqtt.rs (lines 654-733)
File: sens-api-gateway/src/config.rs (line 241)
verify_hostname config field is declared and documented but never read by configure_tls(). Creates false audit trail (auditor assumes hostname verification is configurable) and operator confusion (setting verify_hostname: false has no effect, leading operators to disable TLS entirely). IEC 62443 FR-4/FR-1.

**EDGE-HIGH-002** (edge-expert, HIGH)
File: sens-api-gateway/src/commands.rs (lines 294-324)
File: sens-api-gateway/src/offline_queue.rs
No command_id deduplication. MQTT QoS 1 redelivery re-executes safety-critical commands (write_modbus, plc_start, reboot). No timestamp window rejection. No persistent dedup across restarts. Retained messages re-execute on every reconnect. IEC 62443 FR-2/FR-6.

## Affected Files
- sens-api-gateway/src/mqtt.rs
- sens-api-gateway/src/config.rs
- sens-api-gateway/src/commands.rs
- sens-api-gateway/src/offline_queue.rs

## Dependencies
None. Rust edge agent is a standalone binary.

## Atomic Commit Plan
```
security(edge): remove dead verify_hostname config, add command replay protection

verify_hostname field in MqttTlsConfig is never read by configure_tls(),
creating false audit assurance per IEC 62443 FR-4. Command handler has no
deduplication on command_id -- MQTT QoS 1 redelivery and retained messages
re-execute safety-critical write_modbus/plc_start/reboot commands.

Remove verify_hostname field (Option A: hostname verification always mandatory).
Add timestamp window rejection (300s), in-memory LRU dedup on command_id,
SQLCipher persistent dedup table for cross-restart protection, and retained
message rejection.

Plan: docs/plans/2026-04-09-high-fixes/packages/06-edge-mqtt-tls-command-replay.md
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#H-01
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#H-02
```

## Test Plan
- Unit test: configure_tls() no longer accepts verify_hostname field
- Unit test: command with timestamp > 300s from now is rejected
- Unit test: duplicate command_id within window returns cached response
- Unit test: retained message (retain=true) is rejected with warning
- Integration test: agent restart loads recent command_ids from SQLCipher

## Verification Command
`cd sens-api-gateway && cargo test --lib commands:: && cargo test --lib mqtt:: && cargo clippy -- -D warnings`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
