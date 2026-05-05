# Legacy Data Migration Contract Specification

> **Status:** OPEN — design specification only. Implementation requires a
> production backup window + rollback rehearsal that this document does
> NOT schedule. The contract below fixes the migration shape, dry-run
> protocol, observability pre/post-checks, and rollback path that any
> chosen implementation honours.
>
> **Closes (when implemented):** Phase 4.3 of the farm-module plan
>
> **Related:**
> - `apps/farm-service/src/farm/farm.module.ts` (the read-only legacy `Farm` / `Pond` registry)
> - `apps/farm-service/src/database/migrations/1775900000000-ConvergeTenantIdTypesAndDropPondBatch.ts` (precedent for schema convergence with explicit drop loop)
> - PR #203 (FARM-MEDIUM-001) — Phase 1.2 left the legacy `FarmRepository` + read-only query handlers in place pending this migration
> - Orphan-finding-4 (`observability-service` queries `farm.farms` directly) and orphan-finding-5 (`admin-api-service` test references `farm.ponds`)

## Why this contract exists

The farm-module plan's Phase 4.3 calls for migrating data from
the legacy `farm.farms` and `farm.ponds` tables into their
canonical successors:

- `farm.farms (legacy)` → `farm.sites` (Site / Department / System / Tank hierarchy)
- `farm.ponds (legacy)` → `farm.equipment` rows with `is_tank=true`

The hierarchy switch shipped via Phase 1.2 of the plan: write paths
on the legacy tables are `@deprecated` GraphQL stubs that throw
`BadRequestException`; read paths still serve tenants whose data
predates the hierarchy. Phase 4.3 finishes the job by moving every
legacy row into the canonical tables and turning the legacy tables
into read-only views (or dropping them entirely).

This is the highest-stakes migration in the plan. It writes data,
spans tenants, and depends on cross-service consumers
(observability-service, admin-api-service) being updated FIRST. A
contract spec exists to fix the architectural decisions before the
backup window opens, so the operational team isn't making them
under time pressure.

## What this contract specifies

### 1. Pre-migration cross-service updates (gated by this PR's merge)

Two cross-service callers reference the legacy tables today and
MUST be updated before Phase 4.3 lands:

| Caller | Reference | Update |
|---|---|---|
| `apps/observability-service/src/metrics/metrics-aggregator.service.ts:186` | `SELECT count(*) FROM farm.farms WHERE "tenantId" = $1` | Switch to `farm.sites` (orphan-finding-4) |
| `apps/admin-api-service/src/database-management/controllers/__tests__/explorer-sql-security.spec.ts:264` | Test SQL targets `farm.ponds` | Update to a non-deprecated table OR generic negative-security target (orphan-finding-5) |

These updates ship in their own service-specific PRs BEFORE Phase
4.3's data migration runs. The migration's `up()` body asserts both
have landed (greps the source tree at boot time and fails-loud if
the legacy reference is still present) so the operator cannot
accidentally cascade the consumers.

### 2. Migration shape

Single TypeORM migration `V010__migrate_legacy_to_new` (or whatever
timestamp is next in sequence at implementation time):

```typescript
export class MigrateLegacyFarmsAndPondsV010
  implements MigrationInterface
{
  /**
   * Required for IF NOT EXISTS-style idempotency on partial-run
   * resumes. The migration runner's per-tenant fan-out wraps each
   * iteration in a transaction, so we use `transaction = true`
   * (default) — partial failures rollback cleanly and a re-run
   * picks up where it left off via the `migration_log` rowcount
   * checks below.
   */
  public transaction = true;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    // 0. Pre-migration assertion — cross-service callers updated.
    await assertNoLegacyCrossServiceReferences(queryRunner);

    // 1. Open the migration_log for this run.
    const runId = await openMigrationRun(queryRunner, 'V010_legacy_data');

    try {
      // 2. Migrate farms → sites.
      const farmsResult = await migrateFarmsToSites(queryRunner, runId);

      // 3. Migrate ponds → equipment (is_tank=true).
      const pondsResult = await migratePondsToEquipment(queryRunner, runId);

      // 4. Convert legacy tables into read-only views.
      // The view definition selects from a stable snapshot table
      // so post-migration writes to sites/equipment do NOT
      // retro-affect the legacy view's contents.
      await freezeLegacyAsView(queryRunner, 'farms');
      await freezeLegacyAsView(queryRunner, 'ponds');

      // 5. Close the migration_log row with success counts.
      await closeMigrationRun(queryRunner, runId, {
        farmsMigrated: farmsResult.migrated,
        farmsSkipped: farmsResult.skipped,
        pondsMigrated: pondsResult.migrated,
        pondsSkipped: pondsResult.skipped,
      });
    } catch (err) {
      await failMigrationRun(queryRunner, runId, err);
      throw err;
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op with WARN log. See § Rollback below for the rationale.
    this.logger.warn(
      'Legacy migration DOWN is intentionally a no-op. ' +
        'Rollback path is restore-from-backup, not migration:revert.',
    );
  }
}
```

### 3. The `migrateFarmsToSites` mapping

| Legacy `farm.farms` column | Canonical `farm.sites` column | Mapping |
|---|---|---|
| `id (uuid)` | `id (uuid)` | Identity preserve — same UUID stays for cross-reference compatibility |
| `tenantId (uuid)` | `tenantId (uuid)` | Direct |
| `name (varchar)` | `name (varchar)` | Direct |
| `code (varchar)` | `code (varchar)` | Direct (subject to unique-index conflict check below) |
| `address (jsonb)` | `address (jsonb)` | Direct |
| `licenseNumber (varchar)` | `regulatorySettings.organisationNumber` | Schema lift — Site doesn't carry licenseNumber at top-level; the regulatory side owns it |
| `isActive (boolean)` | `isActive (boolean)` | Direct |
| `createdAt / updatedAt` | `createdAt / updatedAt` | Direct |
| (no equivalent) | `siteType (enum)` | DEFAULT `'FARM'` — every legacy farm becomes a Site of type FARM |

**Conflict resolution** when a legacy `farms.code` collides with an
existing `sites.code` for the same tenant:
- The migration logs the conflict with full row details to
  `farm.migration_log_conflicts`.
- The legacy row is SKIPPED, not overwritten.
- Operator review post-migration decides per-row whether to merge
  manually.

This bias is INTENTIONAL: Sites is the canonical model going
forward, and a hand-merge is safer than an automated overwrite.

### 4. The `migratePondsToEquipment` mapping

| Legacy `farm.ponds` column | Canonical `farm.equipment` column | Mapping |
|---|---|---|
| `id` | `id` | Identity preserve |
| `tenantId` | `tenantId` | Direct |
| `name` | `name` | Direct |
| `farmId` | (lookup) `departmentId` | Via the farms→sites identity-preserving migration: `farmId` becomes the `siteId` of a Site whose default Department gets created if missing |
| `volume / area / depth` | `specifications (jsonb)` | Lift to TankSpecifications JSONB |
| `waterType` | `specifications.waterType` | Lift to TankSpecifications |
| `isActive` | `isActive` | Direct |
| (no equivalent) | `equipmentTypeId` | LOOKUP from a global `equipment_types.code = 'POND_LEGACY'` row that the migration creates per-tenant if missing |
| (no equivalent) | `isTank (bool)` | DEFAULT `true` — every pond becomes a tank |

`is_tank=true` is the canonical Phase 1.2 commitment: ponds and
tanks are both `Equipment` rows with `is_tank=true`; the distinction
between physical pond and tank lives in `equipmentTypeId`.

### 5. Pre-flight dry-run mode

The migration ships with a dry-run companion script:

```bash
npm run farm:migrate-legacy:dry-run -- --tenant=<uuid> [--all-tenants]
```

What dry-run does:
- Connects to the same DataSource as production.
- Walks the legacy tables WITHOUT writing.
- Builds the mapping via the same code paths as the real migration.
- Outputs to stdout:
  - Total rows that WOULD migrate.
  - Rows that WOULD skip with the reason (UNIQUE conflict, missing
    parent, malformed data).
  - Estimated runtime (rows × per-row write cost).
  - Memory footprint estimate.

Dry-run is required by the operator runbook before the real
migration runs in production. The migration's `up()` body asserts
that a recent dry-run log exists for the tenant being migrated;
absence fails-loud to prevent a forgotten dry-run.

### 6. Observability pre/post-checks

The operations runbook required at implementation time:

```
PRE-MIGRATION (T-24h)
  - Backup verified via restore-into-staging dress rehearsal
  - Dry-run output captured + reviewed by operations + product
  - Cross-service updates merged AND deployed (orphan-4 + orphan-5)
  - Mattilsynet reporting freeze coordinated (no MIM/Brønnøysund
    submissions during migration window)
  - On-call paged

DURING MIGRATION (T+0 to T+complete)
  - migration_log row stream tailed live in Grafana
  - Application traffic gated to read-only on the legacy paths
    (deprecated stubs already throw; no extra gating needed)

POST-MIGRATION (T+complete to T+24h)
  - Per-tenant rowcount reconciliation: legacy.farms.count ==
    sites.count (modulo conflicts in migration_log_conflicts)
  - Front-end smoke: open the farm-module UI for at least 3
    representative tenants; confirm Sites view renders as expected
  - Observability-service tenant-count metric matches new path
  - Mattilsynet test report regenerates with no errors
  - 24-hour soak before tearing down the rollback rehearsal
    environment
```

### 7. Rollback contract

The `down()` is intentionally a no-op. Rolling back via
`migration:revert` would require:
- Reading the `farm.sites` rows the migration created.
- Re-creating `farm.farms` rows from them (lossy because of the
  schema lift — `licenseNumber` lives in regulatory now).
- Restoring the `farm.farms` table from the frozen view.
- Reversing `migratePondsToEquipment` similarly.

That's a bespoke un-migration, not a `migration:revert` line.

The supported rollback path is **restore-from-backup**:
- Backup taken at T-24h is the rollback target.
- Production traffic on legacy paths is already gated (deprecated
  stubs); no read traffic depends on the new sites/equipment rows
  that get rolled back.
- New writes that landed in `farm.sites` after the backup point
  are LOST in this rollback. The runbook documents this loss
  scenario; the migration is sized to complete in < 4h to
  minimise the at-risk window.

### 8. Per-tenant fan-out vs single-pass

The standard farm-service migration runner fans out per-tenant
(re-runs migrations against every `tenant_<hex16>` schema). This
migration FOLLOWS that pattern — `migrateFarmsToSites` and
`migratePondsToEquipment` query unqualified table names so each
tenant iteration moves only its own legacy data.

Single-pass against the source schema is rejected because:
- The legacy data lives in the per-tenant copies (per the canonical
  schema model from `libs/backend-common/src/database/typeorm-config.factory.ts:68-80`).
- Source-schema rows are templates without tenant data.

## What this contract does NOT specify

Operational decisions that belong in the runbook + the operations
team's review:

- The backup window scheduling.
- The Mattilsynet freeze coordination calendar entry.
- The on-call rotation assignment.
- Whether to run all-tenants in one window or batch by tenant tier.
- Whether legacy tables drop OR stay as read-only views post-migration.
  The contract DEFAULTS to view (frozen snapshot) because it's the
  least destructive outcome that still removes write surfaces. Drop
  is an operator follow-up post 30-day soak.

## Architectural decision: rejected alternatives

| Alternative | Why rejected |
|---|---|
| Big-bang migration in one transaction | Per-tenant fan-out lets one tenant's failure not block the others. A single-transaction migration on a busy database holds locks for hours. |
| Stream-based migration via NATS | Migration is a one-shot operation, not a continuous flow. Streaming adds complexity (idempotency, ordering) without a benefit at the one-shot scale. |
| Soft-delete legacy rows + leave them in place | Preserves the dual-table read surface the plan exists to eliminate. Doesn't close the architectural debt. |
| `down()` as a real reverse migration | Lossy schema-lift makes the inverse mapping incomplete. Restore-from-backup is the canonical rollback path documented by the standing operations playbook. |

## Acceptance criteria (the implementing PR)

- [ ] Migration class lands at the next available timestamp,
      following the `pinSearchPath('farm')` + transaction-true
      pattern of recent farm-service migrations.
- [ ] `apps/farm-service/src/database/services/legacy-migration.
      service.ts` ships with the dry-run entry point + the
      structured logging to `migration_log` + `migration_log_conflicts`.
- [ ] `farm.migration_log` and `farm.migration_log_conflicts`
      tables created by the same migration with the schemas the
      logging code consumes.
- [ ] `npm run farm:migrate-legacy:dry-run` script wired in
      `package.json` + tooling docs.
- [ ] Cross-service callers updated (orphan-4 + orphan-5) AND merged
      AND deployed BEFORE this migration runs in production.
- [ ] Tests cover: identity-preserving migration (UUID round-trip),
      UNIQUE-conflict skip path with conflict-row written,
      idempotent re-run after partial failure, dry-run no-write,
      down() no-op log.
- [ ] Closing PR's commit message carries `Closes: FARM-MEDIUM-012`
      (the tracker finding registered alongside this doc).

## Closure path

When the operational decisions land (backup window scheduled,
Mattilsynet freeze confirmed, on-call assigned) and the implementing
PR ships:

1. The pre-migration cross-service updates land first as their own
   PRs (one for observability-service, one for admin-api-service).
2. The Phase 4.3 implementing PR lands the migration + service +
   tooling.
3. The migration runs in production during the scheduled backup
   window.
4. FARM-MEDIUM-012 (and Phase 4.3) flips to RESOLVED.
5. This document either gets archived as the historical contract
   the migration honoured OR edited inline to record any negotiated
   design changes.
