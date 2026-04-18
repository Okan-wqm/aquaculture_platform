# Package 32: tenant-provisioning-lifecycle

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 12K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [multi-tenant-saas-expert/HIGH-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Tenant provisioning marks a tenant ACTIVE before schema creation, role setup, and admin creation complete. The handler publishes `TenantCreatedEvent` then logs provisioning failures without reverting the status. A partially provisioned tenant can become visible as active even when schema/bootstrap failed, breaking tenant lifecycle integrity.

## Findings
`HIGH-001` (multi-tenant-saas-expert): Tenant provisioning marks a tenant ACTIVE before provisioning completes. Files: `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:162-179`, `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts:126-203`.

## Affected Files
- /var/aqua-saas/apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts
- /var/aqua-saas/apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(admin): keep tenant in PENDING until provisioning saga completes

Tenant provisioning set status to ACTIVE before schema creation, role
setup, and admin creation. Partially provisioned tenants could become
visible as active. This keeps the tenant in PENDING until the full
saga succeeds, transitions to ACTIVE only after all steps complete,
and rolls back to PENDING (or FAILED) on any saga failure with an
explicit error record.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/32-tenant-provisioning-lifecycle.md
Closes: docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md#HIGH-001
```

## Test Plan
- Unit test: tenant status remains PENDING during provisioning.
- Unit test: successful saga transitions tenant to ACTIVE.
- Unit test: failed saga transitions tenant to PENDING or FAILED.
- Unit test: TenantCreatedEvent is published only after ACTIVE transition.
- Negative test: partially provisioned tenant is never visible as ACTIVE.

## Verification Command
`npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service/src/tenant" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

