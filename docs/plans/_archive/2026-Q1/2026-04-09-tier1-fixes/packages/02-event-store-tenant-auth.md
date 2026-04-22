# Package 02: event-store-tenant-auth

## Metadata
Status: PENDING
Estimated Tokens: 24K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes (no prerequisites)
Prerequisites: none
Closing-Findings: [SEC-HIGH-002, TENANT-HIGH-002]
Source-Reviews:
  - docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md
  - docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md
  - docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context

The event-store-service uses `@Headers('x-tenant-id')` on every endpoint (20 endpoints across EventStoreController and ProjectionsController) with no JWT verification, no TenantGuard, and no RolesGuard. Only InternalApiKeyGuard protects access. While the service is not currently deployed and is internal-only, this is an architectural trust boundary violation: with a valid API key (e.g., from a compromised internal service), any caller can read/write events for any tenant. The `validateTenantId()` method only checks UUID format, not authorization.

## Findings

**SEC-HIGH-002 [HIGH] -- event-store-service reads X-Tenant-Id directly from request headers**
- Source: security-reviewer
- File: `apps/event-store-service/src/event-store/event-store.controller.ts`
- Lines: 62, 94, 114, 155, 177, 192, 213, 251, 268, 298, 323 (EventStoreController)
- File: `apps/event-store-service/src/projections/projections.controller.ts`
- Lines: 59, 71, 87, 101, 115, 129, 143, 158, 174 (ProjectionsController)
- No TenantGuard, no JWT verification, no RolesGuard on these controllers
- InternalApiKeyGuard is the only protection; production fails closed if INTERNAL_API_KEY not set
- Residual risk: with valid API key, can read/write events for ANY tenant

**TENANT-HIGH-002 [corroborates] -- SEC-HIGH-002 exploitability assessment**
- Source: multi-tenant-saas-expert
- Confirms architectural weakness despite low real-world exploitability
- Recommendation: Replace `x-tenant-id` header with signed tenant claim via `generateServiceIdentityHeaders`

## Affected Files
- `apps/event-store-service/src/event-store/event-store.controller.ts` (11K chars, ~3K tokens) -- 11 endpoints with @Headers('x-tenant-id')
- `apps/event-store-service/src/projections/projections.controller.ts` (5K chars, ~1.5K tokens) -- 9 endpoints with @Headers('x-tenant-id')
- `apps/event-store-service/src/app.module.ts` (3K chars, ~1K tokens) -- register TenantAuthorizationMiddleware or service-identity guards

## Dependencies
None. This package can be executed in parallel with packages 01, 03, 05, and 07.

## Atomic Commit Plan
```
security(event-store): replace header-only tenant ID with service-identity verification

20 endpoints across EventStoreController and ProjectionsController use
@Headers('x-tenant-id') with no JWT verification. InternalApiKeyGuard
is the only protection. A compromised internal service with a valid API
key can read/write events for any tenant.

Fix: Add TenantAuthorizationMiddleware that validates the X-Tenant-Id
header against the calling service's authorized tenant scope, using
generateServiceIdentityHeaders for signed tenant claims. Remove bare
@Headers('x-tenant-id') extraction from all 20 endpoints.

Closes: docs/reviews/security-reviewer/2026-04-09-tenant-trust-chain-validation.md#SEC-HIGH-002
Closes: docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md#TENANT-HIGH-002
Plan: docs/plans/2026-04-09-tier1-fixes/packages/02-event-store-tenant-auth.md
```

## Test Plan
- Unit tests for each modified controller method must pass
- Add test verifying that requests without valid service identity headers are rejected
- Add test verifying that a valid service identity with mismatched tenant scope is rejected
- Verify that existing internal service callers that use `generateServiceIdentityHeaders` continue to work

## Verification Command
```bash
npx tsc --noEmit -p apps/event-store-service/tsconfig.json && npx jest --testPathPattern="apps/event-store-service" --coverage=false
```
[Dispatch: security-reviewer]

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
