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
