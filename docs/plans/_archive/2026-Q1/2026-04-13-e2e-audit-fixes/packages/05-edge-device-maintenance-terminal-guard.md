# Package 05: edge-device-maintenance-terminal-guard

## Metadata
Status: PENDING
Estimated Tokens: ~8K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes (with 04, 06)
Prerequisites: 01-nats-edge-device-tenant-scoped-routing, 02-user-deleted-tenant-verification, 03-mobile-settings-role-enforcement

## Source Reviews
- docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [workflow-state-auditor/HIGH-003]

## Context
The `setMaintenanceMode` method in edge-device.service.ts has no terminal-state guard. It unconditionally sets lifecycleState to MAINTENANCE or ACTIVE regardless of the device's current state. This means a DECOMMISSIONED device can be moved back to MAINTENANCE or ACTIVE, effectively resurrecting it. The `decommissionDevice` method (lines 573-591) sets the device to DECOMMISSIONED with metadata (reason, timestamp), but that state is not treated as terminal by `setMaintenanceMode`.

## Findings
workflow-state-auditor HIGH-003: Edge device maintenance mode can resurrect a decommissioned device.
- File: `apps/sensor-service/src/edge-device/edge-device.service.ts` lines 560-567
- `setMaintenanceMode` has no terminal-state guard. It will move ANY device to MAINTENANCE/ACTIVE including DECOMMISSIONED ones.
- Severity: HIGH
- Gap class: access-gap, tenant-gap, write-gap

## Affected Files
- apps/sensor-service/src/edge-device/edge-device.service.ts (primary -- modify setMaintenanceMode, lines 560-567)

## Dependencies
Prerequisites: Tier 1 packages (01, 02, 03) must be committed first (security-first ordering).
This package touches only the sensor-service. No shared lib changes.

## Atomic Commit Plan
```
fix(sensor): reject maintenance mode toggle for decommissioned devices

setMaintenanceMode unconditionally sets lifecycleState to MAINTENANCE or
ACTIVE, allowing DECOMMISSIONED devices to be resurrected. Add a
terminal-state guard: if device.lifecycleState is DECOMMISSIONED, throw
BadRequestException. DECOMMISSIONED is a terminal state -- the device
must go through a new provisioning/commissioning flow to become active
again.

Addresses: workflow-state-auditor/HIGH-003

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/05-edge-device-maintenance-terminal-guard.md
Closes: docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md#HIGH-003
```

## Test Plan
- Unit test: call setMaintenanceMode on a DECOMMISSIONED device. Assert BadRequestException.
- Unit test: call setMaintenanceMode (enabled=true) on an ACTIVE device. Assert state changes to MAINTENANCE.
- Unit test: call setMaintenanceMode (enabled=false) on a MAINTENANCE device. Assert state changes to ACTIVE.
- Unit test: call setMaintenanceMode on a PROVISIONED device. Assert it works (non-terminal state).

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/edge-device" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
