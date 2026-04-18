# Package 13: database-naming-strategy

## Metadata
Status: PENDING
Estimated Tokens: 15K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
Entity column naming is inconsistent across services: some use `tenantId` (camelCase), others use `tenant_id` (snake_case). Without a global SnakeNamingStrategy, physical column names depend on whether developers remember to add explicit `@Column({ name: 'tenant_id' })` annotations. This makes RLS policy installation fragile because RLS policies must match exact physical column names.

## Findings

**MEDIUM-009 [database-reviewer]: Mixed naming convention (tenantId vs tenant_id) across entities**
- Makes RLS policy installation fragile — the policy must match the exact physical column name
- Some entities have `@Column({ name: 'tenant_id' })`, others rely on TypeORM default camelCase-to-column mapping

**MEDIUM-010 [database-reviewer]: No global SnakeNamingStrategy configured**
- Physical database column names vary by developer annotation presence
- Confirmed in codebase: `libs/backend-common/src/database/watchdog/cross-tenant-probe.ts` comments on this issue
- `apps/hydroponics-service` tests explicitly document "no global SnakeNamingStrategy"

Closing-Findings: [MEDIUM-009, MEDIUM-010]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- TypeORM data source configuration files across all services (executor must enumerate)
- Entity files with inconsistent `@Column` annotations (executor must audit)
- `/var/aqua-saas/libs/backend-common/src/database/` (strategy registration point)

## Dependencies
None from packages 01-12.

WARNING: This is an architectural change that affects ALL services. Introducing SnakeNamingStrategy globally will change physical column names for any entity that does NOT have explicit `@Column({ name: ... })` annotations. This requires:
1. A migration to rename columns OR
2. Adding explicit `@Column({ name: ... })` to every entity field first

Executor must determine the safer path. A phased approach is recommended:
- Phase A (this package): Add SnakeNamingStrategy to data source config
- Phase B (separate package if needed): Generate and validate migration for any column renames

## Atomic Commit Plan
```
refactor(database): add global SnakeNamingStrategy and audit entity column annotations

Register SnakeNamingStrategy in the shared TypeORM data source configuration
so all services use consistent snake_case column naming. Audit and add
explicit @Column({ name: '...' }) annotations where needed to prevent
unintended column renames.

This makes RLS policy installation deterministic — tenant_id is always
the physical column name, not tenantId.

Plan: docs/plans/2026-04-09-full-remediation/packages/13-database-naming-strategy.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-009
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-010
```

## Test Plan
- Run full TypeScript compilation across all services
- Run migration:validate to confirm no unexpected column renames
- Run existing RLS-related tests
- Verify cross-tenant-probe still functions correctly

## Verification Command
`npx tsc --noEmit -p libs/backend-common/tsconfig.json`
[Dispatch: test-runner] (affects all services — full regression required)

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
