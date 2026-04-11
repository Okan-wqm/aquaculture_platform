# Package 30: edge-mqtt-failover-wiring

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 12K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [edge-expert/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/reviews/edge-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
MQTT failover commands (`cmd_failover_force()` and `cmd_failover_recover()`) log a warning and return `"failover_initiated"` without actually switching brokers. The `mqtt_failover.rs` state machine exists but is not wired into the runtime, leaving the system exposed during broker outages with a misleading success response.

## Findings
`HIGH-003` (edge-expert): Failover commands report success without actually switching brokers. Files: `sens-api-gateway/src/commands.rs:3309-3346,3349-3388`, `sens-api-gateway/src/mqtt_failover.rs`. Both command handlers are TODOs that return success without performing any broker transition.

## Affected Files
- /var/aqua-saas/sens-api-gateway/src/commands.rs
- /var/aqua-saas/sens-api-gateway/src/mqtt_failover.rs

## Dependencies
None.

## Atomic Commit Plan
```
fix(edge): wire FailoverManager into MQTT runtime and command handlers

MQTT failover commands returned success without performing any actual
broker transition, leaving the system exposed during outages with
misleading operator feedback. This wires the FailoverManager state
machine into the MQTT client runtime, starts its health-check task, and
connects the command handlers to the actual transition methods. If
failover cannot be completed, commands now return explicit failure
instead of false success.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/30-edge-mqtt-failover-wiring.md
Closes: docs/reviews/edge-expert/2026-04-10-full-repo-audit.md#HIGH-003
```

## Test Plan
- Unit test: `cmd_failover_force()` calls FailoverManager.force_failover().
- Unit test: `cmd_failover_recover()` calls FailoverManager.recover().
- Unit test: failed failover returns error, not success.
- Integration test: broker switch actually occurs during failover.
- Test: health-check task detects broker unavailability.

## Verification Command
`cd /var/aqua-saas/sens-api-gateway && cargo clippy --all-targets -- -D warnings && cargo test`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

