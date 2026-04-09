# Package 09: edge-scada-cancellation-mqtt-jitter

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 22K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [EDGE-HIGH-007, EDGE-HIGH-008, EDGE-HIGH-009]
Source-Reviews:
  - docs/reviews/edge-expert/2026-04-05-s2-high-findings.md

## Context
Three edge agent operational reliability findings: (1) SCADA binds 0.0.0.0 with no network interface restriction, (2) no CancellationToken/TaskTracker for graceful shutdown -- long-running MQTT publishes and Modbus polls orphaned, (3) MQTT reconnect uses fixed backoff with no jitter -- thundering herd on broker recovery. Additional: SystemTime not monotonic (time rollback causes stale-data misclassification), process image accepts bad quality + numeric value simultaneously, circuit breaker catch-all swallows structured errors, SQLCipher PRAGMA order.

## Findings

**EDGE-HIGH-007** (edge-expert, HIGH)
SCADA OPC UA server binds 0.0.0.0 by default. In edge deployments with multiple network interfaces (OT network + IT/cloud network), this exposes the SCADA server to the IT network where it should not be accessible.

**EDGE-HIGH-008** (edge-expert, HIGH)
No CancellationToken or TaskTracker for graceful shutdown. Long-running operations (MQTT publish queue drain, Modbus poll cycles, firmware update downloads) are aborted mid-operation on SIGTERM, risking data loss and incomplete state transitions.

**EDGE-HIGH-009** (edge-expert, HIGH)
MQTT reconnect backoff is fixed (no jitter). When broker recovers, all edge agents reconnect simultaneously (thundering herd). Also: SystemTime::now() used instead of Instant for elapsed-time checks (time rollback causes stale classification), process image accepts bad quality tag paired with numeric value, circuit breaker catch-all swallows typed errors, SQLCipher PRAGMA order may be incorrect (key must come before any other PRAGMA).

## Affected Files
- sens-api-gateway/src/scada/server.rs
- sens-api-gateway/src/main.rs (shutdown handling)
- sens-api-gateway/src/mqtt.rs (reconnect backoff)
- sens-api-gateway/src/process_image.rs
- sens-api-gateway/src/circuit_breaker.rs
- sens-api-gateway/src/db.rs (SQLCipher PRAGMA)

## Dependencies
None.

## Atomic Commit Plan
```
fix(edge): bind SCADA to OT interface, add graceful shutdown, add MQTT jitter

SCADA binds 0.0.0.0 exposing to IT network. No CancellationToken causes
data loss on SIGTERM. Fixed MQTT reconnect backoff causes thundering herd.
Process image accepts bad-quality values. Circuit breaker swallows typed
errors. SQLCipher PRAGMA order may be incorrect.

Bind SCADA to configured OT interface address. Implement CancellationToken
with TaskTracker for graceful shutdown. Add exponential backoff with jitter
to MQTT reconnect. Replace SystemTime with Instant for elapsed checks.
Reject bad-quality tag values. Preserve error types in circuit breaker.
Ensure PRAGMA key precedes all other PRAGMAs.

Plan: docs/plans/2026-04-09-high-fixes/packages/09-edge-scada-cancellation-mqtt-jitter.md
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#EDGE-HIGH-007
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#EDGE-HIGH-008
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#EDGE-HIGH-009
```

## Test Plan
- Unit test: SCADA server binds to configured interface only
- Unit test: CancellationToken prevents new operations after SIGTERM
- Unit test: MQTT reconnect delay includes jitter component
- Unit test: bad-quality tag value is rejected
- Unit test: SQLCipher PRAGMA key is first statement

## Verification Command
`cd sens-api-gateway && cargo test && cargo clippy -- -D warnings`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
