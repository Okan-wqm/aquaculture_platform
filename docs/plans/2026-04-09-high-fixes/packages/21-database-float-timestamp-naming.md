# Package 21: database-float-timestamp-naming

## Metadata
Status: PENDING
Estimated Tokens: 30K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [DB-HIGH-001, DB-HIGH-002, DB-HIGH-003, DB-HIGH-004, DB-HIGH-005, DB-HIGH-006, DB-HIGH-007]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Cross-cutting database schema HIGHs affecting multiple services: (1) messaging tables missing tenant_id column, (2) 46+ entities use timestamp instead of timestamptz (timezone data loss), (3) 46+ float columns should be numeric/decimal for monetary and measurement precision, (4) HR entities use camelCase column names (RLS policy fragility), (5) messaging CHECK constraints use camelCase, (6) Worker entity uses bare varchar without length constraint, (7) missing updated_by audit column across entities.

## Findings

**DB-HIGH-001** (database-reviewer, HIGH)
Messaging service tables (conversations, messages, channels, channel_members) missing tenant_id column. Multi-tenant queries require join to parent entity for tenant filtering. RLS policies cannot be applied directly.

**DB-HIGH-002** (database-reviewer, HIGH)
46+ entities across all services use @Column({ type: 'timestamp' }) instead of timestamptz. Stored timestamps lose timezone information. Cross-timezone deployments produce incorrect time calculations.

**DB-HIGH-003** (database-reviewer, HIGH)
46+ columns use float/double precision for monetary amounts (billing), sensor measurements (temperature, pH, DO), and weight/biomass calculations. IEEE 754 representation causes precision loss in aggregations and comparisons.

**DB-HIGH-004** (database-reviewer, HIGH)
HR service entities use camelCase column names (firstName, lastName, baseSalary) instead of snake_case. PostgreSQL RLS policies must match exact physical column names -- camelCase makes policy installation fragile.

**DB-HIGH-005** (database-reviewer, HIGH)
Messaging service CHECK constraints reference camelCase column names. If a naming strategy is applied later, constraints become invalid.

**DB-HIGH-006** (database-reviewer, HIGH)
Worker entity uses bare varchar (no length constraint) for name, email, role fields. Allows unbounded input that can cause index bloat and buffer overflow in downstream systems.

**DB-HIGH-007** (database-reviewer, HIGH)
Missing updated_by audit column on entities that track modifications. Cannot determine who last modified a record for audit trail compliance.

## Affected Files
- apps/messaging-service/src/*/entities/*.ts
- apps/hr-service/src/*/entities/*.ts
- apps/billing-service/src/*/entities/*.ts
- apps/sensor-service/src/*/entities/*.ts
- apps/farm-service/src/*/entities/*.ts
- libs/backend-common/src/ (naming strategy)
- database/ (migrations)

## Dependencies
DB-HIGH-003 (float to numeric) is a cross-cutting concern that requires coordinated migration across billing, sensor, and farm services. The migration should be generated as a single migration file per service. This package should be executed BEFORE packages that modify entity fields in those services.

## Atomic Commit Plan
```
fix(database): add tenant_id to messaging, fix timestamptz, numeric precision, naming conventions

Messaging tables lack tenant_id. 46+ timestamp columns lose timezone data.
46+ float columns cause precision loss in monetary/measurement values. HR
entities use camelCase (RLS fragile). Missing updated_by audit column.

Add tenant_id column to messaging entities. Change timestamp to timestamptz.
Change float/double to numeric(precision,scale) with appropriate precision
per domain. Apply SnakeNamingStrategy. Add varchar length constraints. Add
updated_by column with @UpdateDateColumn decorator.

BREAKING CHANGE: Column type changes require data migration. Float-to-numeric
migration preserves existing values. Timestamp-to-timestamptz assumes UTC for
existing data.

Plan: docs/plans/2026-04-09-high-fixes/packages/21-database-float-timestamp-naming.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-HIGH-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-HIGH-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-HIGH-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-HIGH-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-HIGH-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-HIGH-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-HIGH-007
```

## Test Plan
- Migration test: tenant_id column exists on messaging tables
- Migration test: timestamp columns are now timestamptz
- Migration test: float columns are now numeric with correct precision
- Migration test: HR columns are snake_case
- Migration test: varchar columns have length constraints
- Unit test: updated_by populated on entity save
- Verify: npm run migration:validate passes for all services

## Verification Command
`npx tsc --noEmit && npm run migration:validate`
[Dispatch: test-runner]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
