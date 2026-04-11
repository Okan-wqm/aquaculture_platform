# Package 08: fe-offline-cache-tenant-namespace

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 14K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [frontend-expert/FE-CRITICAL-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
AquaMobil stores tenant-specific schedule and messaging data in IndexedDB with keys like `cache_${key}` that have no tenant component. On tenant switch, impersonation, or shared-device reuse, cached data from a previous tenant can be served to a different tenant, creating a cross-tenant browser-storage leak.

## Findings
`FE-CRITICAL-002` (frontend-expert): Tenant-scoped offline caches are missing tenant prefixes. Files: `web/apps/aquamobil/src/pwa/offline-queue.ts:300`, `web/apps/aquamobil/src/hooks/useMySchedule.ts:115`, `web/apps/aquamobil/src/hooks/useMessages.ts:93`. `cacheData()` stores entries as `cache_${key}` with no tenant component, and callers pass keys without `tenantId`.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useMySchedule.ts
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useMessages.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(aquamobil): namespace offline cache keys by tenantId

AquaMobil stored tenant-specific schedule and messaging data in
IndexedDB without any tenant component in the cache key. On tenant
switch or shared-device reuse, data from a previous tenant could be
served to a different tenant. This makes tenantId a required parameter
in the cache API, namespaces all keys as cache_${tenantId}:${key}, and
clears the previous tenant namespace on tenant switch.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/08-fe-offline-cache-tenant-namespace.md
Closes: docs/reviews/frontend-expert/2026-04-10-full-repo-audit.md#FE-CRITICAL-002
```

## Test Plan
- Unit test: `cacheData()` requires tenantId parameter and includes it in key.
- Unit test: cache keys follow `cache_${tenantId}:${key}` format.
- Unit test: tenant switch clears previous tenant's cache entries.
- Unit test: `useMySchedule` and `useMessages` pass tenantId to cache API.

## Verification Command
`npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && npx vitest run web/apps/aquamobil`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

