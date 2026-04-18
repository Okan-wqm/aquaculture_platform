# Package 04: sensor-channel-tenant-isolation

## Metadata
Status: PENDING
Estimated Tokens: 8K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 0, no prerequisites)
Prerequisites: none
Sprint: 0 (hotfix)
Closing-Findings: [SENSOR-CRITICAL-002]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The `saveDiscoveredChannels` method issues a DELETE statement to remove existing channels before inserting new ones, but the DELETE is missing a `tenantId` filter. This means discovering channels for one device deletes ALL discovered channels across ALL tenants, causing cross-tenant data destruction. This is an active exploit vector for any authenticated device.

## Findings
- **SENSOR-CRITICAL-002**: saveDiscoveredChannels DELETE missing tenantId -- cross-tenant destructive
  - File: `apps/sensor-service/src/registration/services/channel-management.service.ts` (~15.2K chars)
  - The DELETE WHERE clause filters only by deviceId, not by tenantId
  - Root cause: tenant isolation was not applied to the bulk-replace pattern

## Affected Files
- `/var/aqua-saas/apps/sensor-service/src/registration/services/channel-management.service.ts` (~15.2K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(sensor): add tenantId filter to saveDiscoveredChannels DELETE

The DELETE statement in saveDiscoveredChannels removes channels by
deviceId only, causing cross-tenant channel deletion. Add tenantId
to the WHERE clause to scope the DELETE to the current tenant.

Closes: docs/reviews/2026-04-09-critical-fixes#SENSOR-CRITICAL-002
Plan: docs/plans/2026-04-09-critical-fixes/packages/04-sensor-channel-tenant-isolation.md
```

## Test Plan
- Unit test: saveDiscoveredChannels with tenantId=A only deletes tenant A's channels
- Unit test: tenant B's channels remain untouched after tenant A's discovery
- Integration test: two tenants with same deviceId model -- channels isolated

## Verification Command
```bash
cd /var/aqua-saas && npx jest --testPathPattern="apps/sensor-service/src/registration" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
