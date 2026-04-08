# Research: TypeORM Entity vs Migration Drift Detection

**Topic:** Entity vs migration drift, synchronize: false in production mandate, watchdog-style drift detection (SchemaDriftDetector), @Column type correctness vs TypeScript types
**Date:** 2026-04-08
**Agent:** data-expert

## Sources

- [TypeORM — How migrations work](https://typeorm.io/docs/migrations/why/)
- [TypeORM — Generating migrations](https://typeorm.io/docs/migrations/generating/)
- [TypeORM — Decorator reference (@Column, @Entity)](https://typeorm.io/docs/help/decorator-reference/)
- [TypeORM — Postgres driver (precision, NUMERIC, JSONB)](https://typeorm.io/docs/drivers/postgres/)
- [TypeORM — Data Source Options (`synchronize`)](https://typeorm.io/docs/data-source/data-source-options/)
- [PostgreSQL 18 — Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html) (precision, scale, NUMERIC string semantics)
- Platform source: `libs/backend-common/src/database/watchdog/schema-drift-detector.ts`, `libs/backend-common/src/database/decimal-transformer.ts`

## Key Findings

### `synchronize: true` is banned in production — TypeORM says so, and the aqua-saas rules codify it

TypeORM's own docs: *"It is unsafe to use `synchronize: true` for schema synchronization on production once you get data in your database. Instead, don't use this in production — otherwise you can lose production data."* The platform's CLAUDE.md already forbids this. Enforcement at review time:

- Any `DataSource` configuration with `synchronize: true` outside of `*.spec.ts` test fixtures is **CRITICAL**.
- `synchronize: process.env.NODE_ENV !== 'production'` is also **CRITICAL** because it relies on an env variable that can be misconfigured or forgotten. The correct value is a hard-coded `synchronize: false`.
- The only legitimate runtime schema sync in aqua-saas is `SourceSchemaBootstrapService.bootstrapSourceSchema()`, which calls `DataSource.synchronize()` but is **scoped to the source schema only** and is itself bounded by `SourceSchemaWriteGuard` triggers that prevent accidental writes. Any other invocation of `synchronize()` is a rule violation.

### The three drift sources

1. **Entity drift (TypeScript model is ahead of DB).** Developer adds a `@Column` on an entity, forgets to generate a migration. On deploy, the entity's INSERT statements fail because the column doesn't exist. This is caught by CI integration tests if they run against a real DB with migrations applied.

2. **Migration drift (DB is ahead of the TypeScript model).** Developer writes a migration that adds a column, but does not add the `@Column` to the entity. The database accepts the column but TypeORM's type system doesn't see it — SELECT queries ignore the column. This is the silent variant and is much harder to catch.

3. **Multi-tenant drift (some tenant schemas migrated, others did not).** Most dangerous in aqua-saas. A migration that should run per-tenant partially completes, leaving tenant_A with the new shape and tenant_B with the old shape. The `SchemaDriftDetector` (`libs/backend-common/src/database/watchdog/schema-drift-detector.ts`) scans every tenant schema and reports tables present in some tenants but not others.

### The canonical drift detection strategy (what SchemaDriftDetector does right)

The existing `SchemaDriftDetector.detect()`:

1. Lists all tenant schemas via `listTenantSchemas()` (regex-validated).
2. For each schema, queries `information_schema.tables` and compares against `MODULE_SCHEMAS.flatMap(m => m.tables)`.
3. Builds a majority-vote "canonical" table set: a table is canonical if it appears in ≥50% of tenant schemas.
4. Reports `MISSING_TABLE` (expected but not found), `SCHEMA_DRIFT` (missing from canonical), and extras (not in canonical).
5. Uses majority-vote rather than "first schema wins" — which prevents a single drifted tenant from making every other tenant look drifted.

This is structurally correct. The gaps (and what reviews should flag):

- **Does not detect column-level drift.** It only detects table presence. An entity change that adds a column to one tenant but not others is invisible to the current detector. The reviewer must add a column-level drift check for any PR that touches `MODULE_SCHEMAS` table definitions.
- **Does not detect type mismatches.** If one tenant has `tenant_id varchar(255)` and another has `tenant_id uuid`, the detector reports neither. This is precisely the shape of the 2026-04-07 incident.
- **Relies on `MODULE_SCHEMAS` as ground truth.** If `MODULE_SCHEMAS` lists a table that no entity defines, the detector will silently consider "missing from tenants" as drift even when the correct fix is to remove the stale entry from `MODULE_SCHEMAS`.

### Entity-type-vs-column-type correctness (the silent corruption class)

TypeScript types and PostgreSQL types are not interchangeable. Common aqua-saas drift patterns:

#### NUMERIC / DECIMAL

PostgreSQL `NUMERIC` / `DECIMAL` returns as **strings** from the driver to preserve arbitrary precision. If the entity declares `@Column('numeric') amount: number;`, TypeORM will hand the application a string, but the type system says `number`. Arithmetic (`amount + 1`) produces `'42.501'` or `NaN`.

The correct pattern, already implemented in aqua-saas as `DecimalTransformer`:

```typescript
@Column({
  type: 'numeric',
  precision: 18,
  scale: 4,
  transformer: DecimalTransformer,
})
amount: number;
```

`DecimalTransformer` bridges `string ↔ number` but loses precision beyond `Number.MAX_SAFE_INTEGER` (2^53). For monetary values in cents this is fine; for scientific/sensor values with 15+ significant digits, a `bigint` or string representation is required.

TypeORM's own docs call this out: *"JavaScript numbers are IEEE-754 and lose precision over the maximum safe integer (`Number.MAX_SAFE_INTEGER` = +2^53). If you require the full 64-bit range, consider working with the returned strings or converting them to native bigint instead."*

#### JSONB

`@Column('jsonb') data: any;` is a type system escape hatch and is banned by the platform CLAUDE.md rule `as any YASAK`. The correct pattern is:

```typescript
interface SensorReadingMeta {
  unit: 'celsius' | 'fahrenheit' | 'kelvin';
  calibratedAt: string; // ISO date
  batchId: string;
}

@Column({ type: 'jsonb' })
meta: SensorReadingMeta;
```

Note that JSONB columns with `null` need special handling: TypeORM returns `null`, not `undefined`, and the TypeScript type must allow `null` if the column is nullable.

#### UUID vs varchar

The 2026-04-07 incident: some legacy tables had `tenant_id varchar(255)` while the RLS policy's `COALESCE(..., '')::uuid` cast expected `uuid`. The reviewer must flag any entity that declares `@Column tenantId: string` without an explicit `@Column({ type: 'uuid' }) tenantId: string` — the default for `string` is `varchar(255)`, not `uuid`.

#### Timestamps

`@Column timestamp: Date` defaults to PostgreSQL `timestamp without time zone`. For any timestamp that crosses process boundaries (audit logs, event timestamps, createdAt/updatedAt), the correct type is `timestamptz` (`timestamp with time zone`). The `AuditColumnsBootstrapService` in aqua-saas already has a helper `convert-audit-columns-to-timestamptz.helper.ts` — the reviewer must flag any new `Date` column that is not explicitly `timestamptz`.

#### Enum

TypeORM supports two enum representations:
- `@Column({ type: 'enum', enum: Status })` — a real PostgreSQL enum type (requires DDL to add new values)
- `@Column({ type: 'varchar' }) status: Status;` — stored as string, validated at app boundary

PostgreSQL enum types are a production hazard: adding a new value requires `ALTER TYPE ... ADD VALUE`, which works but cannot be rolled back within a transaction in PG versions before 12. The aqua-saas convention should be **varchar + TypeScript union** for new enums unless there is a specific reason to use a real enum.

### Missing `@Index` decorators are the silent perf killer

PostgreSQL will execute any query you ask it to, including a sequential scan across 20M sensor_readings rows. TypeORM's `@Index` decorator is the only way to guarantee an index is present at the entity definition layer. Review rule:

- `tenantId`, `status`, `isActive`, `createdAt`, `deletedAt`, any FK column — these must have `@Index`.
- Composite indexes for multi-column WHERE clauses: `@Index(['tenantId', 'createdAt'])` — order matters.
- Missing `@Index` on a column used in a WHERE clause hot path = **MEDIUM** finding.

### The `synchronize: false` + `migrationsRun: true` pattern

TypeORM supports:
- `synchronize: false` — never auto-apply entity changes.
- `migrationsRun: true` — run pending migrations on DataSource initialization.

These are complementary. The aqua-saas `MigrationRunnerService` runs migrations explicitly on `OnApplicationBootstrap` instead of relying on `migrationsRun: true`, because the platform needs to re-assert `search_path` before each migration (per the 2026-04-07 fix). Both approaches are valid; the explicit runner gives better control.

### The `validateModuleSchemas()` hook

The comment in `schema-manager.service.ts` mentions: *"Call `SchemaManagerService.validateModuleSchemas()` in integration tests to detect drift between this list and the actual entity definitions."* This is the entity-level analogue of `SchemaDriftDetector`. The reviewer must confirm:

1. An integration test exists that calls `validateModuleSchemas()`.
2. The test fails if an entity is added without a corresponding `MODULE_SCHEMAS.tables` entry.
3. The test fails if `MODULE_SCHEMAS.tables` lists a table with no entity.

## Security Concerns

- **`as any` on a JSONB column is a type-system escape.** It allows arbitrary payloads into the DB with no validation. Any production entity that uses `as any` on a JSONB field must be rejected — the correct pattern is an explicit interface or a Zod schema at the DTO boundary.
- **`synchronize: true` in prod is a supply-chain attack surface.** A developer who ships an entity with a malicious `@BeforeInsert` hook can corrupt data on deploy if `synchronize: true` is enabled. The mandate must be hard-coded `synchronize: false`, not `synchronize: env-dependent`.
- **Column type mismatches break RLS.** The 2026-04-07 farm incident: `tenant_id varchar` vs RLS policy `uuid` cast. The RLS policy fails catastrophically — and the fail mode is that the policy errors out, not that it accepts all rows. But a fail mode in an isolation boundary is itself a CRITICAL finding because it takes the service down.
- **Undeclared columns from migrations.** If a migration adds a `secret_key` column but the entity doesn't know about it, `SELECT *` queries still return the column to the application, where it may be logged or exposed via an API.

## Performance Concerns

- **Missing indexes are a production-wide slowness.** aqua-saas has 67+ tables in the farm schema. A missing `@Index` on a `tenantId` column in a large table causes sequential scans on every query — which scale with data growth, not query count.
- **`@Column type: 'numeric'` without a transformer silently corrupts arithmetic.** The `'42.50' + 1 === '42.501'` JavaScript string-concatenation bug is a classic silent corruption. This is a financial-data risk on billing/invoice entities.
- **`JSONB` columns without GIN indexes are a scan.** For sensor readings that store structured JSON, a WHERE clause over a JSON field without `CREATE INDEX ... USING gin (field jsonb_path_ops)` is a full sequential scan.
- **Composite PKs on hypertables must include the partition key.** TimescaleDB hypertables partitioned on `timestamp` require the PK to include `timestamp` — `@PrimaryColumn('uuid') id` alone is invalid on a hypertable.

## Architectural Implications for data-expert reviews

1. **Every entity PR requires a migration PR.** If an entity changes a `@Column`, a migration must exist. The review rule: no entity-only PRs merge. This is a CI check, not a human review check.
2. **The `MODULE_SCHEMAS` registry is a source of truth.** Every entity in a module's `apps/*/src/**/entities/*.entity.ts` must appear in `MODULE_SCHEMAS[module].tables`. The reviewer validates this by hand.
3. **Column type audit on every `@Column` change.** For each new/changed `@Column`, the reviewer confirms: (a) explicit PostgreSQL type (no implicit inference for ambiguous TS types), (b) transformer if numeric/decimal, (c) interface if JSONB, (d) explicit `uuid` for UUIDs, (e) explicit `timestamptz` for timestamps.
4. **Drift detector coverage check.** When a new table is added to `MODULE_SCHEMAS`, the `SchemaDriftDetector` must be aware of it. This is automatic via `MODULE_SCHEMAS.flatMap(m => m.tables)`, but the reviewer confirms the migration runs on all existing tenant schemas via `TenantSchemaSyncService`.
5. **`@Index` decorator audit.** For each new column on a large-ish table, the reviewer verifies whether the column is queried, and flags missing `@Index` as **MEDIUM**.
6. **Reference data tables vs tenant tables.** If a table is shared reference data, it belongs in `MODULE_SCHEMAS[module].referenceDataTables` (copied on provisioning) rather than `tables` (per-tenant schema). Misclassification is a **HIGH** finding.

## Domain Rule Additions for data-expert

- `synchronize: true` in any production `DataSource` configuration (including env-conditional `synchronize: NODE_ENV !== 'production'`) = **CRITICAL**.
- `DataSource.synchronize()` called at runtime outside `SourceSchemaBootstrapService.bootstrapSourceSchema()` = **CRITICAL**.
- `@Column` on a numeric/decimal value without `DecimalTransformer` (or explicit string type) = **HIGH** (silent string-concatenation corruption).
- `@Column` JSONB field typed as `any` / `Record<string, any>` / `object` = **HIGH** (violates CLAUDE.md `as any YASAK`).
- `@Column` UUID field declared as default `string` (implicit `varchar(255)`) instead of explicit `@Column({ type: 'uuid' })` = **HIGH** (RLS cast compatibility risk).
- `@Column` timestamp field using default `Date` (implicit `timestamp without time zone`) instead of explicit `@Column({ type: 'timestamptz' })` for cross-process timestamps = **MEDIUM** (timezone drift).
- Entity added without corresponding `MODULE_SCHEMAS[module].tables` entry = **CRITICAL** (drift-detector blind spot).
- `MODULE_SCHEMAS` table entry with no matching entity = **HIGH** (drift-detector phantom).
- New column on an entity without `@Index` when the column appears in a WHERE clause hot path = **MEDIUM**.
- Migration that changes an entity's column type (e.g., `varchar → uuid`) without a corresponding `@Column` update in the entity = **CRITICAL**.
- Missing integration test that calls `SchemaManagerService.validateModuleSchemas()` for a module = **MEDIUM**.
- PostgreSQL enum `@Column({ type: 'enum' })` added without a documented plan for `ALTER TYPE ... ADD VALUE` migration = **MEDIUM** (prefer varchar + TypeScript union).
