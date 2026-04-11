# Package 28: admin-schema-delete-audit

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [admin-expert/HIGH-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/admin-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
`DELETE /database/schemas/:tenantId?hardDelete=true` routes directly into `DROP SCHEMA ... CASCADE` with no second confirmation step and no `AuditLogService` write. A tenant schema can be permanently destroyed without an immutable audit record of who initiated it.

## Findings
`HIGH-001` (admin-expert): Tenant schema hard delete is still one query flag away and leaves no central audit trail. Files: `apps/admin-api-service/src/database-management/controllers/schema.controller.ts`, `apps/admin-api-service/src/database-management/services/schema-management.service.ts`.

## Affected Files
- /var/aqua-saas/apps/admin-api-service/src/database-management/controllers/schema.controller.ts
- /var/aqua-saas/apps/admin-api-service/src/database-management/services/schema-management.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(admin): require confirmation token and audit trail for schema hard delete

DROP SCHEMA CASCADE was reachable via a single query flag with no
confirmation step and no audit record. This adds a dedicated
destructive-action endpoint requiring an explicit confirmation token,
injects AuditLogService into the schema management service, and writes
an immutable audit entry (initiator, IP, timestamp, target schema)
before the drop executes.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/28-admin-schema-delete-audit.md
Closes: docs/reviews/admin-expert/2026-04-10-full-repo-audit.md#HIGH-001
```

## Test Plan
- Unit test: hard delete without confirmation token is rejected.
- Unit test: hard delete produces an audit entry before the drop.
- Unit test: audit entry contains initiator, IP, timestamp, target schema.
- Negative test: `?hardDelete=true` alone no longer triggers the drop.

## Verification Command
`npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service/src" --coverage=false`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

