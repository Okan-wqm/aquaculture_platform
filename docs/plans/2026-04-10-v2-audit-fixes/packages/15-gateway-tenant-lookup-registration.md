# Package 15: gateway-tenant-lookup-registration

## Metadata
Status: PENDING
Estimated Tokens: 12K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 1

## Closing-Findings
Closing-Findings: [auth-security-expert/HIGH-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/auth-security-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The gateway `TenantContextMiddleware` requires `TenantLookupService` in production and returns `null` when it is missing. The gateway `AppModule` does not register this provider, so authenticated and tenant-scoped traffic cannot resolve tenant context in production, causing `TENANT_NOT_FOUND` or `TENANT_RESOLUTION_FAILED` for every non-public request.

## Findings
`HIGH-001` (auth-security-expert): Gateway production tenant resolution fails closed because the lookup dependency is never registered. Files: `apps/gateway-api/src/middleware/tenant-context.middleware.ts:423`, `apps/gateway-api/src/app.module.ts:560`.

## Affected Files
- /var/aqua-saas/apps/gateway-api/src/app.module.ts
- /var/aqua-saas/apps/gateway-api/src/middleware/tenant-context.middleware.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(gateway): register TenantLookupService for production tenant resolution

TenantContextMiddleware required TenantLookupService for production
tenant resolution, but the gateway AppModule never registered it. This
caused all authenticated tenant-scoped requests to fail with
TENANT_NOT_FOUND. Registers the service and makes the production
tenant-resolution contract explicit.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/15-gateway-tenant-lookup-registration.md
Closes: docs/reviews/auth-security-expert/2026-04-10-full-repo-audit.md#HIGH-001
```

## Test Plan
- Unit test: TenantLookupService is resolvable from the gateway module.
- Integration test: authenticated request resolves tenant context in production mode.
- Negative test: missing TenantLookupService causes startup failure, not runtime null.

## Verification Command
`npx tsc --noEmit -p apps/gateway-api/tsconfig.json && npx jest --testPathPattern="apps/gateway-api/src" --coverage=false`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

