# Scope A — Legacy Data Migration + Orphan Entity Cleanup (2026-04-24)

**Canonical repo:** `/var/aqua-saas`
**Active illustrator worktree:** `/tmp/aqua-main-illustrator` (pinned to `main`)
**Target:** farm-service (NestJS + TypeORM + PostgreSQL per-tenant schemas)

---

## 0. Architectural framing discovered during exploration

Three facts from the codebase that change how this plan is structured:

1. **Data does NOT live in `farm.*` for tenants.** The `farm` schema is a TEMPLATE. Real tenant rows live in `tenant_<hex16>.farms`, `tenant_<hex16>.ponds`, `tenant_<hex16>.sites`, `tenant_<hex16>.tanks`. Provisioning uses `CREATE TABLE LIKE farm.<t> INCLUDING ALL`. (`libs/backend-common/src/database/schema-manager.service.ts:660–745`, module entry at `:141–303`.)
2. **`farms` and `ponds` are REGISTERED as live tables in `MODULE_SCHEMAS[farm].tables`** (lines 191, 194). The strictOwnership enforcer at `SourceSchemaBootstrapService` treats them as legitimate, so we cannot just delete them at source — we must remove from the registry in the same commit that drops them from tenant schemas, or boot will fail with an "expected table missing" (INFRA-CRITICAL-009 pattern).
3. **`supplier_sites` and `site_contacts` tables do NOT exist in any environment provisioned after the `1775900000000-ConvergeTenantIdTypesAndDropPondBatch` migration landed.** They are excluded from `MODULE_SCHEMAS[farm].tables` with an explicit comment (`schema-manager.service.ts:257–270`) invoking `INFRA-CRITICAL-019`. The only way they could physically exist is on a very old environment where pre-convergence `synchronize: true` created them in `public.*` — and that migration's phase-1 drop loop already handles that case. On any tenant schema, they have never been created. This is load-bearing for the Scope 2 decision.

Cross-service callers are already off `farm.farms`/`farm.ponds`: `observability-service/metrics-aggregator.service.ts:184` reads `farm.sites`, `admin-api-service/.../explorer-sql-security.spec.ts:265–266` uses the table only as a "legacy exemption" example. No live service ingests from those two legacy tables.

---

## 1. Investigation tasks (BEFORE writing a single line of code)

Run these in order. Each produces evidence that pins a design decision.

### 1.1 Confirm legacy-data existence across tenants

```
Goal: know how many tenants actually have rows in tenant_<hex>.farms / .ponds.
Commands (read-only, run from a psql attached to the prod-parity replica):
  SELECT schema_name FROM information_schema.schemata
  WHERE schema_name ~ '^tenant_[a-f0-9]{16}$' ORDER BY schema_name;
  -- Then for each schema, run a COUNT(*) against farms and ponds.
Expected evidence: a CSV {schema_name, farms_row_count, ponds_row_count}.
Store the CSV in: docs/reviews/farm-legacy-migration/2026-04-23-inventory.csv
```

This CSV is the authoritative input to every later phase. If it's all zeros on every tenant, Scope 1 collapses to "drop-and-retire" with no data migration at all.

### 1.2 FK-column audit across farm-service entities

Already partially done in this exploration. The `pondId` columns that exist:

- `batch/entities/batch-location.entity.ts:127–129` (nullable uuid, FK commented out)
- `batch/entities/mortality-record.entity.ts:164`
- `feeding/entities/feeding-record.entity.ts:152`
- `harvest/entities/harvest-record.entity.ts:300`
- `water-quality/entities/water-quality-measurement.entity.ts:213`
- `growth/entities/growth-measurement.entity.ts` (via DTO ref — confirm in file)

No entity has an ENFORCED FK at DB level to `ponds.id`; all are nullable uuid columns with the `@ManyToOne` commented out. There is **also no `farmId` column on any non-farm entity**, only on `ponds` itself. This means the legacy drop does not cascade through FK constraints — but we still need a decision on what `pondId` values point to in surviving rows.

**Verify the "FK commented out" assertion**: grep the entity files for any `@ManyToOne.*Pond` that is NOT commented out. If none, the FK-rewrite step in Phase 4.3 is a no-op.

```
grep -rn "@ManyToOne.*Pond\|@JoinColumn.*pondId" apps/farm-service/src --include="*.ts" \
  | grep -v "//" | grep -v __tests__
```

Expected: 0 hits. If >0, that entity needs a cutover to `tankId` before the legacy drop.

### 1.3 Illustrator-doc verdict for Scope 2

Already gathered:
- `docs/illustrator/farm-modulu-sema-gorsel.md:610` — CreateSupplier form documents `input.approvedSites[]` → `supplier_sites` (N rows).
- `docs/illustrator/farm-modulu-sema-gorsel.md:1281–1282` — `farm.supplier_sites` schema is fully documented.
- `docs/illustrator/farm-modulu-sema-gorsel.md:854` — SiteFormModal writes `farm.site_contacts`.
- `docs/illustrator/farm-modulu-sema-gorsel.md:1344–1345` — `farm.site_contacts` schema is fully documented.

The active frontend SiteFormModal and SuppliersTab surfaces in `web/modules/farm-module/src/pages/setup/tabs/` almost certainly have form fields for these — verify:

```
grep -rn "approvedSites\|siteContacts\|contact" web/modules/farm-module/src/pages/setup/tabs/SuppliersTab.tsx web/modules/farm-module/src/pages/setup/tabs/SitesTab.tsx web/modules/farm-module/src/pages/setup/modals/SiteFormModal.tsx web/modules/farm-module/src/pages/setup/modals/SupplierFormModal.tsx
```

**Expected evidence to decide Scope 2 A/B:**
- If the frontend has form inputs for these fields → WIRE (option B). The form is silently discarding user input today.
- If the frontend only renders the read-side of these relationships → WIRE read-side only, drop write-side. Still option B, narrower.
- If no frontend surface touches these at all → DROP (option A).

### 1.4 MODULE_SCHEMAS ownership audit

Confirm that removing `'farms'` and `'ponds'` from `MODULE_SCHEMAS[farm].tables` does not break other invariants:

```
grep -rn "'farms'\|\"farms\"" libs/backend-common --include="*.ts" | grep -v test | grep -v spec
grep -rn "'ponds'\|\"ponds\"" libs/backend-common --include="*.ts" | grep -v test | grep -v spec
```

Also check: `tests/invariants/module-schemas-inventory.spec.ts` or similar — any test that asserts a minimum count of farm tables.

### 1.5 Outbox event taxonomy

Confirm the canonical event name for data migrations already exists, or we need to create one:

```
grep -rn "DataMigrationCompleted\|LegacyTableDropped\|LegacyDataMigrated" \
  libs/platform/event-contracts/src libs/backend-common/src \
  --include="*.ts"
```

If none exists, Phase 4.3.0 must introduce `LegacyFarmDataMigrated` and `LegacyFarmTableConverted` contracts.

### 1.6 pg_dump baseline harness

Locate the existing backup path:

```
find tools/scripts/database -name "*.sh" | head
cat tools/scripts/database/backup-databases.sh  (reference pattern from INFRA-HIGH-003)
```

This is the canonical backup surface. The Scope 1 plan reuses it — does not invent a new one.

---

## 2. Scope 2 decision — WIRE the entities, don't drop

**Decision: Option B (WIRE).**

Evidence (collected in 1.3 above):
- `farm-modulu-sema-gorsel.md:610` explicitly lists `input.approvedSites[]` as a field on `createSupplier`. The illustrator is the canonical business-domain spec and it treats these tables as REQUIRED for supplier-site approval and site-contact management.
- Full column definitions are documented at `:1281–1282` and `:1344–1345`.
- `supplier_sites` appears in the ER diagram (`:201`, `:206`) as a first-class junction.
- The frontend form surfaces very likely collect this data today and silently discard it (confirm in 1.3).

Dropping these tables would create a spec-implementation gap where the illustrator promises a surface that the code never delivered. That is not a data-hygiene win — it is a documentation-reality mismatch that future work will have to re-solve.

The **INFRA-CRITICAL-019 note** in `schema-manager.service.ts:257–270` does NOT argue for dropping; it argues for "only list ACTIVE tables, not orphan @Entity declarations." Once we wire the entities into a module + add the migration + register them in `MODULE_SCHEMAS`, they become active and the comment's directive is satisfied.

---

## 3. Phases

Numbering continues from the existing "kalan kör noktalar" plan (phase 4.3 is pre-assigned to Scope 1; Scope 2 becomes phase 4.4).

### Phase 4.3.0 — Event contracts + inventory (read-only, no production risk)

**Goal:** Define the event taxonomy and collect the tenant-by-tenant inventory of legacy rows.

**Files touched:**
- `libs/platform/event-contracts/src/farm/legacy-farm-data-migrated.event.ts` (new)
- `libs/platform/event-contracts/src/farm/legacy-farm-table-converted.event.ts` (new)
- `libs/platform/event-contracts/src/farm/index.ts` (export)
- `libs/platform/event-contracts/__tests__/farm/legacy-farm-events.spec.ts` (new — Zod contract test)
- `docs/reviews/farm-legacy-migration/2026-04-23-inventory.csv` (new — evidence artefact)
- `docs/reviews/farm-legacy-migration/2026-04-23-plan.md` (new — planning artefact)

**Validation:** Zod schemas cover every field; parse round-trip test with representative payload. No DB writes.
**Audit:** The inventory CSV is the audit record. Commit message carries `Closes FARM-DATAMIG-001`.
**Test:** Contract test as above; no integration test needed (events not yet emitted).
**Risk:** None — read-only exploration + type definitions.
**Rollback:** Revert commit.
**Approx:** 1 PR, ~150 LOC (2 event classes, 1 test, 2 docs).

### Phase 4.3.1 — Dry-run migration CLI

**Goal:** Land a NestJS standalone CLI that iterates `listTenantSchemas()` and reports, per tenant, how many `farms`/`ponds` rows WOULD be migrated and what new `sites`/`tanks` mapping would result — with ZERO writes.

**Files touched:**
- `apps/farm-service/src/cli/migrate-legacy-farm/migrate-legacy-farm.command.ts` (new — nest-commander `@Command({ name: 'migrate-legacy-farm' })`)
- `apps/farm-service/src/cli/migrate-legacy-farm/migrate-legacy-farm.module.ts` (new)
- `apps/farm-service/src/cli/migrate-legacy-farm/legacy-farm-mapper.ts` (new — pure-function mapping: `Farm → Site` and `Pond → Tank`)
- `apps/farm-service/src/cli/cli.main.ts` (new — CommandFactory bootstrap)
- `apps/farm-service/src/cli/__tests__/legacy-farm-mapper.spec.ts` (new — property-based tests covering every column)
- `apps/farm-service/src/cli/__tests__/migrate-legacy-farm.command.spec.ts` (new — mock DataSource, assert no INSERT/UPDATE issued in --dry-run)
- `apps/farm-service/project.json` (add `migrate-legacy-farm` executable target)
- `docs/runbooks/farm-legacy-migration.md` (new)

**CLI surface:**
```
farm-service migrate-legacy-farm --dry-run [--tenant <uuid>] [--batch 500]
farm-service migrate-legacy-farm --execute --tenant <uuid> [--batch 500]
farm-service migrate-legacy-farm --execute --all [--batch 500] [--yes]
```

**Column mapping (documented in `legacy-farm-mapper.ts` and the runbook):**

| legacy `farms` column   | new `sites` column                            | notes                                                          |
|-------------------------|-----------------------------------------------|----------------------------------------------------------------|
| `id`                    | `id`                                          | **PRESERVE** — see ID-strategy below                           |
| `tenantId`              | `tenantId`                                    |                                                                |
| `name`                  | `name`                                        |                                                                |
| `location.lat/lng`      | `location.latitude/longitude`                 | jsonb reshape                                                  |
| `address`               | `address.street` (parsed) OR leave as `notes` | address on `sites` is jsonb; best-effort single-line → `notes` |
| `contactPerson/Phone/Email` | `contactPhone`, `contactEmail`, plus derived `site_contacts` row if name present | person name goes to `site_contacts.name` (Scope 2 WIRE)        |
| `description`           | `description`                                 |                                                                |
| `totalArea`             | `areaM2` (× 10000 for ha→m²)                  | documented unit conversion                                     |
| `isActive`              | `isActive`                                    |                                                                |
| `createdAt/updatedAt/createdBy/updatedBy` | same                          |                                                                |
| `version`               | `version`                                     |                                                                |
| **(required on new)**   | `code` (required, unique per tenant)          | **GENERATED**: `LEGACY-${name.slice(0,15).toUpperCase()}-${shortId}`, uniqueness-safe |
| **(required on new)**   | `type` (enum `SiteType`)                      | default `LAND_BASED` unless name contains "deniz"/"cage" keyword |
| **(required on new)**   | `status` (enum `SiteStatus`)                  | derive from `isActive`: true → `ACTIVE`, false → `INACTIVE`    |
| **(required on new)**   | `timezone`                                    | default `'UTC'` — tenant-level timezone lookup not available here |

| legacy `ponds` column   | new `tanks` column                                     | notes                                                                 |
|-------------------------|--------------------------------------------------------|-----------------------------------------------------------------------|
| `id`                    | `id`                                                   | **PRESERVE**                                                          |
| `tenantId`              | `tenantId`                                             |                                                                       |
| `farmId`                | `departmentId` (REQUIRED on tanks)                     | **PROBLEM**: tanks require departmentId, but legacy ponds have farmId. Mapping step creates one `Department` per migrated site, named `"{site.name} — Default Department"`, then sets departmentId to that |
| `name`                  | `name`                                                 |                                                                       |
| `capacity`              | `volume`                                               |                                                                       |
| `depth`                 | `depth`                                                |                                                                       |
| `surfaceArea`           | derive `length=sqrt(area)`, `width=sqrt(area)` for SQUARE | documented lossy mapping; `length/width=NULL` + tankType=OTHER if user prefers no derivation |
| `waterType`             | `waterType`                                            |                                                                       |
| `status`                | mapping: ACTIVE→ACTIVE, MAINTENANCE→MAINTENANCE, INACTIVE→INACTIVE, PREPARING→PREPARING | identity                          |
| `isActive`              | `isActive`                                             |                                                                       |
| `createdAt/By`          | same                                                   |                                                                       |
| **(required on new)**   | `code` (required, unique per tenant)                   | **GENERATED**: `LEGACY-TANK-${shortId}`                                |
| **(required on new)**   | `tankType`                                             | default `OTHER` (safe, not assumed)                                   |
| **(required on new)**   | `material`                                             | default `FIBERGLASS` (most common), documented as an assumption        |
| **(required on new)**   | `maxBiomass`                                           | default `0` (unknown)                                                  |
| **(required on new)**   | `maxDensity`                                           | default `30` (entity default)                                          |
| (none on legacy)        | `systemId`                                             | NULL — migrated tanks attach to department only                       |

**ID strategy decision: PRESERVE legacy `id`.** Rationale:

- Surviving `pondId` columns on `batch_locations`, `mortality_records`, `feeding_records`, `harvest_records`, `water_quality_measurements`, `growth_measurements` point at legacy `ponds.id`. Generating fresh UUIDs would require a lookup table and a second pass to rewrite every one of those columns — a full order of magnitude more risk.
- Preserving IDs lets us introduce a trigger/VIEW (Phase 4.3.3) that makes `legacy.ponds.id` still resolvable via `tanks.id` post-cutover.
- Collision risk: fresh `sites.id` / `tanks.id` are `gen_random_uuid()`-generated. A UUID collision between an existing site and a legacy farm is cryptographically negligible. We still add a pre-flight check: `SELECT COUNT(*) FROM sites WHERE id IN (SELECT id FROM farms)` and abort if >0 per tenant.

**Null-column handling rules (documented in `legacy-farm-mapper.ts`):**
1. If legacy column has value AND new column exists → copy.
2. If legacy column has value AND new column does NOT exist → write to `metadata` JSONB as `{ "legacy_${columnName}": value }`. Nothing is silently dropped.
3. If new column is REQUIRED and legacy has no natural source → use the documented default in the table above. Every default is explicit.
4. If new column is nullable and no legacy source → leave NULL.

**Batch/transaction size:** 500 rows per transaction per table per tenant. Rationale: at 500 rows × ~50 columns × ~200 bytes avg = ~5MB per batch, well under Postgres statement memory limits. Per-tenant transactions (not global) so a failure on tenant N doesn't roll back tenants 1..N-1.

**Idempotency:** Every INSERT is `INSERT ... ON CONFLICT (id) DO NOTHING`. A re-run on a partially-migrated tenant is safe — rows already in `sites` / `tanks` are skipped.

**Validation:** `--dry-run` is the validation. It prints per-tenant: "would migrate X farms → sites, Y ponds → tanks, Z conflicts (existing sites/tanks with same id)". Exit code 1 on ANY conflict.
**Audit:** Every `--execute` run writes one `LegacyFarmDataMigrated` outbox event per tenant with counts + timestamp + operator identity (from `$USER` env if CLI, must-supply `--operator-id` flag in prod).
**Test:** unit (mapper), integration (CLI against testcontainer Postgres with seeded legacy rows, asserting new rows match via property tests), e2e (CLI against a multi-tenant staging fixture).
**Risk:** HIGH if someone runs `--execute` against prod without staging dry-run first. Mitigation: `--execute` REQUIRES `--yes` AND requires `FARM_MIGRATION_OPERATOR_ID` env var AND writes a confirmation line to a tamper-evident log file before starting.
**Rollback:** Since `--execute` only ever INSERTs (never UPDATEs, never DROPs — Phase 4.3.2 drops), rollback is `DELETE FROM sites WHERE id IN (SELECT id FROM farms); DELETE FROM tanks WHERE id IN (SELECT id FROM ponds);` per tenant. The CLI ships with a `--rollback <tenant>` subcommand that issues exactly this DELETE in one transaction per tenant.
**Approx:** 3 PRs, ~1,200 LOC total (CLI + mapper + unit tests + integration tests + runbook).

### Phase 4.3.2 — Execute migration on staging, then prod (operational phase, no code changes)

**Goal:** Actually run the migration on real data, starting with staging.

**Files touched:** none (operational phase).
**Process:**
1. `pg_dump` of every tenant schema via the existing `tools/scripts/database/backup-databases.sh` — store artefacts in the canonical backup bucket with `pre-farm-legacy-migration-<timestamp>` tag.
2. On staging: `farm-service migrate-legacy-farm --dry-run --all` → review the inventory.
3. On staging: `farm-service migrate-legacy-farm --execute --tenant <canary-tenant>` for one tenant. Verify with targeted SELECTs.
4. On staging: `farm-service migrate-legacy-farm --execute --all`. Re-run tests that exercise the Site/Tank surface against staging.
5. 7-day soak on staging.
6. On prod: repeat 1–3 with the smallest tenant as canary.
7. On prod: `--execute --all`.
**Validation:** post-run assertion query per tenant: `SELECT COUNT(*) FROM farms = SELECT COUNT(*) FROM sites WHERE id IN (SELECT id FROM farms)` and the analogous for ponds/tanks.
**Audit:** Outbox events (one per tenant per table) land in the `farm_outbox` table and are published via NATS. Retained 90 days (see `AddDomainRetentionFunctions1787000000000`).
**Test:** staging soak tests. No new unit tests this phase (CLI ones already cover it).
**Risk:** HIGH. Mitigation: canary-tenant-first, backup-first, staging-soak.
**Rollback:** `--rollback` subcommand from Phase 4.3.1, or `pg_restore` from the phase-1 backup if the migration is catastrophic.
**Approx:** 0 LOC, 1 PR-equivalent runbook entry.

### Phase 4.3.3 — Legacy tables → read-only VIEWs

**Goal:** Convert `farm.farms` and `farm.ponds` from TABLEs to VIEWs that project from `sites`/`tanks`, so any surviving read-side caller (e.g. a cached query in a sister service we missed) doesn't 500.

**Files touched:**
- `database/migrations/modules/farm/V006__farm_pond_compat_views.sql` (new — declarative SQL)
- `apps/farm-service/src/database/migrations/1788000000000-ReplaceFarmsPondsWithCompatViews.ts` (new — programmatic TypeORM migration that runs the conversion per-tenant schema)
- `apps/farm-service/src/farm/entities/farm.entity.ts` (edit — remove `@ObjectType` / mark `@Entity({ ... , synchronize: false })`, add comment pointing at the view)
- `apps/farm-service/src/farm/entities/pond.entity.ts` (edit — same)
- `libs/backend-common/src/database/schema-manager.service.ts` (edit — remove `'farms'` and `'ponds'` from `MODULE_SCHEMAS[farm].tables`, add them to a new optional field `compatViews: readonly string[]` that `SourceSchemaBootstrapService` must treat as legitimate-but-not-a-table)
- `libs/backend-common/src/database/source-schema-bootstrap.service.ts` (edit — teach `dropOrphanTables` to recognize VIEWs in `compatViews` as not-orphan)
- `libs/backend-common/__tests__/schema-manager.service.spec.ts` (edit — assert farms/ponds not in `tables`, are in `compatViews`, and that bootstrap does not drop them)

**View definition (inside the TypeORM migration, executed per tenant schema):**
```
DROP TABLE IF EXISTS "<tenant_schema>"."farms" CASCADE;
CREATE VIEW "<tenant_schema>"."farms" AS
  SELECT id, tenant_id AS "tenantId", name, ... FROM "<tenant_schema>"."sites";
-- analogous for ponds → tanks
```

**CASCADE safety:** The `DROP TABLE ... CASCADE` removes any FK pointing at `farms.id`/`ponds.id`. We already asserted in 1.2 that no entity has a DB-enforced FK to these tables — only nullable `pondId` columns with commented-out TypeORM relations. So CASCADE touches nothing.

**Validation:** The TypeORM migration runs a `SELECT COUNT(*) FROM farms` post-view-creation per tenant and asserts it equals the pre-migration count. Also emits `LegacyFarmTableConverted` outbox event per tenant with `{ table: 'farms', rowCount }`.
**Audit:** Outbox events + migration ledger row.
**Test:** integration test that provisions a tenant schema with seeded legacy rows, runs the migration, asserts `farms`-as-view returns same rows.
**Risk:** MEDIUM — if a service we missed writes to `farm.farms`, it will fail with "cannot insert into view" on the next deploy. Mitigation: `SET search_path` check + 7-day staging soak + full-repo grep `INSERT INTO.*farms` in phase 1.5 (investigation).
**Rollback:** `DROP VIEW farms; CREATE TABLE farms (LIKE sites INCLUDING ALL);` + `INSERT INTO farms SELECT ... FROM sites` — documented in the migration's `down()`.
**Approx:** 2 PRs, ~600 LOC (SQL + TypeORM migration + entity edits + schema-manager changes + tests).

### Phase 4.3.4 — Read-handler retirement (post-soak)

**Goal:** Delete `GetFarmHandler`, `ListFarmsHandler`, `GetPondHandler`, their queries, the resolver mutations, and the entity files themselves. By this point, 90 days have passed since Phase 4.3.3, and anyone still calling `farm`/`farms`/`pond` queries has had a full quarter to migrate.

**Files touched (all deletions except last):**
- `apps/farm-service/src/farm/query-handlers/get-farm.handler.ts` (delete)
- `apps/farm-service/src/farm/query-handlers/list-farms.handler.ts` (delete)
- `apps/farm-service/src/farm/query-handlers/get-pond.handler.ts` (delete)
- `apps/farm-service/src/farm/queries/*.query.ts` (delete all three)
- `apps/farm-service/src/farm/entities/farm.entity.ts` (delete)
- `apps/farm-service/src/farm/entities/pond.entity.ts` (delete — this is the canonical definition of `WaterType` enum, so we move the enum definition to `tank.entity.ts` and update the re-export)
- `apps/farm-service/src/farm/resolvers/farm.resolver.ts` (delete — the `@deprecated` mutations go with it)
- `apps/farm-service/src/farm/dto/create-farm.input.ts` + `create-pond.input.ts` (delete)
- `apps/farm-service/src/farm/farm.module.ts` (shrink to pure aggregation or delete; only if no leaf entities remain)
- `apps/farm-service/src/tank/entities/tank.entity.ts` (edit — move `WaterType` enum definition here, drop the `import … from '../../farm/entities/pond.entity'`)
- Every file importing `WaterType` from `pond.entity` (update import path — ~15 files per the earlier grep)

**Validation:** The final `SELECT COUNT(*) FROM tenant_<any>.farms` → use a post-migration query checker to assert these are still VIEWs and still return the migrated row counts.
**Audit:** `git log --stat` of the PR.
**Test:** Full farm-service integration suite must pass. GraphQL schema diff must be published so API clients see what went away.
**Risk:** LOW — all reads have had 90 days to migrate.
**Rollback:** revert commit.
**Approx:** 1 PR, ~-1,500 LOC net (lots of deletions, some imports updated).

### Phase 4.3.5 — Drop the VIEWs (final cutover)

**Goal:** Drop `farms`/`ponds` VIEWs from every tenant schema and from `farm.*`. Remove the `compatViews` field from `MODULE_SCHEMAS[farm]`.

**Files touched:**
- `apps/farm-service/src/database/migrations/<timestamp>-DropFarmsPondsCompatViews.ts` (new)
- `database/migrations/modules/farm/V007__drop_farm_pond_compat_views.sql` (new)
- `libs/backend-common/src/database/schema-manager.service.ts` (edit — remove `compatViews`)

**Validation:** post-migration assert `EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = <tenant> AND table_name IN ('farms','ponds'))` returns false for every tenant.
**Audit:** outbox `LegacyFarmTableConverted` with `{ table: 'farms', phase: 'dropped' }`.
**Test:** integration test provisions a tenant, runs all migrations up to this one, asserts views do not exist.
**Risk:** LOW if phase 4.3.4 held through two deploy cycles.
**Rollback:** the `down()` of the migration recreates the views from `sites`/`tanks`.
**Approx:** 1 PR, ~250 LOC.

---

### Phase 4.4 — Orphan entity cleanup (Scope 2, WIRE option)

#### Phase 4.4.1 — Declarative SQL for the two tables

**Goal:** Create `farm.supplier_sites` and `farm.site_contacts` as proper module-owned tables, mirroring the documented column list in `docs/illustrator/farm-modulu-sema-gorsel.md:1281,1344`.

**Files touched:**
- `database/migrations/modules/farm/V008__add_supplier_sites_and_site_contacts.sql` (new)
- `apps/farm-service/src/database/migrations/<timestamp>-WireSupplierSitesAndSiteContacts.ts` (new — programmatic migration that creates the tables in every tenant schema using `CREATE TABLE LIKE farm.<table> INCLUDING ALL`)
- `libs/backend-common/src/database/schema-manager.service.ts` (edit — remove the INFRA-CRITICAL-019 comment, add `'supplier_sites'` and `'site_contacts'` to `MODULE_SCHEMAS[farm].tables`)

**Schema (mirrors the documented illustrator spec and the existing entity files):**
```sql
CREATE TABLE farm.supplier_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  supplier_id UUID NOT NULL REFERENCES farm.suppliers(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES farm.sites(id) ON DELETE CASCADE,
  is_preferred BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  UNIQUE (supplier_id, site_id)
);
CREATE INDEX ... -- matching entity's @Index decorators

CREATE TABLE farm.site_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES farm.sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(100),
  email VARCHAR(150),
  phone VARCHAR(50),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);
CREATE INDEX ... -- matching entity
-- Partial unique: only one primary contact per site
CREATE UNIQUE INDEX site_contacts_one_primary ON farm.site_contacts (site_id)
  WHERE is_primary = true;
```

**Validation:** migration-lint gate (`tools/gates/migration-sql-lint.ts`) + schema-snapshot-diff (`tools/gates/schema-snapshot-diff.ts`) pass.
**Audit:** migration ledger + per-tenant outbox event `TenantSchemaExtended { tables: ['supplier_sites','site_contacts'] }`.
**Test:** integration test against testcontainer — provision tenant, run migration, assert tables exist and honor constraints.
**Risk:** LOW — no data being moved, only DDL additions.
**Rollback:** migration `down()` drops both tables.
**Approx:** 1 PR, ~400 LOC.

#### Phase 4.4.2 — SupplierSite CRUD surface

**Goal:** Wire `SupplierSite` into `SupplierModule` with create/update/delete + listing and a setSupplierApprovedSites batch mutation matching the illustrator spec's `approvedSites[]` surface.

**Files touched:**
- `apps/farm-service/src/supplier/entities/supplier-site.entity.ts` (edit — remove the "Orphan entity" TODO comment, wire the `@ManyToOne` targets as string refs to avoid circular import)
- `apps/farm-service/src/supplier/entities/supplier.entity.ts` (edit — uncomment the `@OneToMany(() => SupplierSite, …)` relation)
- `apps/farm-service/src/supplier/commands/set-supplier-approved-sites.command.ts` (new — takes `supplierId`, `siteIds[]`, `preferredSiteId?`)
- `apps/farm-service/src/supplier/handlers/set-supplier-approved-sites.handler.ts` (new — transactional: delete existing rows for supplier, insert new ones, emit `SupplierApprovedSitesChanged` outbox event via `OutboxPublisher.enqueue(event, queryRunner.manager)`)
- `apps/farm-service/src/supplier/queries/list-supplier-sites.query.ts` + handler (new)
- `apps/farm-service/src/supplier/dto/supplier-site.response.ts` (new — GraphQL type)
- `apps/farm-service/src/supplier/dto/create-supplier.input.ts` (edit — add `approvedSiteIds?: string[]`, `preferredSiteId?: string`)
- `apps/farm-service/src/supplier/dto/update-supplier.input.ts` (edit — same)
- `apps/farm-service/src/supplier/handlers/create-supplier.handler.ts` (edit — if `approvedSiteIds` present, dispatch the set-approved-sites command inside the same QueryRunner transaction)
- `apps/farm-service/src/supplier/handlers/update-supplier.handler.ts` (edit — same)
- `apps/farm-service/src/supplier/supplier.resolver.ts` (edit — add `setSupplierApprovedSites` mutation + `supplierSites` query + field resolver `@ResolveField() approvedSites`)
- `apps/farm-service/src/supplier/supplier.module.ts` (edit — add `SupplierSite` to `TypeOrmModule.forFeature(...)`, register the new handlers)
- `libs/platform/event-contracts/src/farm/supplier-approved-sites-changed.event.ts` (new)
- `apps/farm-service/src/supplier/__tests__/handlers/set-supplier-approved-sites.handler.spec.ts` (new)
- `apps/farm-service/src/supplier/__tests__/supplier.resolver.spec.ts` (edit — add cases for approvedSites round-trip)
- `e2e/farm-service/supplier-sites.e2e.spec.ts` (new — full GraphQL → DB round trip)

**Authz matrix entry:** `setSupplierApprovedSites` → `TENANT_ADMIN, MODULE_MANAGER` (matches existing `createSupplier`).
**Validation:** `approvedSiteIds` every entry is a valid site belonging to the same tenant. The handler pre-validates all IDs in one `WHERE id = ANY($1) AND tenantId = $2` query, throws `BadRequestException` if any don't resolve — no partial writes.
**Audit:** `SupplierApprovedSitesChanged` outbox event carries `{ supplierId, previousSiteIds, newSiteIds, operator }`.
**Test:** unit (handler), integration (resolver + DB), e2e (full GraphQL). **Additionally** — front-end contract test in `web/modules/farm-module/src/pages/setup/tabs/__tests__/SuppliersTab.spec.tsx` asserting the form's `approvedSites[]` field maps to the new input argument.
**Risk:** MEDIUM — we are introducing a write surface for a table whose frontend form may have been silently discarding input. First prod deploy should enable an observability metric `supplier_sites_write_rate` that we monitor for anomaly.
**Rollback:** revert commit. Tables remain (they are now in `MODULE_SCHEMAS`); they simply have no writers again.
**Approx:** 2 PRs, ~1,100 LOC.

#### Phase 4.4.3 — SiteContact CRUD surface

**Goal:** Wire `SiteContact` into `SiteModule` with create/update/delete + listing; integrate with `CreateSite` / `UpdateSite` handlers so contacts can be created in one round-trip (matching `docs/illustrator/farm-modulu-sema-gorsel.md:854` SiteFormModal behaviour).

**Files touched:** (symmetric to 4.4.2 but on SiteModule)
- `apps/farm-service/src/site/entities/site-contact.entity.ts` (edit — remove TODO comment)
- `apps/farm-service/src/site/entities/site.entity.ts` (edit — uncomment `@OneToMany(() => SiteContact, ...)` relation at line 316–317)
- `apps/farm-service/src/site/commands/upsert-site-contacts.command.ts` (new)
- `apps/farm-service/src/site/handlers/upsert-site-contacts.handler.ts` (new — handles the `one primary per site` partial-unique constraint correctly)
- `apps/farm-service/src/site/queries/list-site-contacts.query.ts` + handler (new)
- `apps/farm-service/src/site/dto/site-contact.response.ts` (new)
- `apps/farm-service/src/site/dto/create-site.input.ts` (edit — add `contacts?: SiteContactInput[]`)
- `apps/farm-service/src/site/dto/update-site.input.ts` (edit — same)
- `apps/farm-service/src/site/handlers/create-site.handler.ts` (edit — accept and insert contacts transactionally)
- `apps/farm-service/src/site/handlers/update-site.handler.ts` (edit — same; full replace semantics)
- `apps/farm-service/src/site/site.resolver.ts` (edit — mutations + field resolver)
- `apps/farm-service/src/site/site.module.ts` (edit — add `SiteContact` to `forFeature`, register handlers)
- `libs/platform/event-contracts/src/farm/site-contacts-changed.event.ts` (new)
- Tests: unit + integration + e2e + frontend contract test in `SiteFormModal.spec.tsx`.

**Validation:** at most one contact per site has `isPrimary=true` (enforced by partial unique index AND by handler pre-check for clearer error message). Email validated as RFC-5321. Phone validated as E.164-ish (loose — contacts may be local numbers).
**Audit:** `SiteContactsChanged` outbox event carries before/after contact lists.
**Test:** as 4.4.2.
**Risk:** LOW — same pattern as 4.4.2, smaller blast radius (site contacts are informational, not transactional).
**Rollback:** revert commit.
**Approx:** 2 PRs, ~900 LOC.

---

## 4. Pre-registered findings

Propose these new finding IDs for each phase to close:

| ID                   | Severity | Title                                                                                     | Closed by phase |
|----------------------|----------|-------------------------------------------------------------------------------------------|-----------------|
| FARM-DATAMIG-001     | HIGH     | Legacy `farm.farms` / `farm.ponds` tables still written-by-noone but readable-by-resolvers, blocking cleanup of the Farm/Pond GraphQL surface | 4.3.0 + 4.3.1   |
| FARM-DATAMIG-002     | HIGH     | No dry-run tooling exists to assess per-tenant migration impact for the farms/ponds → sites/tanks cutover | 4.3.1           |
| FARM-DATAMIG-003     | CRITICAL | Legacy farms/ponds rows surviving in production tenants risk divergent reads between legacy and canonical hierarchies | 4.3.2           |
| FARM-DATAMIG-004     | MEDIUM   | `farm.farms` and `farm.ponds` are TABLEs rather than VIEWs, allowing accidental writes post-cutover | 4.3.3           |
| FARM-DATAMIG-005     | MEDIUM   | `FarmModule` registers dead query handlers (`GetFarmHandler`, `ListFarmsHandler`, `GetPondHandler`) after cutover | 4.3.4           |
| FARM-DATAMIG-006     | LOW      | Legacy compat VIEWs still present after full client migration, reducing schema clarity   | 4.3.5           |
| FARM-ORPHAN-001      | HIGH     | `SupplierSite` entity declared as @Entity but not registered in any module, never migrated to DB — spec-implementation gap with illustrator's `approvedSites[]` | 4.4.1 + 4.4.2   |
| FARM-ORPHAN-002      | HIGH     | `SiteContact` entity declared as @Entity but not registered in any module, never migrated to DB — SiteFormModal contact fields silently discarded | 4.4.1 + 4.4.3   |
| FARM-ORPHAN-003      | MEDIUM   | `INFRA-CRITICAL-019` comment in `schema-manager.service.ts:257–270` documents orphan entities as permanent tech debt without a resolution deadline | 4.4.1 (fully)   |

Each phase's closing commit message carries `Closes <FINDING-ID>` footer. The `tools/gates/finding-registry.ts close <id> <sha>` runs in a follow-up commit or in the same commit via the post-commit hook depending on the current repo convention (confirm in investigation 1.5).

---

## 5. Sequencing

```
Phase 4.3.0  (inventory + event contracts)
    ↓
Phase 4.3.1  (dry-run CLI + unit tests)
    ↓
Phase 4.3.2  (staging soak → prod execute)  ← OPERATIONAL GATE: 7-day soak
    ↓
Phase 4.3.3  (tables → VIEWs)               ← PRODUCTION DEPLOY GATE: 2 release cycles after 4.3.2
    ↓ (90-day retention window per user's standing rule)
Phase 4.3.4  (remove read handlers + entities)
    ↓ (2 release cycles)
Phase 4.3.5  (drop VIEWs)

Phase 4.4.1  (supplier_sites + site_contacts DDL) — PARALLEL with 4.3.0 (independent surfaces)
    ↓
Phase 4.4.2  (SupplierSite wiring) — requires 4.4.1
Phase 4.4.3  (SiteContact wiring)  — requires 4.4.1, parallel with 4.4.2
```

**Critical dependency:** 4.3.1 MUST complete before 4.3.2 (can't execute without dry-run tooling). 4.3.3 MUST NOT run until 4.3.2's soak period expires. 4.4.1 is a clean standalone migration and can land independently of Scope 1.

---

## 6. Open questions (need explicit user answer before Phase 4.3.1 starts)

### Q1 — `totalArea` unit conversion for legacy farms → sites

Legacy `farms.totalArea` is documented as "in hectares" (entity comment line 78). New `sites.areaM2` is explicitly m². The conversion factor is 10,000.

- **A.** Multiply by 10,000 on migration. Pros: preserves semantic value. Cons: assumes every legacy row actually used hectares (no runtime validation was ever done).
- **B.** Leave as raw number + move to `metadata.legacy_totalAreaRaw` + set `areaM2 = NULL`. Pros: no wrong assumption. Cons: users lose the number from the UI until someone manually migrates each tenant.

**Recommendation:** A, with a one-line note in the outbox event payload documenting the assumption per-row.

### Q2 — Synthetic `Department` per legacy farm

New `tanks.departmentId` is REQUIRED (entity line 233). Legacy ponds don't have one.

- **A.** Create a synthetic `Department` row per migrated Site, named `"${site.name} — Default"`, code `DFLT-${legacyFarmIdShort}`. Every migrated tank points at this department.
- **B.** Migrate each farm's site but NOT its ponds-as-tanks — leave the ponds in the legacy VIEW only. Sites get migrated, tanks don't.

**Recommendation:** A. Otherwise the `pondId` columns on batch_locations etc. become permanently orphaned.

### Q3 — Scope 2 frontend reality check

Before Phase 4.4.2/4.4.3 start, a 30-minute frontend audit of `SuppliersTab.tsx`, `SupplierFormModal.tsx`, `SitesTab.tsx`, `SiteFormModal.tsx` must confirm that form inputs for `approvedSites[]` / site contacts actually exist.

- **A.** Inputs exist → proceed with WIRE (the plan above).
- **B.** Inputs do NOT exist → downgrade to "backend surface only, no UI work" and reopen the decision. Still WIRE the entities (illustrator spec is binding) but separate the API-surface PR from UI wiring.

**Recommendation:** the planner who executes this plan does investigation 1.3 FIRST; if the answer is B, Phase 4.4.2/4.4.3 split into "API only" + "UI wiring" follow-ons.

### Q4 — Which git worktree to execute in

- `/var/aqua-saas` is canonical.
- `/tmp/aqua-main-illustrator` is pinned to `main` for active illustrator work.

Scope 1 touches production-critical migration infrastructure (`libs/backend-common/src/database/schema-manager.service.ts`). Scope 2 touches `SupplierModule` and `SiteModule`. Both feel like they should live on `main`, so:

- **A.** Both scopes execute in `/tmp/aqua-main-illustrator` as sequential branches off `main`.
- **B.** Scope 1 executes on `/var/aqua-saas` (canonical); Scope 2 executes on `/tmp/aqua-main-illustrator`.

**Recommendation:** A. Single-branch discipline, avoids cross-worktree rebase conflicts.

### Q5 — Emit per-row outbox events, or one aggregate per tenant?

Scope 1's migration could emit one `FarmMigrated` event per legacy row OR one `LegacyFarmDataMigrated` event per tenant with counts.

- **A.** One per row. Downstream services can replay per-row. Outbox table grows by ~N_tenants × N_rows rows during migration.
- **B.** One per tenant. Outbox grows by ~N_tenants rows. Replay is coarser.

**Recommendation:** B. The event is audit, not replay. No downstream service needs per-row granularity (cross-service callers are already off these tables).

---

## 7. Critical Files for Implementation

Files the next session must re-read first to execute this plan:

- `/var/aqua-saas/libs/backend-common/src/database/schema-manager.service.ts` (lines 141–303 — the farm MODULE_SCHEMAS entry and the `createTenantSchema` flow; modifying `tables[]` is load-bearing for Phase 4.3.3 and 4.4.1)
- `/var/aqua-saas/apps/farm-service/src/database/migrations/1775900000000-ConvergeTenantIdTypesAndDropPondBatch.ts` (the canonical template for a defensive, idempotent, per-schema migration; Phase 4.3.3 and 4.4.1 both follow this pattern)
- `/var/aqua-saas/apps/farm-service/src/farm/farm.module.ts` + `/var/aqua-saas/apps/farm-service/src/farm/resolvers/farm.resolver.ts` (the legacy surface being retired — the comments in both files are the spec for which read/write paths must still work through 4.3.3 and must NOT work after 4.3.4)
- `/var/aqua-saas/apps/farm-service/src/supplier/supplier.resolver.ts` + `/var/aqua-saas/apps/farm-service/src/site/site.resolver.ts` (the two surfaces that gain new mutations in 4.4.2/4.4.3; existing handlers are the pattern to copy)
- `/var/aqua-saas/docs/illustrator/farm-modulu-sema-gorsel.md` (the binding business spec — lines 610, 854, 1281, 1344 justify Scope 2 WIRE; any deviation from the columns listed there for `supplier_sites`/`site_contacts` needs explicit sign-off)
