# Orphan Findings

Plan-independent real problems uncovered while reading code. See memory
`feedback_orphan_findings_doc.md` for the policy.

## DEPLOY-CRITICAL-004 — nullability + uuid drift survives first-phase HR heal, blocks SchemaDriftValidator clean signal

**Status:** RESOLVED — fixed by the commit that introduced this entry.

**Scope:** `apps/hr-service/src/database/migrations/1787000000000-HealHrNullabilityDrift.ts`
plus every tenant clone created from the `hr` source schema.

**Symptom (deploy 11 on d943f605, 2026-04-21 04:17 UTC):**

```
##[error]Missing boot signals:
  [hr-service] "Schema drift scan clean" — SchemaDriftValidator found zero violations (ADR-012)
--- Round 30/30: 1 signal(s) pending ---
```

HealHrEnumTypeDrift1786900000000 ran clean (65 heal queries applied on
source hr + 5 tenant clones, DROPped IDX_emp_cert_expiry + leave_no_overlap),
db-migrate exit 0, every container healthy, service-criticality check
green. But the hr-service boot-signal asserter timed out after 30 × 10 s
rounds — signal name only revealed at round 30, confirming HR was still
the blocker.

**Root cause** (confirmed by three parallel code reads of
`libs/backend-common/src/database/schema-drift-validator.service.ts`,
`scripts/deploy/assert-service-signals.ts`, and every service's signal
emit-site):

SchemaDriftValidator checks three drift classes (lines 195–252):

  1. Schema location (entity schema=hr, DB table in hr)
  2. UUID-type mismatch: `entity.type === 'uuid' && dbColumn.data_type !== 'uuid'` (line 237)
  3. Nullability mismatch: `!column.isNullable && dbColumn.is_nullable === 'YES'` (line 247)

HealHrEnumTypeDrift's whitelist kept CREATE TYPE / CREATE TABLE /
ADD COLUMN IF NOT EXISTS / ALTER COLUMN <any sub-action>. Two gaps:

- `ADD COLUMN IF NOT EXISTS "x" type NOT NULL DEFAULT ...` is a no-op
  when the column already exists — the pre-existing nullable column's
  nullability is NEVER updated. TypeORM `log()` does not reliably
  emit a standalone `ALTER COLUMN SET NOT NULL` for this diff class;
  the debug dump from d943f605 confirmed no SET NOT NULL statements
  in the 65 applied queries.
- UUID-type mismatch for pre-existing columns is emitted by log()
  only under specific conditions TypeORM's schema-builder uses; not
  guaranteed to cover every case.

`SCHEMA_DRIFT_FATAL=false` (default) means drift logs `error()` but
continues boot — container stays healthy, but the "clean" signal
string never emits, so the asserter times out.

**Fix** (Tier-1 entity-metadata iteration, not a log()-diff whitelist):

1. `apps/hr-service/src/database/migrations/1787000000000-HealHrNullabilityDrift.ts`
   iterates `conn.entityMetadatas` filtered to `schema === 'hr'` and for
   every column compares `information_schema.columns` to the entity
   declaration. Emits exactly the two statements the validator contract
   requires when drift is present:
   - `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${col}" SET NOT NULL`
   - `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${col}" TYPE uuid USING "${col}"::text::uuid`

2. Empty-table precondition preserved (SET NOT NULL / TYPE uuid fail on
   dirty rows). Non-empty tables raise — operator must hand-author
   data-preserving ALTERs for those.

3. Per-tenant fan-out with identical guard + iteration.

4. `down()` no-op: rolling back would re-introduce the drift and break
   hr-service boot.

**Why this is the correct final fix for HR drift:**

SchemaDriftValidator checks EXACTLY three drift classes. Class (1) was
covered by first-phase heal. This migration explicitly covers classes
(2) and (3) by direct entity-metadata iteration — no dependence on
whether TypeORM `log()` happens to emit the right DDL for pre-existing
columns. Post-migration, `violations.length === 0` → validator emits
"Schema drift scan clean" → asserter substring-match succeeds within
round 1–5 → deploy green.

**Verification:** The CI-Affected → deploy run on this commit will
show `aqua-db-migrate` applying `HealHrNullabilityDrift1787000000000`
(pending count = 1 under hr schema), the per-schema log lines reporting
`[hr] validator-contract heal: N SET NOT NULL, M TYPE uuid, ...`, and
the boot-signal assertion passing within one round of the 30-round
window.

## DEPLOY-CRITICAL-003 — partial-index WHERE predicate blocks ALTER COLUMN TYPE

**Status:** RESOLVED — fixed by the commit that introduced this entry.

**Scope:** `apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts`
plus every tenant clone created from the `hr` source schema.

**Symptom (deploy 7, 2026-04-20 18:11 UTC):**

```
aqua-db-migrate | Migration failed — schema: hr, migration: SyncHrEntitiesToDb1786800000000
  error: operator does not exist: employee_certifications_status_enum = certification_status
```

Deploy 8 (2026-04-20 18:32 UTC) introduced commit `5df00179` which wrapped
every `log()`-emitted statement in `SAVEPOINT / ROLLBACK TO SAVEPOINT` so
the failing `ALTER COLUMN TYPE` was silently skipped and the migration
exited 0. That shifted the failure downstream: SchemaDriftValidator at
hr-service boot observed the old enum column, never emitted the
`Schema drift scan clean` required-signals invariant, the boot-signal
assertion timed out after 30 rounds (7.5 min), and the deploy rolled
back.

**Root cause:** `hr.employee_certifications` carries a legacy partial
index whose WHERE predicate casts a literal to the column's OLD enum
type:

```sql
CREATE INDEX "IDX_emp_cert_expiry"
  ON "hr"."employee_certifications" ("tenant_id", "expiry_date")
  WHERE (status = 'active'::hr.certification_status);
```

When `ALTER COLUMN status TYPE hr.employee_certifications_status_enum`
runs, PostgreSQL re-validates the predicate against the new enum. PG
has no implicit equality operator between two distinct enum types, so
the ALTER aborts. `RdbmsSchemaBuilder.log()` cannot emit a preceding
`DROP INDEX` because the index was created outside the current entity
model (legacy, hand-authored DDL).

**Fix (Tier-1 "make it impossible"):**

1. `libs/backend-common/src/database/base-migration.ts` —
   `parseAlterColumnTypeTargets()` + `dropDependentPartialIndexes()`.
   Parses the up-queries that `log()` emits, queries `pg_indexes` for
   partial indexes whose WHERE predicate references any of the target
   columns, and DROPs them explicitly.
2. `apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts`
   calls the helper BEFORE the apply loop (source hr + every tenant
   clone) and removes the SAVEPOINT-per-statement band-aid. The apply
   loop is deterministic again: any failure escapes to the
   orchestrator and rolls back the migration transaction.
3. Legacy indexes the current entity model does not declare stay
   dropped — correct end-state under ADR-012's entity-first schema
   contract. Indexes the entity DOES declare are re-created by
   TypeORM's own `CREATE INDEX` emissions in the same migration pass.

**Unit test:** `libs/backend-common/src/database/__tests__/base-migration.spec.ts`
covers: (a) parse extracts only TYPE changes, not SET NOT NULL /
DEFAULT adjustments; (b) drop matches only partial indexes whose
predicate references the target column by whole-word; (c) substring
collisions (`status` vs `status_extended`) do not false-positive;
(d) unsafe identifiers throw.

**Verification:** GitHub Actions `CI - Affected → deploy / deploy`
pipeline on the commit that introduced this entry — aqua-db-migrate
logs `applied <N> validator-relevant catch-up queries` with no
SAVEPOINT rollback, HR boot emits `Schema drift scan clean`, deploy
completes green without rollback.
