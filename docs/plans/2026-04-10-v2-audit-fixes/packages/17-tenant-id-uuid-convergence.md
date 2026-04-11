# Package 17: tenant-id-uuid-convergence

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: HIGH
Security-Sensitive: no
Parallelizable: no
Prerequisites: 04-infra-postgres-per-service-roles
Sprint: 1

## Closing-Findings
Closing-Findings: [data-expert/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/reviews/data-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Tenant identity is modeled inconsistently: several entities use `@Column({ name: 'tenant_id' })` with no explicit type (defaults to varchar), and config-service uses a non-UUID `'global'` sentinel as a first-class code path. This diverges from the platform-wide UUID tenant model and makes RLS, cross-service joins, and migration convergence harder to reason about.

## Findings
`HIGH-003` (data-expert): Tenant identity is modeled inconsistently across entity classes. Files: `apps/alert-engine/src/audit/entities/audit-entry.entity.ts:25-26`, `apps/billing-service/src/billing/entities/invoice.entity.ts:109-111`, `apps/billing-service/src/billing/entities/payment.entity.ts:92-94`, `apps/billing-service/src/billing/entities/subscription.entity.ts:101-103`, `apps/notification-service/src/notification/entities/notification-log.entity.ts:51-52`, `apps/alert-engine/src/database/entities/alert-incident.entity.ts:94-97`, `apps/config-service/src/configuration/entities/configuration.entity.ts:62-65,190-192`, `apps/config-service/src/configuration/query-handlers/get-configuration.handler.ts:30-48`.

## Affected Files
- /var/aqua-saas/apps/alert-engine/src/audit/entities/audit-entry.entity.ts
- /var/aqua-saas/apps/alert-engine/src/database/entities/alert-incident.entity.ts
- /var/aqua-saas/apps/billing-service/src/billing/entities/invoice.entity.ts
- /var/aqua-saas/apps/billing-service/src/billing/entities/payment.entity.ts
- /var/aqua-saas/apps/billing-service/src/billing/entities/subscription.entity.ts
- /var/aqua-saas/apps/notification-service/src/notification/entities/notification-log.entity.ts
- /var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts
- /var/aqua-saas/apps/config-service/src/configuration/query-handlers/get-configuration.handler.ts

## Dependencies
04-infra-postgres-per-service-roles -- per-service database roles must be in place before running migration scripts that alter column types across multiple schemas, as migrations will require the correct per-service credentials.

## Atomic Commit Plan
```
fix(data): converge tenant_id to explicit UUID type across all entities

Multiple entities used @Column({ name: 'tenant_id' }) with no explicit
type, defaulting to varchar. Config-service used 'global' as a
non-UUID sentinel. This makes tenant_id explicit uuid in every
tenant-scoped entity, replaces the 'global' sentinel with a reserved
system tenant UUID (00000000-0000-0000-0000-000000000000), splits
system-wide config into a separate table, and adds a migration to
converge existing drift.

BREAKING CHANGE: config-service no longer accepts string 'global' as
tenantId. Use the system tenant UUID for global configuration.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/17-tenant-id-uuid-convergence.md
Closes: docs/reviews/data-expert/2026-04-10-full-repo-audit.md#HIGH-003
```

## Test Plan
- Unit test: all tenant-scoped entities have `@Column({ type: 'uuid' })` on tenant_id.
- Migration test: existing varchar values are migrated to UUID.
- Integration test: config-service resolves system config via system tenant UUID.
- Negative test: non-UUID tenantId value is rejected at entity validation.

## Verification Command
`npx tsc --noEmit -p apps/alert-engine/tsconfig.json && npx tsc --noEmit -p apps/billing-service/tsconfig.json && npx tsc --noEmit -p apps/config-service/tsconfig.json && npx tsc --noEmit -p apps/notification-service/tsconfig.json`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

