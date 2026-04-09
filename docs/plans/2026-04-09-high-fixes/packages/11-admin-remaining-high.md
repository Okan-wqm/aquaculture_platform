# Package 11: admin-remaining-high

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 22K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [ADMIN-HIGH-006, ADMIN-HIGH-008, ADMIN-HIGH-009, ADMIN-HIGH-010]
Source-Reviews:
  - docs/reviews/admin-expert/2026-04-05-s2-high-findings.md

## Context
Remaining admin HIGH findings not covered by the audit-trail package: (1) SQL injection via timestamp interpolation in createDefaultTables, (2) hardcoded 'admin' identity in monitoring SQL, (3) no X-Act-As-Tenant infrastructure for dual-identity audit, (4) sync provisioning blocks request thread.

## Findings

**ADMIN-HIGH-006** (admin-expert, HIGH)
File: apps/admin-api-service/src/database-management/services/schema-management.service.ts (lines 183-194)
createDefaultTables interpolates new Date().toISOString() into raw SQL string. Pattern of any dynamic value interpolation is architecturally wrong. schemaName not validated in private method.

**ADMIN-HIGH-008** (admin-expert, HIGH)
File: apps/admin-api-service/src/database-management/services/monitoring.service.ts
SQL queries use schemaName without validation. Identity in monitoring operations hardcoded as 'admin' rather than derived from authenticated user.

**ADMIN-HIGH-009** (admin-expert, HIGH)
No X-Act-As-Tenant header infrastructure. When super admin acts on behalf of tenant, there is no mechanism to record the dual identity (super admin + target tenant) in a single audit entry.

**ADMIN-HIGH-010** (admin-expert, HIGH)
Tenant provisioning is synchronous -- schema creation, table creation, and seed data insertion block the request thread. Long-running provisioning causes HTTP timeout and gateway 504 for large tenant schemas.

## Affected Files
- apps/admin-api-service/src/database-management/services/schema-management.service.ts
- apps/admin-api-service/src/database-management/services/monitoring.service.ts
- apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(admin): parameterize SQL in createDefaultTables, fix monitoring identity, add async provisioning

createDefaultTables interpolates timestamp into raw SQL. Monitoring SQL uses
hardcoded 'admin' identity. No dual-identity audit for tenant impersonation.
Sync provisioning blocks request thread causing timeouts.

Replace interpolated INSERT with parameterized query. Add isValidSchemaName
validation in private methods. Derive monitoring identity from JWT. Add
X-Act-As-Tenant header support for dual-identity audit. Convert provisioning
to async with NATS-based status tracking.

Plan: docs/plans/2026-04-09-high-fixes/packages/11-admin-remaining-high.md
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#H-S2-06
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#ADMIN-HIGH-008
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#ADMIN-HIGH-009
Closes: docs/reviews/admin-expert/2026-04-05-s2-high-findings.md#ADMIN-HIGH-010
```

## Test Plan
- Unit test: createDefaultTables uses parameterized query ($1, $2, $3)
- Unit test: monitoring queries validate schemaName
- Unit test: provisioning returns 202 with status tracking URL
- Unit test: X-Act-As-Tenant header recorded in audit log

## Verification Command
`npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service/src/(database-management|tenant)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
