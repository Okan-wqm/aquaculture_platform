# Runbook: Schema Drift Alert Response

When a Grafana alert fires on `schema.drift.detected` (the structured
log marker emitted by `createSchemaDriftValidator` in backend-common),
follow this checklist.

## What the alert means

A backend service detected at cold start that one or more of its
TypeORM `@Entity` declarations no longer matches the live PostgreSQL
schema. Three classes of drift are checked:

  1. **Schema location:** entity declares `schema: X`, table physically
     in `Y`. Caused by an incomplete `SET SCHEMA` migration or by a
     `synchronize: true` run that recreated the table in the wrong
     location.
  2. **Column type:** entity declares `uuid`, DB column is `text` /
     `varchar`. Caused by a migration that changed the entity but not
     the DB. This is the class of drift that broke RLS on 2026-04-14.
  3. **Nullability:** entity declares NOT NULL, DB column is nullable.
     Caused by a column being added with a NULL default but not later
     backfilled + NOT-NULL'd.

## Triage

### Step 1 — read the log line

```
schema.drift.detected service="billing" — 1 violation(s):
  [billing.plans.deleted_at] entity declares NOT NULL but DB column is nullable
```

The violation message identifies:
  - Service name (which service is misaligned)
  - Schema + table (where the drift lives)
  - Column (if column-level)
  - Specific mismatch (uuid vs text, NOT NULL vs nullable, etc.)

### Step 2 — decide direction of correction

Two valid paths depending on intent:

**(a) Migrate DB to match entity** — most common. The entity change
was deliberate (e.g. tightening a nullable column to NOT NULL after a
backfill). Write a migration:

```sql
-- Aligning DB to entity declaration
ALTER TABLE billing.plans
  ALTER COLUMN deleted_at SET NOT NULL;
```

Land it in the service's `apps/<svc>/src/database/migrations/` dir.
The MigrationRunnerService picks it up on next deploy.

**(b) Revert entity change** — sometimes the entity change was
premature (e.g. someone added a column to the entity that's not yet
ready for production). Revert the entity decorator. Fix the migration
plan and reland.

### Step 3 — verify

After the fix lands:

```bash
# Restart the affected service
docker restart aqua-<svc>

# Tail logs for the drift validator's confirmation
docker logs aqua-<svc> -f | grep SchemaDriftValidator
# Expected: "Schema drift scan clean: checked N entities"
```

If the alert persists, `SCHEMA_DRIFT_FATAL=true` would block boot —
useful in staging to catch unfixed drift before production. In
production, prefer the non-fatal mode + alert routing so a single drift
doesn't take down the whole service while you triage.

## Common false-positive scenarios

There are no expected false positives in the validator's three checks
(intentionally so — see ADR-012). If the validator reports a violation,
treat it as real until proven otherwise.

If you discover one (e.g. a postgres data_type alias the validator
doesn't recognise), file a backend-common issue and add a regression
test before patching the validator.

## Out-of-scope checks (intentional)

The validator does NOT check:
  - Index presence / shape (TypeORM index naming inconsistencies =
    false positives)
  - CHECK / UNIQUE constraint definitions
  - Default values

If a missing index in production is causing pain, add it as a
migration — drift validator is not the right surface for "perf
regressions" caused by index absence.
