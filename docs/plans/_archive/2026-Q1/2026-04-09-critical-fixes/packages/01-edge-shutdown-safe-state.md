# Package 01: edge-shutdown-safe-state

## Metadata
Status: PENDING
Estimated Tokens: 6K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes (Sprint 0, no prerequisites)
Prerequisites: none
Sprint: 0 (hotfix)
Closing-Findings: [EDGE-CRITICAL-004]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
LIFE-SAFETY: The Rust edge agent's shutdown handler does not move actuators to a safe state before exiting. When the process stops (crash, OOM kill, SIGTERM from orchestrator), actuators (aerators, feeders, valves) remain in their last commanded position. A stuck-open feeder overfeeds and kills fish; a stuck-off aerator causes oxygen depletion and mass mortality. This is the highest-priority fix in the entire plan.

## Findings
- **EDGE-CRITICAL-004**: Shutdown missing safe-state -- actuators left in last position (LIFE-SAFETY)
  - File: `sens-api-gateway/src/shutdown.rs`, `sens-api-gateway/src/main.rs`
  - The current shutdown handler gracefully disconnects MQTT and flushes telemetry but does NOT issue safe-state commands to connected actuators before exit
  - Root cause: shutdown sequence treats actuators as stateless sensors; no "fail-safe" abstraction exists

## Affected Files
- `/var/aqua-saas/sens-api-gateway/src/shutdown.rs` (~6.4K chars)
- `/var/aqua-saas/sens-api-gateway/src/main.rs` (~58.6K chars, read shutdown-related sections only)

## Dependencies
None. This package has zero prerequisites and MUST be executed first (security override: LIFE-SAFETY).

## Atomic Commit Plan
```
fix(edge): add safe-state actuator command on shutdown (LIFE-SAFETY)

On SIGTERM/SIGINT/panic-hook, iterate all registered actuators and issue
a safe-state command (e.g., aerator ON, feeder OFF, valve CLOSED) before
disconnecting MQTT. Timeout after 2s per device; log failures but do not
block shutdown indefinitely.

LIFE-SAFETY: Prevents fish mortality from stuck actuators during restarts.

Closes: docs/reviews/2026-04-09-critical-fixes#EDGE-CRITICAL-004
Plan: docs/plans/2026-04-09-critical-fixes/packages/01-edge-shutdown-safe-state.md
```

## Test Plan
- Unit test: mock actuator registry with 3 devices, trigger shutdown, verify all 3 receive safe-state command
- Unit test: one device times out, verify remaining devices still receive commands and shutdown completes
- Integration test: start edge agent, connect mock MQTT broker, send SIGTERM, verify safe-state MQTT messages published before disconnect

## Verification Command
```bash
cd /var/aqua-saas/sens-api-gateway && cargo test --lib shutdown -- --nocapture && cargo clippy -- -D warnings
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
