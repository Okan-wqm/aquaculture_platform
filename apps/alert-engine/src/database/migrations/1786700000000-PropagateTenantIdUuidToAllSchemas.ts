import { MigrationInterface, Logger, QueryRunner } from 'typeorm';

/**
 * PropagateTenantIdUuidToAllSchemas
 * ============================================================================
 *
 * Closes the tenant fan-out propagation gap left by
 * `ConvergeTenantIdToUuid1786400000000` (commit 8486de02).
 *
 * # Why this migration exists
 *
 * Discovery during the 2026-04-20 architectural-convergence cycle:
 * each `tenant_<uuid>` schema in the platform has its OWN
 * `typeorm_migrations` table. `SchemaManagerService.seedMigrationsHistory()`
 * (libs/backend-common/src/database/schema-manager.service.ts:947-950)
 * copies the source schema's migration history into every newly-provisioned
 * tenant's tracking table:
 *
 *   INSERT INTO "${tenant}"."typeorm_migrations" ("timestamp", "name")
 *   SELECT "timestamp", "name" FROM "${source}"."typeorm_migrations"
 *
 * Consequence: when a NEW migration applies to source `alert`, the
 * aqua-db-migrate orchestrator's tenant fan-out
 * (apps/db-migrate/src/migration-orchestrator.ts:269-276, 360-382, 416)
 * pins search_path to each tenant schema and asks
 * `MigrationExecutor.getPendingMigrations()` what to run. The executor
 * checks the TENANT'S typeorm_migrations table — finds the migration
 * name already there (seeded at provision time) — reports "0 pending"
 * and skips execution.
 *
 * Verified evidence from the 2026-04-20 12:34 deploy log:
 *
 *   "Migration applied","schema":"alert","migration":"ConvergeTenantIdToUuid1786400000000"
 *   "Tenant fan-out starting","schema":"alert","tenantCount":5
 *   "Pending migrations enumerated","schema":"tenant_<uuid>","pendingCount":0
 *   "Schema migration complete","schema":"tenant_<uuid>","applied":[]
 *   "Tenant fan-out complete","schema":"alert","tenantCount":5,"totalApplied":0
 *
 * Result: source `alert.alert_incidents.tenant_id` was converted to
 * uuid; every `tenant_<uuid>.alert_incidents.tenant_id` is still varchar.
 * RLS queries `WHERE tenant_id = current_setting('app.current_tenant')::uuid`
 * on tenant connections will fail with `operator does not exist:
 * character varying = uuid` — same incident class as the 2026-04-08
 * farm-service production crash.
 *
 * # Architectural pattern (canonical multi-tenant DDL)
 *
 * Mirrors `apps/farm-service/src/database/migrations/1781800000000-AddTenantActivePartialIndexes.ts:240-291`:
 *
 *   1. Discover every schema containing the target tables via
 *      information_schema.columns + information_schema.tables.
 *   2. Iterate the schemas inside ONE migration pass — do NOT delegate
 *      to the orchestrator's per-tenant re-execution (which is broken
 *      by the seed-from-source mechanism above).
 *   3. Each ALTER uses `"${schema}"."${table}"` with explicit prefix.
 *      The schema name is validated against an injection-safe regex
 *      (lowercase + digits + underscore only) before interpolation.
 *   4. Each ALTER is idempotent (gated on `data_type = 'character varying'`).
 *   5. Empty-table guard before ALTER: if the tenant clone has rows,
 *      log a warning and skip. The cast `tenant_id::uuid` would fail
 *      loudly on a non-UUID row (correct signal for data corruption);
 *      we surface that via the warning rather than aborting the
 *      migration globally.
 *
 * # Why a separate migration instead of editing 1786400000000
 *
 * `1786400000000-ConvergeTenantIdToUuid` is already recorded in the
 * `typeorm_migrations` table of source `alert` AND every existing
 * tenant clone (via the seed-from-source mechanism). Editing the file
 * would NOT cause re-execution — the orchestrator only runs migrations
 * whose name is NOT in the tracking table. A new migration with a new
 * timestamp is the only way to apply the fix to tenant clones.
 *
 * # Idempotent
 *
 * Safe to re-run on a database where some or all tenant clones have
 * already been converted. The data_type gate skips already-uuid
 * columns; the empty-table check skips populated tables (operator
 * intervention required for those).
 */
export class PropagateTenantIdUuidToAllSchemas1786700000000
  implements MigrationInterface
{
  private readonly logger = new Logger(
    'PropagateTenantIdUuidToAllSchemas1786700000000',
  );

  /**
   * Schema names safe to interpolate into DDL. Matches the source
   * schema (`alert`) and tenant clones (`tenant_<16-hex>`). Anything
   * else is rejected to prevent SQL injection — defense in depth even
   * though information_schema only returns names PostgreSQL accepts.
   */
  private static readonly SAFE_SCHEMA_REGEX =
    /^(alert|tenant_[a-f0-9]{16})$/;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const targetTables = ['alert_incidents', 'alert_audit_log'] as const;

    // 1. Discover all schemas that contain alert_incidents.
    //    The query uses information_schema.tables so it picks up
    //    base tables (excludes views, foreign tables) — both source
    //    `alert` and every `tenant_<uuid>` clone with the table
    //    physically present.
    const schemaRows: Array<{ table_schema: string }> = await queryRunner.query(`
      SELECT DISTINCT t.table_schema
      FROM information_schema.tables t
      WHERE t.table_type = 'BASE TABLE'
        AND t.table_name = 'alert_incidents'
        AND (t.table_schema = 'alert' OR t.table_schema LIKE 'tenant\\_%' ESCAPE '\\')
      ORDER BY t.table_schema
    `);

    const schemas = schemaRows
      .map((r) => r.table_schema)
      .filter((s) => PropagateTenantIdUuidToAllSchemas1786700000000.SAFE_SCHEMA_REGEX.test(s));

    if (schemas.length === 0) {
      this.logger.warn(
        'No schemas with alert_incidents found — migration is a no-op. ' +
          'This is expected on a fresh database where alert tables have not yet been provisioned.',
      );
      return;
    }

    this.logger.log(
      `Propagating tenant_id varchar -> uuid across ${schemas.length} schema(s): ${schemas.join(', ')}`,
    );

    let totalConverted = 0;
    let totalSkippedAlreadyUuid = 0;
    let totalSkippedNonEmpty = 0;
    let totalSkippedMissing = 0;

    for (const schema of schemas) {
      for (const table of targetTables) {
        // a) Existence check — defensive; the discovery query already
        //    filtered for schemas with alert_incidents but
        //    alert_audit_log might be missing on a half-bootstrapped
        //    tenant.
        const existsRows: Array<{ data_type: string }> = await queryRunner.query(
          `SELECT data_type FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 AND column_name = 'tenant_id'`,
          [schema, table],
        );
        if (existsRows.length === 0) {
          totalSkippedMissing++;
          this.logger.debug(
            `[${schema}.${table}] tenant_id column not found — skipping`,
          );
          continue;
        }

        // b) Idempotency gate — already converted in a prior run.
        if (existsRows[0]!.data_type !== 'character varying') {
          totalSkippedAlreadyUuid++;
          this.logger.debug(
            `[${schema}.${table}] tenant_id already ${existsRows[0]!.data_type} — skipping`,
          );
          continue;
        }

        // c) Empty-table guard — the cast tenant_id::uuid would fail
        //    loudly on a non-UUID row. We don't want one bad row to
        //    abort the migration globally; we log a warning and skip
        //    the offending schema/table so the operator can intervene.
        const countRows: Array<{ count: string }> = await queryRunner.query(
          `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}"`,
        );
        const rowCount = Number(countRows[0]?.count ?? '0');
        if (rowCount > 0) {
          totalSkippedNonEmpty++;
          this.logger.warn(
            `[${schema}.${table}] table has ${rowCount} row(s) — skipping ALTER. ` +
              `Operator must verify all tenant_id values are valid UUIDs before manually applying ` +
              `ALTER TABLE "${schema}"."${table}" ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid`,
          );
          continue;
        }

        // d) Apply the ALTER. Schema and table are both safe to
        //    interpolate: schema passed the SAFE_SCHEMA_REGEX guard
        //    above; table is a hardcoded literal from targetTables.
        await queryRunner.query(
          `ALTER TABLE "${schema}"."${table}" ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid`,
        );
        totalConverted++;
        this.logger.log(
          `[${schema}.${table}] tenant_id varchar -> uuid (table empty, no data conversion)`,
        );
      }
    }

    this.logger.log(
      `Propagation complete: converted=${totalConverted}, ` +
        `already-uuid=${totalSkippedAlreadyUuid}, ` +
        `non-empty-skipped=${totalSkippedNonEmpty}, ` +
        `missing=${totalSkippedMissing}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback: tenant_id uuid -> varchar across all schemas. Real-world
    // operators should fix-forward — varchar tenant_id breaks RLS and
    // re-introduces the drift this migration closed.
    const targetTables = ['alert_incidents', 'alert_audit_log'] as const;

    const schemaRows: Array<{ table_schema: string }> = await queryRunner.query(`
      SELECT DISTINCT t.table_schema
      FROM information_schema.tables t
      WHERE t.table_type = 'BASE TABLE'
        AND t.table_name = 'alert_incidents'
        AND (t.table_schema = 'alert' OR t.table_schema LIKE 'tenant\\_%' ESCAPE '\\')
      ORDER BY t.table_schema
    `);
    const schemas = schemaRows
      .map((r) => r.table_schema)
      .filter((s) => PropagateTenantIdUuidToAllSchemas1786700000000.SAFE_SCHEMA_REGEX.test(s));

    for (const schema of schemas) {
      for (const table of targetTables) {
        const existsRows: Array<{ data_type: string }> = await queryRunner.query(
          `SELECT data_type FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 AND column_name = 'tenant_id'`,
          [schema, table],
        );
        if (existsRows.length === 0) continue;
        if (existsRows[0]!.data_type !== 'uuid') continue;
        await queryRunner.query(
          `ALTER TABLE "${schema}"."${table}" ALTER COLUMN tenant_id TYPE varchar(255) USING tenant_id::text`,
        );
      }
    }
  }
}
