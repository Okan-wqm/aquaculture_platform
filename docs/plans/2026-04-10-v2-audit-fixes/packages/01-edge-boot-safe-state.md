# Package 01: edge-boot-safe-state

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 18K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [edge-expert/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/edge-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The edge runtime (`sens-api-gateway`) initializes hardware, builds `SafeStateManager`, then starts telemetry, I/O polling, SCADA, command handling, persistence, and the script engine without ever driving actuator outputs to a known fail-safe state. `SafeStateManager.apply()` is only called in the shutdown path. On an industrial aquaculture edge node, this means startup can leave pumps, valves, relays, or other outputs in their prior energized state, which is a life-safety violation.

## Findings
`CRITICAL-001` (edge-expert): Boot path starts control runtime before any safe-state application. File: `sens-api-gateway/src/main.rs`. The only call to `safe_state_manager.apply(...)` is in the shutdown path at lines 1314-1324. The edge runtime never drives actuator outputs to a known fail-safe state before the scripting engine is armed.

## Affected Files
- /var/aqua-saas/sens-api-gateway/src/main.rs

## Dependencies
None.

## Atomic Commit Plan
```
security(edge): apply safe-state before control runtime on boot

The edge runtime previously started the script engine, command handlers,
and I/O loops before applying any safe-state to actuator outputs. This
left pumps, valves, and relays in their prior energized state during
boot, which is a life-safety violation in industrial aquaculture.

Insert safe_state_manager.apply() immediately after hardware
initialization and before any runtime actor or script engine starts. If
any output cannot be driven to safe-state, enter degraded/disabled mode
and surface a hard fault.

LIFE-SAFETY: Actuator outputs must be in known safe-state before runtime.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/01-edge-boot-safe-state.md
Closes: docs/reviews/edge-expert/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Verify `safe_state_manager.apply()` is called before any `start_*` function in the boot sequence.
- Add a unit test that asserts safe-state application occurs before script engine initialization.
- Test that if safe-state application fails, the system enters degraded mode and does not proceed to normal runtime.

## Verification Command
`cd /var/aqua-saas/sens-api-gateway && cargo clippy --all-targets -- -D warnings && cargo test`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

