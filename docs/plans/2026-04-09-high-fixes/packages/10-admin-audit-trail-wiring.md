# Package 10: admin-audit-trail-wiring

## Metadata
Status: PENDING
Estimated Tokens: 35K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [ADMIN-HIGH-001, ADMIN-HIGH-002, ADMIN-HIGH-003, ADMIN-HIGH-004, ADMIN-HIGH-005, ADMIN-HIGH-007]
Source-Reviews:
  - docs/reviews/admin-expert/2026-04-05-s2-high-findings.md

## Context
The admin-api-service has a systemic audit log gap: DatabaseManagementModule and ImpersonationModule do not wire AuditLogService. Six HIGH findings share the root cause of missing audit integration: schema DROP has no audit record, migration executedBy is client-supplied (falsifiable), impersonation events never reach central audit, backup/restore has no initiator tracking, and no dual-identity audit for impersonated actions.

## Findings

**ADMIN-HIGH-001** (admin-expert, HIGH)
File: apps/admin-api-service/src/database-management/controllers/explorer.controller.ts (lines 122-146)
Explorer filter field declared as SQL injection vector. TableQueryDto exposes filter?: string with no format constraint. orderBy protected only by runtime isValidIdentifier(), not DTO-level @Matches.

**ADMIN-HIGH-002** (admin-expert, HIGH)
File: apps/admin-api-service/src/database-management/controllers/schema.controller.ts (lines 119-126)
File: apps/admin-api-service/src/database-management/services/schema-management.service.ts (lines 283-304)
DROP SCHEMA CASCADE with no audit record, no UUID pipe on tenantId param, no confirmation gate. Permanently destroys all tenant data with no immutable record of who initiated it.

**ADMIN-HIGH-003** (admin-expert, HIGH)
File: apps/admin-api-service/src/database-management/controllers/migration.controller.ts (lines 38-45, 115-162)
Migration executedBy accepted from client body, not JWT. All three migration endpoints (run, rollback, batch) allow identity falsification in migration history.

**ADMIN-HIGH-004** (admin-expert, HIGH)
File: apps/admin-api-service/src/impersonation/services/impersonation.service.ts
File: apps/admin-api-service/src/impersonation/impersonation.module.ts
ImpersonationModule does not import AuditModule. Session start/end/terminate/expire events never written to audit_logs table. Security dashboard shows zero impersonation events.

**ADMIN-HIGH-005** (admin-expert, HIGH)
File: apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts (lines 337-360)
No MFA step-up gate before impersonation start. PlatformAdminGuard checks role only, not authentication assurance level. Compromised SUPER_ADMIN token enables immediate impersonation without MFA.

**ADMIN-HIGH-007** (admin-expert, HIGH)
File: apps/admin-api-service/src/database-management/database-management.module.ts
DatabaseManagementModule does not import AuditModule. Schema DROP, backup/restore, batch migrations, schema status changes produce no central audit log entries. BackupRestoreService has no initiatedBy parameter.

## Affected Files
- apps/admin-api-service/src/database-management/database-management.module.ts
- apps/admin-api-service/src/database-management/controllers/explorer.controller.ts
- apps/admin-api-service/src/database-management/controllers/schema.controller.ts
- apps/admin-api-service/src/database-management/controllers/migration.controller.ts
- apps/admin-api-service/src/database-management/services/schema-management.service.ts
- apps/admin-api-service/src/database-management/services/backup-restore.service.ts
- apps/admin-api-service/src/impersonation/impersonation.module.ts
- apps/admin-api-service/src/impersonation/services/impersonation.service.ts
- apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts

## Dependencies
ADMIN-HIGH-005 (MFA step-up) has cross-domain dependency on auth-service for POST /auth/step-up endpoint. This package implements the admin-side guard and validation; the auth-service endpoint is noted as a prerequisite but scoped separately.

## Atomic Commit Plan
```
security(admin): wire AuditLogService to database management and impersonation modules

DatabaseManagementModule and ImpersonationModule do not import AuditModule.
Schema DROP, backup, restore, migration, and impersonation operations produce
no central audit log entries. Migration executedBy is client-supplied (identity
falsification). Explorer DTO has latent SQL injection surface. No MFA step-up
for impersonation.

Import AuditModule in both modules. Inject AuditLogService. Remove filter field
from TableQueryDto. Add @Matches and ParseUUIDPipe validations. Replace
executedBy with req.user.id from JWT. Emit audit events for all destructive
operations. Add MfaStepUpGuard placeholder (requires auth-service endpoint).

Plan: docs/plans/2026-04-09-high-fixes/packages/10-admin-audit-trail-wiring.md
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#H-S2-01
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#H-S2-02
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#H-S2-03
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#H-S2-04
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#H-S2-05
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#H-S2-07
```

## Test Plan
- Unit test: schema DELETE emits SCHEMA_HARD_DELETED audit event
- Unit test: migration executedBy derived from req.user.id, not body
- Unit test: impersonation start emits IMPERSONATION_STARTED audit event
- Unit test: impersonation end/terminate/expire emit corresponding events
- Unit test: backup creates audit trail with initiatedBy
- Unit test: filter field removed from TableQueryDto
- Unit test: ParseUUIDPipe rejects non-UUID tenantId
- Integration test: MfaStepUpGuard rejects requests without step-up token

## Verification Command
`npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service/src/(database-management|impersonation)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
