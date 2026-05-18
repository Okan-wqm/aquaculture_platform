# Baseline Migration Generation Runbook

**Status:** Faz 3 of day-one baseline reset.
**Owner:** database-reviewer + infra-expert (dual-review CODEOWNERS gate).
**Plan reference:** `/root/.claude/plans/peppy-crafting-waterfall.md` Faz 3 + Faz 6.

## Purpose

Generate ONE `1800000000000-Baseline.ts` migration per service from the
current entity surface, replacing every pre-reset migration. After this
runbook executes successfully + the Faz 6 production reset commits the
output, each service ships with a single coherent baseline + a clean
forward-only migration history.

This runbook is the canonical procedure. Hand-rolling baseline
migrations is **forbidden** — reintroduces the drift archaeology class
the reset is designed to eliminate.

## Pre-conditions

- Migration branch `migration` (or PR equivalent) merged through Faz 1 + Faz 2.
- Faz 1 invariants green: protected-tables-guard, no-savepoint-in-migrations, rls-predicate-canonical, entity-schema-declaration, entity-diff-implies-migration, tenant-fanout-entity-parity.
- Local dev Postgres + Redis + NATS up (`npm run infra:up`).
- Empty dev databases — drop and recreate before each service run (the tool's typeorm CLI invocation expects no existing schema).
- All entity files final and reviewed — no pending entity edits during baseline generation (entity-fingerprint manifest contract).

## Generation order

Topological — platform-level services first (no cross-service FK targets in source schema), tenant-scoped services second. Within tier, alphabetical.

**Tier 1: platform-level**
1. admin-api-service (`admin`)
2. auth-service (`auth`)
3. billing-service (`billing`)
4. config-service (`config`)
5. event-store-service (`event_store`)
6. notification-service (`notification`)
7. observability-service (`observability`)

**Tier 2: tenant-scoped**
8. ai-service (`ai`)
9. alert-engine (`alert`)
10. farm-service (`farm`)
11. hr-service (`hr`)
12. hydroponics-service (`hydroponics`)
13. messaging-service (`messaging`)
14. sensor-service (`sensor`)

## Per-service procedure (executed once per service in the order above)

### Step 1 — Archive existing migrations

```bash
# Dry-run first to verify file list:
ts-node scripts/migration/baseline-generator.ts --service <svc> --archive-old

# Apply once dry-run output looks correct:
ts-node scripts/migration/baseline-generator.ts --service <svc> --archive-old --apply
```

Effect: every pre-existing `[0-9]+-*.{ts,sql}` migration file moves to `.archive/<timestamp>/` alongside the original directory. `manifest.ts` is reset to a Baseline-only skeleton.

### Step 2 — Reset dev Postgres for this service's schema

```bash
psql -U postgres -d aquaculture -c "DROP SCHEMA IF EXISTS <schema> CASCADE; CREATE SCHEMA <schema>;"
```

Verify:

```bash
psql -U postgres -d aquaculture -c "\dn"   # confirm <schema> exists and is empty
```

### Step 3 — Generate the baseline

```bash
ts-node scripts/migration/baseline-generator.ts --service <svc> --generate --apply
```

Effect: invokes `npx typeorm migration:generate -d apps/<svc>/src/database/data-source.ts apps/<svc>/src/database/migrations/1800000000000-Baseline` against the empty schema. TypeORM emits the full CREATE TABLE + indexes + FK set derived from entity metadata.

### Step 4 — Hand-author additions (where the generator falls short)

The generator emits standard DDL only. Hand-append these where applicable for the service:

| Concern | Applicable to | What to append |
|---|---|---|
| TimescaleDB hypertable | sensor-service | `await queryRunner.query("SELECT create_hypertable('sensor.sensor_readings', 'time', if_not_exists => true);")` |
| Continuous aggregates | sensor-service, observability-service | `add_continuous_aggregate_policy('view_name', start_offset, end_offset, schedule_interval)` |
| Materialized views | farm-service | `CREATE MATERIALIZED VIEW … WITH NO DATA` + UNIQUE INDEX (CONCURRENTLY refresh prerequisite) |
| RLS policy | all 7 tenant-scoped | `applyTenantRlsToSchema(queryRunner, { schema, tenantIdColumns: ['tenantId','tenant_id'], excludeTables: ['*_outbox','*_audit_logs'] })` |
| Immutability triggers | all services with audit tables | `CREATE TRIGGER trg_<table>_prevent_update BEFORE UPDATE ON … EXECUTE FUNCTION raise_immutability_error()` |
| pgcrypto + uuid-ossp + btree_gist | platform-level (init scripts handle this) | NO action — already in `infrastructure/docker/init-scripts/00-init-schemas.sh` |
| Equipment-type seed | farm-service | INSERT INTO farm.equipment_types VALUES (...) at end of up() — see `apps/farm-service/src/database/migrations/.archive/<ts>/007_seed_equipment_types.sql` for the canonical rows |

### Step 5 — Audit the generated file

```bash
ts-node scripts/migration/baseline-generator.ts --service <svc> --audit
```

The audit checks:
- (a) no naive `ADD COLUMN ... NOT NULL` (must be three-step blue-green)
- (b) every FK declares `ON DELETE RESTRICT ON UPDATE RESTRICT`
- (c) sensor-service includes hypertable + CAGG calls
- (d) tenant-scoped services install RLS policies
- (e) protected tables (audit_logs, payroll_audit, etc.) carry immutability triggers
- (f) Faz 1.4 protected-tables-guard passes (no DROP TABLE on protected names without `-- COMPLIANCE-WAIVER`)

Iterate Step 4 → Step 5 until audit reports zero failures.

### Step 6 — Verify against fresh Postgres replay

```bash
psql -U postgres -d aquaculture -c "DROP SCHEMA IF EXISTS <schema> CASCADE; CREATE SCHEMA <schema>;"
ts-node scripts/migration/baseline-generator.ts --service <svc> --verify
```

The verify mode logs the expected commands; operator runs them manually:

```bash
# 1. Replay the baseline migration against the fresh schema
DB_MIGRATE_AUTHORITATIVE=false npx nx run <svc>:start &  # or aqua-db-migrate container

# 2. Run the relevant invariants
nx test invariants -- --testNamePattern="<svc>|tenant-fanout|entity-schema|protected-tables|rls-predicate"

# 3. Run the bootstrap-from-scratch e2e
nx test e2e -- --testPathPattern="bootstrap-from-scratch"
```

Expected: zero drift class violations, zero RLS predicate violations, zero protected-tables-guard violations, bootstrap-from-scratch green.

### Step 7 — Commit + push

Once Steps 1–6 are green for the service:

```bash
git add apps/<svc>/src/database/migrations/1800000000000-Baseline.ts \
        apps/<svc>/src/database/migrations/manifest.ts \
        apps/<svc>/src/database/migrations/.archive/

git commit -m "feat(<svc>): baseline migration reset (Faz 3)"
git push origin migration
```

## Faz 6 cutover note

Baseline files MUST NOT be committed to `main` until Faz 6 production reset
is staged. Pre-reset, the production database carries the pre-baseline
migration ledger; introducing a single 1800000000000 baseline against
that ledger would mass-fail. Sequence:

1. Faz 1 + Faz 2 + tooling (this runbook + script) merged to `main` → safe to merge ahead of cutover (no production schema impact).
2. Faz 3 baseline files generated locally on `migration` branch (this runbook) → **commits stay on `migration` branch only**.
3. Faz 6 deploy window: production DB reset → init scripts re-run → aqua-db-migrate runs the 14 baselines from `migration` branch → service containers restart → smoke tests → only THEN merge `migration` to `main`.

The merge-to-main commit timing is the cutover atom.

## Rollback

If any service's baseline audit/verify fails irrecoverably:

1. `--archive-old --apply` is reversible — `git checkout` the archived
   files back to their original locations, restore `manifest.ts` from
   git history.
2. Skip the failing service from the Faz 6 cutover batch; address in a
   follow-up reset.
3. CODEOWNERS escalation: database-reviewer + infra-expert convene a
   review session before re-attempting.

## Out of scope for this runbook

- Production data preservation — N/A per Faz 6 operator authorization (test data only).
- Multi-region replica rebuild — single-region assumption documented in plan §Risk Notları.
- Customer SLA notice — N/A per operator authorization (no real customers).

## Sign-off

- [ ] database-reviewer approves the generated baselines (Tier 1)
- [ ] database-reviewer approves the generated baselines (Tier 2)
- [ ] infra-expert approves the cutover sequence
- [ ] Operator schedules the Faz 6 deploy window
