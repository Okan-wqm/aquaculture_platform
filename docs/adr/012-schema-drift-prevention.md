# ADR-012: Three-Layer Schema Drift Prevention

**Status:** Accepted (2026-04-14)
**Related:** ADR-011 (Schema ownership model)

## Context

The 2026-04-14 RLS bootstrap incident was triggered by a column-type
drift that had silently existed for weeks: backend-common's
`AuditLogEntity.tenantId` had been declared as `uuid` in the entity
class, but the production DB column was still `text`. The RLS policy
predicate cast `app.current_tenant` to `uuid` for comparison; PostgreSQL
raised `operator does not exist: text = uuid` on every install attempt,
crashing the bootstrap and leaving public.audit_logs unprotected.

This was the second drift-driven incident in three months (the first
being the farm-service `daily_feeding_executions` schema-resolution bug
documented in MigrationRunnerService docblock). Both were caught
reactively in production. Both could have been caught at deploy time
with a five-line check.

## Decision

Establish three independent layers of drift prevention. Each layer
catches the issue at a different lifecycle stage; the layers are
additive, not redundant — each closes a class of regression the others
cannot.

### Layer 1: Commit-time — ESLint rule (deferred to follow-up)

Custom AST rule `tools/eslint-rules/require-entity-schema.ts` rejects
any `@Entity('table_name')` call without an `{ schema: 'X' }` argument
in the same parameter object. Allow-list for system tables (`migrations`
only). Runs on every `git commit` via the project's lint-staged config
and on every PR via the lint CI step.

This is the EARLIEST signal: the developer learns about the missing
`schema:` option before they push, before CI runs, before review.
Status: scoped in plan, deferred for incremental landing — Layers 2+3
provide CI and runtime coverage in the meantime.

### Layer 2: CI-time — schema-invariants integration test

`e2e/tests/integration/schema-invariants.spec.ts` runs against the
test DB on every PR build. Asserts:

  1. `public` schema contains zero application tables (only `migrations`
     allowed via explicit allow-list).
  2. `shared` schema contains exactly the four cross-service tables
     codified in `SHARED_SCHEMA_TABLES`.
  3. Each of the 10 tables moved during P6-P9 lives in its expected
     owning schema (and not in `public`).

Failure messages explicitly tell the developer what to do:
  - "Add `schema: '<owner>'` to the @Entity decorator + write a SET
    SCHEMA migration"
  - "Update SHARED_SCHEMA_TABLES with PR review explaining why
    cross-service ownership is correct"

This is the SAFETY NET: catches anything that bypassed Layer 1 (e.g.,
a developer who wrote SQL outside an entity, or who edited an
@Entity-less raw migration).

### Layer 3: Runtime — schema-drift validator

`createSchemaDriftValidator(serviceName)` from backend-common returns
an `OnApplicationBootstrap` provider. Each service registers it in
`providers[]` (alongside `MigrationRunnerService`). On every cold
start, the validator iterates `dataSource.entityMetadatas` and
cross-checks each entity against `information_schema`:

  - **Schema location:** entity declares `schema: X`, table actually
    lives in `Y` → CRITICAL.
  - **Column type:** entity declares `@Column({ type: 'uuid' })`, DB
    column is `text` or `character varying` → CRITICAL. (This is the
    check that would have caught the 2026-04-14 audit_logs incident.)
  - **Nullability:** entity declares `nullable: false`, DB column
    `is_nullable = 'YES'` → CRITICAL (silent-null risk).

Behaviour controlled by environment variables:

  - `SCHEMA_DRIFT_FATAL=true`  → fail boot on any violation
  - `SCHEMA_DRIFT_FATAL=false` (default) → log + continue
  - `SCHEMA_DRIFT_ENABLED=false` → skip entirely (kill switch)

Recommended rollout: deploy with default (non-fatal) for one cycle to
observe, then flip to FATAL once known violations are reconciled.

The validator is the LAST LINE: catches drift introduced after CI
passes (e.g., manual psql edits, partial migration runs, schema
restored from a stale backup).

### What none of the layers check

- Index presence + shape (TypeORM index naming inconsistencies across
  versions produce false positives; out of scope).
- Constraint definitions (CHECK, UNIQUE — same noise concern).
- Default values (sometimes app-side, sometimes DB-side; ambiguous).

These can be future extensions if a real incident motivates them. The
initial three checks were all directly tied to historical production
incidents — high-signal, zero false-positive in observed cases.

## Consequences

### Positive

- **The 2026-04-14 incident class becomes impossible to recur.** Layer 3
  alone would have caught the audit_logs drift on the next cold start
  after the column type was changed in the entity but not migrated.
- **Layered defense.** A developer who bypasses ESLint via `// eslint-
  disable` still hits CI. A regression that bypasses CI (manual SQL
  on a shared DB) still fires the runtime alert.
- **Operationally observable.** `schema.drift.detected` is a structured
  log marker — Grafana dashboard alerts on its presence are trivial.

### Negative / known costs

- **Validator adds ~50ms to cold start.** One bulk query per entity
  across `pg_tables` + `information_schema.columns`. Acceptable for
  the safety guarantee.
- **CI test requires a DB at integration test time.** Already true for
  the existing `e2e/tests/integration/` suite; no new infrastructure.
- **ESLint rule is deferred.** Layers 2+3 cover the same regressions;
  Layer 1 is purely an ergonomics improvement. Will land as a
  follow-up commit with custom AST rule plus the `tools/eslint-rules/`
  scaffold the project does not yet have.

## Enforcement timeline

  - Now (2026-04-14): Layers 2+3 live. Layer 3 in non-fatal mode.
  - +1 week: Flip Layer 3 to fatal in staging (SCHEMA_DRIFT_FATAL=true)
    after one observation cycle confirms zero false positives.
  - +2 weeks: Flip Layer 3 to fatal in production after staging proves
    stable.
  - +1 month: Land Layer 1 (ESLint rule) once tools/eslint-rules/
    scaffold exists and the rule is unit-tested.

## Wave 4-A.2 update (2026-05-08)

The bootstrap-restoration work (`chore/bootstrap-restoration-2026-05-07`)
extended the three-layer model with two additional gates and brought the
runtime validator under operator-runnable verification.

### Runtime gate now enforced for all 14 services

Post-Wave-5, every service registers `SchemaDriftModule.forRoot({ serviceName })`
in its `app.module.ts`. The factory-reset CLI's `verify-seed` phase now
asserts the canonical schema set is present (auth, farm, sensor, hr,
messaging, hydroponics, alert, billing, notification, ai, admin,
observability, event_store, config, gateway, shared, public — 17 total),
and the `e2e/tests/integration/bootstrap-from-scratch.spec.ts` runtime
drift exercise re-runs `SchemaDriftValidator` against a freshly
bootstrapped DB on every PR build.

The recommendation in the original "Enforcement timeline" stands:
**`SCHEMA_DRIFT_FATAL=true` flips to default once one full observation
cycle (7-day burn-in on staging) confirms zero false positives.** Wave
4-A.2 keeps the default at `false` to absorb the risk of any baseline
shape that drifted during the W4-A.1 → W4-A.2 transition; the default
flip is tracked as a separate finding closed by the staging observation.

### New static gates introduced in Wave 4-A.2

The original ADR scoped Layer 1 to a single ESLint rule
(`require-entity-schema`). Wave 4-A.2 adds two AST-time gates that sit
alongside it under `tools/gates/`:

  - **`tools/gates/schema-drift-registration.ts`** — AST gate that
    asserts every service `app.module.ts` registers
    `SchemaDriftModule.forRoot({ serviceName: '<svc>' })`. Catches the
    "developer added a new service but forgot to wire the validator"
    regression at PR time, before Layer 3 has any opportunity to run.

  - **`tools/gates/migration-deletion-witness.ts`** — deletion guard
    that fails CI if any committed migration file is removed without
    an accompanying `WITNESS:` line in the commit message documenting
    why (e.g. squash-into-baseline, replaced by upcaster). Migration
    deletion is otherwise an architectural smell — once a migration
    has been applied to a real DB it is permanently part of the
    ledger, and removing the file from disk can desync greenfield
    bootstraps.

### Idempotency invariant catalog extended (R6–R12)

`tools/gates/migration-sql-lint.ts` originally enforced R1–R5
(destructive-without-marker, single-step-add-not-null,
create-index-not-concurrent, session-scoped-set-search-path,
overbroad-exception-catch). Wave 4-A.2 adds R6–R12, all of which
target idempotency contracts that the bootstrap-restoration work
validated against the legacy droplet shape:

  - **R6** `create-without-if-not-exists` (HIGH) — `CREATE TABLE`,
    `CREATE INDEX`, `CREATE SEQUENCE`, `CREATE TYPE` without
    `IF NOT EXISTS` cannot run twice; on a partial-rollback retry the
    second run aborts mid-migration.
  - **R7** `drop-without-if-exists` (MEDIUM) — `DROP …` without
    `IF EXISTS` likewise breaks retry semantics.
  - **R8** `insert-without-on-conflict` (MEDIUM) — seed inserts
    without `ON CONFLICT DO NOTHING/UPDATE` re-run badly when the
    migration is re-applied against a partially-seeded table.
  - **R9** `alter-add-column-without-if-not-exists` (HIGH) — same
    class as R6 for ADD COLUMN.
  - **R10** `add-fk-without-not-valid-then-validate` (HIGH) — single-
    statement FK adds on a populated table take an `ACCESS EXCLUSIVE`
    lock for the validation scan; the two-step `NOT VALID` then
    `VALIDATE CONSTRAINT` pattern degrades to `SHARE UPDATE EXCLUSIVE`.
  - **R11** `update-without-where` (CRITICAL) — bare `UPDATE …`
    without a `WHERE` clause is almost always a bug; the gate forces
    the migration author to either narrow the scope or annotate with
    `-- migration-sql-lint: full-table-update intentional`.
  - **R12** `function-without-create-or-replace` (LOW) — `CREATE
    FUNCTION` without `OR REPLACE` cannot be re-applied; downgrade to
    LOW because functions can be safely DROPped in the same migration
    without data loss.

The full R1–R12 set is now the canonical idempotency invariant catalog
for migration SQL across all services. Each service's
`tools/gates/migration-sql-lint.ts` invocation runs the same set; the
catalog is owned by the platform-architecture team and amended via
ADR.

### Cross-reference

The Wave 4-A.2 verifications referenced above are exercised by:

  - `tools/factory-reset/lib/verify-seed.ts` (post-reset DB shape)
  - `tools/factory-reset/lib/verify-tenant-clone.ts` (tenant-clone
    smoke test, optional)
  - `tools/bootstrap-restore/insert-baseline-as-applied.sql` (legacy-
    droplet baseline ledger pre-seed)
  - `e2e/tests/integration/bootstrap-from-scratch.spec.ts` (CI
    runtime drift exercise)
  - `tools/gates/schema-drift-registration.ts` (PR-time AST gate)
  - `tools/gates/migration-deletion-witness.ts` (PR-time deletion
    guard)
  - `tools/gates/migration-sql-lint.ts` (PR-time idempotency catalog
    R1–R12)
