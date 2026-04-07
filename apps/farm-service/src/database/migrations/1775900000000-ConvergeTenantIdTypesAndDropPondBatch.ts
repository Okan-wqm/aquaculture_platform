import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * ConvergeTenantIdTypesAndDropPondBatch1775900000000
 * ============================================================================
 *
 * Schema-convergence migration that runs IMMEDIATELY BEFORE
 * `EnableRowLevelSecurity1776000000000` so that migration can finally
 * complete on environments whose schemas were created by a previous
 * revision of the entity layer.
 *
 * # Why this migration exists
 *
 * Two drift classes accumulated in farm-service's schema over time:
 *
 * ## 1. Varchar-typed `tenantId` columns (should be uuid)
 *
 * Three entities (`farm`, `pond`, `worker`) declared
 * `@Column() tenantId: string` with no explicit type, which TypeORM
 * synchronizes as **varchar**. The rest of the platform — 40+ farm-
 * service entities, every other service, the canonical RLS helper at
 * `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts` —
 * uses `@Column('uuid')`. The inconsistency crashed the
 * `EnableRowLevelSecurity1776000000000` migration with
 * `operator does not exist: text = uuid` whenever the RLS policy's
 * USING clause (`"tenantId" = … ::uuid`) was applied to one of the
 * varchar tables.
 *
 * Commit 67f57eac fixed the entity decorators so new environments
 * synchronize the columns as uuid from the start. This migration
 * handles the EXISTING production databases whose synchronize had
 * already created them as varchar: it reads the column's current
 * type from `information_schema.columns` and runs
 * `ALTER TABLE … ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid`
 * only when the column is still text/varchar. Idempotent at the
 * database layer — re-runs against an already-uuid column do nothing.
 *
 * The `USING "tenantId"::uuid` clause is safe because every value
 * that ever lived in a varchar tenantId column was a canonicalised
 * tenant id written by the application layer, which only accepts
 * uuids. If any row ever contains an invalid uuid, the cast will
 * fail LOUDLY at deploy time and block the release — the correct
 * signal for genuine data corruption.
 *
 * ## 2. Orphaned `batches` table from the deleted PondBatch entity
 *
 * The parallel `PondBatch` entity (backed by the `batches` table)
 * was removed in commit b5bcec3c as a dead-code cleanup. Its table
 * still exists in every production environment where an earlier
 * synchronize had created it. This migration drops it explicitly
 * so the RLS discovery query stops finding it.
 *
 * `DROP TABLE IF EXISTS "batches" CASCADE` is safe in this context
 * because the audit at removal time confirmed ZERO frontend, cross-
 * service, or modern-code references. Data inside the `batches`
 * table (if any exists at all in a given environment) was never
 * queried by anything a real user interacts with — it was shadow
 * data produced by a code path that was never wired end-to-end.
 *
 * # Ordering
 *
 * Timestamp 1775900000000 sits intentionally between
 * `1775000000000-AddFeederFieldsToExecution` and
 * `1776000000000-EnableRowLevelSecurity` so the convergence work runs
 * RIGHT BEFORE RLS installation. Registering this migration in the
 * class-ref `migrations: [...]` array in `farm-service/src/app.module.ts`
 * in that same position is required — TypeORM's migration runner
 * orders by the timestamp embedded in the class name, but the
 * class-ref import order in the array is the authoritative source for
 * NX/webpack bundles, so both must agree.
 *
 * # Rollback
 *
 * `down()` is intentionally a no-op that logs a warning. Rolling back
 * this migration would require re-narrowing uuid columns to varchar
 * and re-creating the dead `batches` table — both of which would be
 * actively harmful to the post-fix schema. Operators who need to
 * rewind should use the backup/restore path, not a `migration:revert`.
 */
export class ConvergeTenantIdTypesAndDropPondBatch1775900000000
  implements MigrationInterface
{
  name = 'ConvergeTenantIdTypesAndDropPondBatch1775900000000';
  private readonly logger = new MigrationLogger(this.name);

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
    // ── 1. Drop the dead PondBatch table ────────────────────────────────
    // CASCADE removes any RLS policies, indexes, or foreign-key references
    // still attached to the legacy table in older production environments.
    const batchesExists = await this.tableExists(queryRunner, 'batches');
    if (batchesExists) {
      this.logger.log(
        'Dropping legacy "batches" table (owned by the removed PondBatch entity). CASCADE removes any attached RLS policies and indexes.',
      );
      await queryRunner.query(`DROP TABLE IF EXISTS "batches" CASCADE`);
    } else {
      this.logger.log(
        '"batches" table not present in this environment — nothing to drop. Fresh deployments will never create it since the entity has been removed.',
      );
    }

    // ── 2. Converge varchar tenantId columns to uuid ────────────────────
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

      if (
        tenantIdType !== 'character varying' &&
        tenantIdType !== 'text'
      ) {
        // Anything else is unexpected — fail loud so an operator can
        // investigate before we corrupt something.
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
        'Rolling back would re-narrow uuid columns to varchar and re-create the ' +
        'deleted batches table — both actively harmful. Use backup/restore to ' +
        'rewind past this migration.',
    );
  }

  /**
   * Check whether a table exists in the current schema.
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
   * Read the `data_type` of a single column from `information_schema.columns`.
   * Returns null if the table or column does not exist in the current schema.
   * Known return values: 'uuid', 'character varying', 'text'.
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
