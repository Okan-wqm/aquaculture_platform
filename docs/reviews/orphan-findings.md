# Orphan Findings

Plan-independent real problems uncovered while reading code. See memory
`feedback_orphan_findings_doc.md` for the policy.

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
