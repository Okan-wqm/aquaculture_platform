# Package 06: fe-query-key-tenant-prefix

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 0, no prerequisites)
Prerequisites: none
Sprint: 0 (hotfix)
Closing-Findings: [FE-CRITICAL-014, FE-CRITICAL-015, FE-CRITICAL-016]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Three React Query hooks use query keys without tenant prefixes. In a multi-tenant SaaS with shared browser sessions (admin impersonation, tenant switching), the React Query cache is global per browser tab. Without tenant-scoped query keys, switching tenants serves stale data from the previous tenant's cache -- a cross-tenant data leak. Dashboard data, live sensor readings, and farm realtime streams are all affected.

## Findings
- **FE-CRITICAL-014**: Dashboard query keys have NO tenant prefix -- cross-tenant cache leak
  - File: `web/modules/dashboard/src/hooks/useDashboardData.ts` (~24.2K chars)
  - Query keys like `['dashboard', 'summary']` are tenant-agnostic

- **FE-CRITICAL-015**: LiveSensorWidget query keys NO tenant prefix -- cross-tenant sensor data
  - File: `web/modules/dashboard/src/widgets/LiveSensorWidget.tsx` (~6.5K chars)
  - Query keys like `['sensor', 'live', sensorId]` lack tenantId segment

- **FE-CRITICAL-016**: Farm realtime stream invalidation keys NO tenant prefix
  - File: `web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts` (~6.5K chars)
  - Invalidation targets like `['farms']`, `['batches']` are shared across tenants

## Affected Files
- `/var/aqua-saas/web/modules/dashboard/src/hooks/useDashboardData.ts` (~24.2K chars)
- `/var/aqua-saas/web/modules/dashboard/src/widgets/LiveSensorWidget.tsx` (~6.5K chars)
- `/var/aqua-saas/web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts` (~6.5K chars)

## Dependencies
None. These are independent frontend modules.

## Atomic Commit Plan
```
security(frontend): add tenant prefix to all query keys preventing cross-tenant cache leak

Prefix every React Query key with the current tenant ID from auth
context: ['tenant', tenantId, ...rest]. This ensures tenant switching
or admin impersonation invalidates all prior-tenant cache entries and
prevents cross-tenant data leakage via stale cache.

Applies to: useDashboardData, LiveSensorWidget, useFarmRealtimeStream.

Closes: docs/reviews/2026-04-09-critical-fixes#FE-CRITICAL-014
Closes: docs/reviews/2026-04-09-critical-fixes#FE-CRITICAL-015
Closes: docs/reviews/2026-04-09-critical-fixes#FE-CRITICAL-016
Plan: docs/plans/2026-04-09-critical-fixes/packages/06-fe-query-key-tenant-prefix.md
```

## Test Plan
- Unit test: useDashboardData query key includes tenantId segment
- Unit test: LiveSensorWidget query key includes tenantId segment
- Unit test: useFarmRealtimeStream invalidation keys include tenantId segment
- Integration test: simulate tenant switch -- verify old cache entries are not served

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p web/modules/dashboard/tsconfig.json && npx tsc --noEmit -p web/modules/farm-module/tsconfig.json && npx vitest run web/modules/dashboard web/modules/farm-module
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
