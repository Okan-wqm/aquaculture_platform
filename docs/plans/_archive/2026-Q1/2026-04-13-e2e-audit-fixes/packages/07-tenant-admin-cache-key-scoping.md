# Package 07: tenant-admin-cache-key-scoping

## Metadata
Status: PENDING
Estimated Tokens: ~6K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes (with 08)
Prerequisites: 04-archive-channel-membership-fix, 05-edge-device-maintenance-terminal-guard, 06-task-event-integrity

## Source Reviews
- docs/test-audits/realtime-sync-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [realtime-sync-auditor/HIGH-003]

## Context
Two React Query hooks in the tenant-admin module use cache keys that do not include tenantId. In impersonation flows (where a super-admin switches between tenants), the cached data survives the tenant switch and shows stale/wrong-tenant data. `useTenantActivity` uses `['tenant-activity']` as the base key; `useDevicePolling` uses `['edgeDevice', deviceId]`. Both must include tenantId so React Query invalidates correctly on tenant context change.

## Findings
realtime-sync-auditor HIGH-003: Tenant-admin live polling caches are not tenant-scoped.
- Files: `web/modules/tenant-admin/src/hooks/useTenantActivity.ts` line 64, `web/modules/tenant-admin/src/hooks/useDevicePolling.ts` line 121
- Query keys like `['tenant-activity']` and `['edgeDevice', deviceId]` don't include tenantId. In impersonation flows, cached data survives tenant switch.
- Severity: HIGH
- Gap class: tenant-gap, sync-gap

## Affected Files
- web/modules/tenant-admin/src/hooks/useTenantActivity.ts (primary -- modify activityKeys object, line 64-68)
- web/modules/tenant-admin/src/hooks/useDevicePolling.ts (primary -- modify queryKey, line 121)

## Dependencies
Prerequisites: Tier 2 packages (04, 05, 06) must be committed first (tier ordering).
This package touches only the tenant-admin frontend module. No backend or shared lib changes.

## Atomic Commit Plan
```
fix(tenant-admin): add tenantId to React Query cache keys for tenant-scoped polling

useTenantActivity and useDevicePolling use query keys without tenantId.
During impersonation (super-admin switching between tenants), React Query
serves cached data from the previous tenant because the cache key is
identical. Add tenantId to:
- activityKeys.all: ['tenant-activity', tenantId]
- useDevicePolling queryKey: ['edgeDevice', tenantId, deviceId]

This ensures cache invalidation on tenant context change and prevents
cross-tenant data leakage in admin impersonation flows.

Addresses: realtime-sync-auditor/HIGH-003

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/07-tenant-admin-cache-key-scoping.md
Closes: docs/test-audits/realtime-sync-auditor/2026-04-11-full-platform-e2e.md#HIGH-003
```

## Test Plan
- Unit test: render useTenantActivity with tenantId A, then re-render with tenantId B. Assert a new fetch is triggered (cache miss).
- Unit test: render useDevicePolling with tenantId A + deviceId X, then re-render with tenantId B + deviceId X. Assert a new fetch is triggered.
- Verify the hook accepts tenantId from auth context (useAuthContext or equivalent).

## Verification Command
`npx tsc --noEmit -p web/modules/tenant-admin/tsconfig.json && npx vitest run web/modules/tenant-admin/src/hooks`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
