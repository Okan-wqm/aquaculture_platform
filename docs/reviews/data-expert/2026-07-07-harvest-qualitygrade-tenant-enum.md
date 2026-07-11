# 2026-07-07 - DropHarvestQualityGrade tenant-clone shared-enum DROP TYPE outage

## DATA-CRITICAL-001 - farm migration DROP TYPE of a tenant-shared enum aborts db-migrate -> total production outage

**Severity:** CRITICAL. **Owner:** data-expert. **State:** closed by this PR.

### What happened
The farm migration `apps/farm-service/src/database/migrations/1804300000000-DropHarvestQualityGrade.ts`
dropped the `qualityGrade` column AND the `harvest_records_qualitygrade_enum` type
(unqualified) in `up()`. In production it aborted `db-migrate` with
`cannot drop type harvest_records_qualitygrade_enum because other objects depend on it`.
Every backend service in `docker-compose.droplet.yml` gates on
`depends_on: db-migrate -> service_completed_successfully`, so a non-zero
db-migrate exit meant NO service container could start -> total outage. The site
was kept up only by an emergency `docker compose up -d --no-deps <services>` that
bypassed the failed db-migrate gate.

### Root cause (confirmed - live DB + code trace)
1. `harvest_records_qualitygrade_enum` is a SINGLE `farm`-schema enum, hard-qualified
   in `1800000000000-Baseline.ts:297-298`.
2. Tenant schemas are cloned with `CREATE TABLE ... LIKE ... INCLUDING ALL`
   (`libs/backend-common/src/database/tenant-schema-sync.service.ts:48`). pg `LIKE`
   copies the column but does NOT clone the enum type, so every tenant
   `harvest_records.qualityGrade` cross-references the one farm enum. (Verified live:
   the type exists only in `farm`; the tenant column's type schema is `farm`.)
3. db-migrate fan-out is source-first (`apps/db-migrate/src/main.ts:1107`), tenants
   after (`:1141-1149`), aborting on source failure (`:1193-1203`). The farm-pass
   `DROP TYPE` fails while every tenant clone still references the shared enum; the
   type can also only be seen in the farm pass (a tenant pass's unqualified
   `DROP TYPE IF EXISTS` is a no-op). No per-schema fan-out can express "drop one
   shared object after all N+1 references are gone".

### Fix
- `1804300000000.up()` now drops only the COLUMN (fans out correctly across
  farm + every tenant clone) and LEAVES the now-orphaned, unused farm enum -
  the established forward-only stance. Corrected in place under the
  `MIGRATION-IMMUTABLE-OK:` waiver because the migration aborted transactionally,
  wrote no ledger row, and re-aborts ahead of any later corrective migration.
- New CI invariant `tests/invariants/no-unguarded-drop-type-in-migration.spec.ts`
  bans an unguarded `DROP TYPE` in the `up()` of any tenant-aware migration.

### Latent sibling (flagged, not fixed here - not ours / not merged)
`1801310000000-DropFeedInventoryCreateConvergedView.ts:133` does
`DROP TYPE feed_inventory_status_enum` in `up()` on the same farm-shared enum
pattern. It is untracked WIP (not on main, not deployed), so it is not the active
outage; its author must fix it before it ships. The new invariant fails it at CI.

### Rule violated
CLAUDE.md "Every fix is an architectural root-cause fix" + ADR-011/012 tenant schema
routing/drift - a source-schema catalog drop that ignores tenant-clone cross-references.
