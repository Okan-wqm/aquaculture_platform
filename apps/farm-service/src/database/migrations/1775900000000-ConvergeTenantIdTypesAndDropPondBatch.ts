import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * ConvergeTenantIdTypesAndDropPondBatch1775900000000
 * ============================================================================
 *
 * Schema-convergence migration that runs IMMEDIATELY BEFORE
 * `EnableRowLevelSecurity1776000000000` so that migration can finally
 * complete on environments whose schemas accumulated drift from
 * multiple revisions of the entity layer.
 *
 * # The three drift classes this migration cleans up
 *
 * ## 1. Public-schema duplicates (the 2026-04-07 production incident)
 *
 * Production databases provisioned before the source-schema model
 * existed had every farm-module table created in the `public`
 * schema by an early `synchronize: true` deploy. A later deploy
 * introduced `SourceSchemaBootstrapService` which created a parallel
 * copy of every table under the `farm` schema. Both sets of tables
 * persisted.
 *
 * On every production deploy from 2026-04-07 09:38Z through 16:43Z,
 * farm-service's `MigrationRunnerService` drew a pool connection
 * whose search_path had been contaminated to `public` by some
 * earlier rogue code path. The resulting migration run targeted
 * `public.*` tables and crashed `EnableRowLevelSecurity1776000000000`
 * with `operator does not exist: text = uuid` because the stale
 * public-schema tables still had varchar tenantId columns from
 * their pre-refactor synchronize creation.
 *
 * Commit d257fd69 (Phase 11.1) fixed the pool-layer root cause by
 * making `TenantConnectionBootstrap` re-assert the default
 * search_path on every non-request checkout. Commit 5554fb8f
 * (Phase 11.2) added a defensive `SET search_path` at the top of
 * the RLS migration itself. This commit (Phase 11.3) fixes the
 * **data** side of the problem: it drops every `public.*`
 * duplicate of a farm-module table so that even a discovery query
 * that somehow ended up in `public` would find nothing to complain
 * about.
 *
 * Safety: every drop is `IF EXISTS CASCADE`, so the migration is a
 * no-op on fresh environments (where the public duplicates never
 * existed) and idempotent on re-runs. CASCADE removes any RLS
 * policies, indexes, or foreign-key references still attached to
 * the dead tables.
 *
 * The drop list is derived from `MODULE_SCHEMAS[farm].tables` in
 * `libs/backend-common/src/database/schema-manager.service.ts` —
 * i.e. the canonical inventory of tables the farm service owns.
 * Tables NOT in that list are untouched, so cross-module drops
 * are impossible even if some unrelated module happens to also
 * own a table named e.g. `equipment` in `public`.
 *
 * ## 2. Varchar-typed `tenantId` columns (should be uuid)
 *
 * Three entities (`farm`, `pond`, `worker`) declared
 * `@Column() tenantId: string` with no explicit type, which TypeORM
 * synchronizes as **varchar**. The rest of the platform — 40+ farm-
 * service entities, every other service, the canonical RLS helper at
 * `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts` —
 * uses `@Column('uuid')`. Commit 67f57eac fixed the entity decorators
 * so new environments synchronize the columns as uuid from the
 * start. This migration handles existing production databases whose
 * synchronize had already created them as varchar: it reads the
 * column's current type from `information_schema.columns` and runs
 * `ALTER TABLE … ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid`
 * only when the column is still text/varchar.
 *
 * Idempotent at the database layer — re-runs against an already-uuid
 * column do nothing. The `USING "tenantId"::uuid` cast fails LOUD on
 * any non-canonical value, which is the correct signal for genuine
 * data corruption (application layer only ever wrote uuids).
 *
 * ## 3. Orphaned `batches` table from the removed PondBatch entity
 *
 * The parallel `PondBatch` entity (backed by the `batches` table)
 * was removed in commit b5bcec3c. Its table still exists in every
 * production environment where an earlier synchronize had created it.
 * Drop phase 1 (public) handles the `public.batches` duplicate; the
 * explicit drop below handles the `farm.batches` copy. Both are
 * covered by the registry-driven drop loop since `'batches'` is
 * still listed in `MODULE_SCHEMAS[farm].tables` — the registry
 * entry is scheduled for removal in Phase 11.4 but must remain here
 * until this migration has run so the drop loop still discovers it.
 *
 * # Ordering
 *
 * Timestamp 1775900000000 sits intentionally between
 * `1775000000000-AddFeederFieldsToExecution` and
 * `1776000000000-EnableRowLevelSecurity` so the convergence work runs
 * RIGHT BEFORE RLS installation. Registering this migration in the
 * class-ref `migrations: [...]` array in
 * `farm-service/src/app.module.ts` in that same position is required
 * — TypeORM's migration runner orders by the timestamp embedded in
 * the class name, but the class-ref import order in the array is
 * the authoritative source for NX/webpack bundles, so both must
 * agree.
 *
 * # Rollback
 *
 * `down()` is intentionally a no-op that logs a warning. Rolling
 * back would require re-narrowing uuid columns to varchar, re-
 * creating the deleted batches table, and resurrecting every
 * `public.*` duplicate that was dropped — all actively harmful
 * to the post-fix schema. Operators who need to rewind should use
 * the backup/restore path, not `migration:revert`.
 */
export class ConvergeTenantIdTypesAndDropPondBatch1775900000000
  implements MigrationInterface
{
  name = 'ConvergeTenantIdTypesAndDropPondBatch1775900000000';
  private readonly logger = new MigrationLogger(this.name);

  /**
   * Every table name the farm-service module owns, per
   * `MODULE_SCHEMAS[farm].tables` in
   * `libs/backend-common/src/database/schema-manager.service.ts`.
   * Inlined here instead of imported to keep the migration
   * self-contained (migrations must not pull runtime module deps).
   *
   * Any of these tables that exist in the `public` schema are
   * duplicates of the canonical `farm.*` copy and get dropped by
   * the phase-1 loop below. Fresh environments never had them, so
   * the drop is a no-op there.
   */
  private readonly farmTables: readonly string[] = [
    // Core entities
    'farms',
    'sites',
    'departments',
    'ponds',
    'tanks',
    'tank_allocations',
    'tank_batches',
    'tank_operations',
    // Batch management — `batches` is the dead PondBatch table,
    // `batches_v2` is the current Batch entity's table
    'batches',
    'batches_v2',
    'batch_documents',
    'batch_feed_assignments',
    'batch_locations',
    'species',
    // Equipment hierarchy
    'systems',
    'sub_systems',
    'equipment_types',
    'equipment',
    'equipment_systems',
    'sub_equipment_types',
    'sub_equipment',
    'feeder_calibrations',
    // Maintenance
    'maintenance_schedules',
    'work_orders',
    'spare_parts',
    // Feed management
    'feed_types',
    'feed_type_species',
    'feeds',
    'feed_inventory',
    'feed_sites',
    'feeding_protocols',
    'feeding_records',
    'feeding_tables',
    'feeding_programs',
    'feeding_program_tanks',
    'daily_feeding_executions',
    // Chemical management
    'chemical_types',
    'chemicals',
    'chemical_sites',
    // Production tracking
    'growth_measurements',
    'mortality_records',
    'water_quality_measurements',
    'water_quality_parameter_configs',
    'water_quality_param_equipment',
    'health_events',
    'harvest_plans',
    'harvest_records',
    // Suppliers
    'supplier_types',
    'suppliers',
    'supplier_sites',
    // Site contacts
    'site_contacts',
    // Supporting tables
    'code_sequences',
    'farm_audit_logs',
    // Storage & stock management
    'storage_locations',
    'consumables',
    'storage_inventory',
    'stock_movements',
    'purchase_orders',
    'purchase_order_items',
    'inventory_counts',
    'inventory_count_items',
    // Regulatory settings
    'regulatory_settings',
    'sentinel_hub_settings',
    // Weather & marine observations
    'weather_observations',
    'marine_observations',
    'weather_settings',
    // Task management & automation
    'tasks',
    'auto_rules',
    'recurring_templates',
    // Workers
    'farm_workers',
  ];

  /**
   * Tables whose `tenantId` column must be uuid after this migration.
   * Only the three varchar-drifting entities need remediation; every
   * other table in the schema already has uuid tenantId either from
   * its entity decorator or from an earlier migration.
   */
  private readonly tablesToConverge: readonly string[] = [
    'farms',
    'ponds',
    'workers',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 0. Pin the search_path BEFORE any catalog work ──────────────────
    // Defensive belt-and-suspenders for the Phase 11.1 pool-level fix —
    // guarantees `current_schema()` returns `farm` inside every helper
    // query below, even if this migration is ever run from a context
    // where `TenantConnectionBootstrap` is not installed (test harness,
    // ad-hoc repair, new service variant). Same pattern as
    // AddPurchaseOrders1772000000000, AddRegulatorySettings1769000000000.
    await queryRunner.query(`SET search_path TO "farm", public`);

    // ── 1. Drop duplicate farm-module tables from the `public` schema ───
    // These are leftovers from a pre-SourceSchemaBootstrap era where an
    // initial `synchronize: true` deploy created the whole farm schema
    // inside `public`. Every drop is IF EXISTS CASCADE so the phase
    // is a no-op on fresh environments.
    const publicDuplicates = await this.discoverPublicDuplicates(queryRunner);
    if (publicDuplicates.length === 0) {
      this.logger.log(
        'No public-schema duplicates of farm-module tables found — nothing to drop. Either this is a fresh environment or a previous run of this migration already cleaned them up.',
      );
    } else {
      this.logger.log(
        `Found ${publicDuplicates.length} public-schema duplicate(s) of farm-module tables: ${publicDuplicates.join(', ')}. Dropping with CASCADE to remove any attached RLS policies, indexes, and foreign keys.`,
      );
      for (const table of publicDuplicates) {
        await queryRunner.query(`DROP TABLE IF EXISTS "public"."${table}" CASCADE`);
        this.logger.log(`Dropped public."${table}"`);
      }
      this.logger.log(
        `Dropped ${publicDuplicates.length} public-schema duplicate table(s). RLS migration will no longer discover them.`,
      );
    }

    // ── 2. Drop the dead `farm.batches` table (from removed PondBatch) ──
    const farmBatchesExists = await this.tableExists(queryRunner, 'batches');
    if (farmBatchesExists) {
      this.logger.log(
        'Dropping legacy "farm.batches" table (owned by the removed PondBatch entity). CASCADE removes any attached RLS policies and indexes.',
      );
      await queryRunner.query(`DROP TABLE IF EXISTS "farm"."batches" CASCADE`);
    } else {
      this.logger.log(
        '"farm.batches" table not present in this environment — nothing to drop. Fresh deployments will never create it since the entity has been removed.',
      );
    }

    // ── 3. Converge varchar tenantId columns to uuid in farm schema ─────
    for (const table of this.tablesToConverge) {
      const tenantIdType = await this.columnType(queryRunner, table, 'tenantId');

      if (tenantIdType === null) {
        this.logger.log(
          `Skipping "${table}": table or column does not exist in this environment. Fresh synchronize will create it as uuid from the entity decorator.`,
        );
        continue;
      }

      if (tenantIdType === 'uuid') {
        this.logger.log(
          `Skipping "${table}": "tenantId" already uuid — nothing to converge.`,
        );
        continue;
      }

      if (tenantIdType !== 'character varying' && tenantIdType !== 'text') {
        throw new Error(
          `[${this.name}] Unexpected tenantId type "${tenantIdType}" on table "${table}". ` +
            `Expected 'uuid', 'character varying', or 'text'. Aborting before running ALTER to avoid corrupting non-canonical data.`,
        );
      }

      this.logger.log(
        `Converging "${table}"."tenantId" from ${tenantIdType} to uuid. ` +
          `The USING ::uuid cast will FAIL LOUD at this step if any row ` +
          `contains a non-canonical value, which is the correct signal for ` +
          `data corruption requiring manual investigation.`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid`,
      );
      this.logger.log(`Converted "${table}"."tenantId" → uuid`);
    }

    this.logger.log(
      'Schema convergence complete. EnableRowLevelSecurity1776000000000 can now run cleanly.',
    );
  }

  public async down(): Promise<void> {
    this.logger.warn(
      'down() is a no-op for ConvergeTenantIdTypesAndDropPondBatch1775900000000. ' +
        'Rolling back would re-narrow uuid columns to varchar, re-create the ' +
        'deleted batches table, and resurrect every dropped public-schema ' +
        'duplicate — all actively harmful. Use backup/restore to rewind ' +
        'past this migration.',
    );
  }

  /**
   * Discover farm-module tables that exist in the `public` schema.
   * These are duplicates from a pre-SourceSchemaBootstrap synchronize
   * run and must be dropped before RLS discovery runs.
   *
   * Query uses the farmTables whitelist as a `table_name = ANY($1)`
   * filter so the drop loop is scoped EXCLUSIVELY to tables the farm
   * service owns — cross-module drops are impossible even if some
   * other service happens to also own a `public.*` table with the
   * same name.
   */
  private async discoverPublicDuplicates(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const rows: Array<{ table_name: string }> = await queryRunner.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name = ANY($1::text[])
      ORDER BY table_name
      `,
      [[...this.farmTables]],
    );
    return rows.map((r) => r.table_name);
  }

  /**
   * Check whether a table exists in the CURRENT search_path's first
   * resolvable schema. Used after the `SET search_path TO "farm", …`
   * at the top of `up()` so the check is scoped to the farm schema.
   */
  private async tableExists(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND table_type = 'BASE TABLE'
      ) AS exists
      `,
      [tableName],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Read the `data_type` of a single column from
   * `information_schema.columns`. Returns null if the table or
   * column does not exist in the current schema.
   */
  private async columnType(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<string | null> {
    const rows: Array<{ data_type: string }> = await queryRunner.query(
      `
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      `,
      [tableName, columnName],
    );
    return rows[0]?.data_type ?? null;
  }
}
