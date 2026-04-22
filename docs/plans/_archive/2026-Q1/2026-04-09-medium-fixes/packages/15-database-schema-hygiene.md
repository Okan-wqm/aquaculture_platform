# Package 15: database-schema-hygiene

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 20K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [DB-MEDIUM-001, DB-MEDIUM-002, DB-MEDIUM-003, DB-MEDIUM-004, DB-MEDIUM-005, DB-MEDIUM-006, DB-MEDIUM-007, DB-MEDIUM-008]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/database-reviewer/2026-04-04-full-platform-audit.md

## Context
Eight database schema findings cover naming inconsistency, redundant indexes, missing format validation, JSONB type abuse for monetary/pricing data, unregistered hypertables, and ineffective boolean indexes. All are migration-level or entity-decorator changes. Grouped because database schema changes must be coordinated to avoid conflicting migrations.

## Findings

**DB-MEDIUM-001 — Naming inconsistency (camelCase vs snake_case columns)**
Some entities use `@Column('tenant_id')` explicit naming while others rely on TypeORM's default camelCase-to-no-transform. Without a global `SnakeNamingStrategy`, physical column names are unpredictable. This finding overlaps with MEDIUM-009/010 from the orchestrator plan but covers additional tables beyond the tenant column.

**DB-MEDIUM-002 — Redundant tenant_id single-column index**
Several entities have both a single-column index on `tenant_id` AND a composite index starting with `tenant_id` (e.g., `(tenant_id, created_at)`). The composite index already serves single-column lookups. Drop the redundant single-column indexes to reduce write amplification.

**DB-MEDIUM-003 — nationalId column has no format validation**
The `employee.entity.ts` `nationalId` column is a bare `varchar` with no CHECK constraint or application-level format validation. National IDs vary by country but should at minimum reject empty strings and enforce a length range.

**DB-MEDIUM-004 — Payroll uses JSONB for monetary breakdown**
`payroll.entity.ts` stores salary breakdown (base, overtime, deductions) as a JSONB column. This bypasses type safety and makes aggregation queries expensive. Flatten to typed `numeric` columns.

**DB-MEDIUM-005 — Plan pricing stored as JSONB**
`billing` plan pricing tiers are stored as a JSONB column. This makes it impossible to query "all plans costing less than X" efficiently. Flatten to relational structure or at minimum add a generated column for the base price.

**DB-MEDIUM-006 — Channel name varchar(255) for messaging**
The messaging `channel` entity uses `varchar(255)` for channel names. Channel names should be limited to a reasonable length (e.g., 100 chars) with a CHECK constraint. 255 is wasteful for index storage.

**DB-MEDIUM-007 — sensor_metric hypertable not registered with TimescaleDB**
The `sensor_metric` table is created as a regular PostgreSQL table but is expected to be a TimescaleDB hypertable for time-series compression and retention. Call `create_hypertable()` in the migration.

**DB-MEDIUM-008 — is_deleted boolean column with standard B-tree index**
Several entities use `is_deleted: boolean` with a B-tree index. For highly skewed boolean columns (99% false), a partial index `WHERE is_deleted = false` is far more efficient. Replace with partial index.

## Affected Files
- apps/hr-service/src/hr/entities/employee.entity.ts
- apps/hr-service/src/hr/entities/payroll.entity.ts
- apps/billing-service/src/billing/entities/ (plan pricing entity)
- apps/messaging-service/src/messaging/entities/channel.entity.ts
- apps/sensor-service/src/ (sensor_metric entity)
- database/migrations/ (new migration for index changes, hypertable creation)
- Multiple entities across services (naming strategy, redundant indexes, partial index)

## Dependencies
None directly. However, if package 04 (HR monetary types) changes the payroll entity simultaneously, there is a soft dependency on ordering. Since both are parallelizable and touch different aspects of the payroll entity (event types vs column structure), they can proceed independently — but the executor should verify no merge conflicts on `payroll.entity.ts`.

## Atomic Commit Plan
```
fix(database): normalize naming, drop redundant indexes, add nationalId validation, flatten JSONB monetary/pricing, register hypertable, use partial indexes

Eight database schema hygiene fixes:
- Apply consistent snake_case naming (or SnakeNamingStrategy)
- Drop redundant single-column tenant_id indexes where composite exists
- Add CHECK constraint and length validation on nationalId
- Flatten payroll JSONB breakdown to typed numeric columns
- Flatten billing plan pricing to relational columns with generated base_price
- Reduce channel name to varchar(100) with CHECK constraint
- Register sensor_metric as TimescaleDB hypertable
- Replace B-tree on is_deleted with partial index WHERE is_deleted = false

BREAKING CHANGE: payroll entity schema changes (JSONB to columns).
Billing plan pricing schema changes (JSONB to relational).
data-expert review required

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DB-MEDIUM-008
Plan: docs/plans/2026-04-09-medium-fixes/packages/15-database-schema-hygiene.md
```

## Test Plan
- Migration test: all column names follow snake_case convention
- Migration test: no single-column tenant_id index where composite exists
- Unit test: nationalId rejects empty string, enforces length 5-20
- Migration test: payroll entity has typed numeric columns, no JSONB breakdown
- Migration test: sensor_metric is a TimescaleDB hypertable (query timescaledb_information.hypertables)
- Migration test: is_deleted indexes are partial (WHERE is_deleted = false)
- EXPLAIN ANALYZE: queries on is_deleted use partial index

## Verification Command
`npx tsc --noEmit && npm run migration:validate -- --schema=tenant_test_$(git rev-parse --short HEAD)`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
