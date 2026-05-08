import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AddWaterQualitySensorReadingCorrelationIndexes1788210000000
 * ============================================================================
 *
 * Phase 7.4 finishing slice — closes FARM-MEDIUM-005. Lands the two
 * indexes the sibling column-add migration
 * (AddWaterQualitySensorReadingCorrelation1788200000001) intentionally
 * left unindexed.
 *
 * # The two indexes
 *
 *   1. Partial UNIQUE on
 *      `(tenantId, "relatedSensorReadingId") WHERE "relatedSensorReadingId" IS NOT NULL`
 *      Defends the N:1 cardinality between sensor readings and WQ
 *      measurements. Without this index a redelivered NATS event or
 *      a buggy upcaster could create duplicate WQ rows pointing at
 *      the same upstream sensor reading. The partial scope keeps the
 *      index size proportional to the number of correlated rows
 *      (manual / bulk-imported measurements with a NULL pointer
 *      contribute nothing to the index).
 *
 *   2. Plain partial index on
 *      `("relatedSensorReadingId") WHERE "relatedSensorReadingId" IS NOT NULL`
 *      Supports the reverse query "given a sensor_reading_id, what
 *      WQ measurement was derived from it?" used by the audit UI's
 *      "view source reading" link.
 *
 * # Why this is a separate migration
 *
 * `CREATE INDEX` (without `CONCURRENTLY`) takes ACCESS EXCLUSIVE on
 * the target table — fine for an empty new column on a small table,
 * stop-the-world on per-tenant copies that may carry millions of
 * water-quality measurements in production. The migration-sql-lint
 * gate forbids non-CONCURRENTLY index creation outside CREATE-TABLE
 * chunks for exactly that reason.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. The
 * standard farm-service migration runner wraps each migration in
 * `startTransaction/commitTransaction`, which is incompatible. The
 * escape hatch is `public transaction = false` on the migration
 * class — TypeORM's MigrationExecutor honours that flag and commits
 * the outer transaction before the body runs, so the body executes
 * outside any wrapping BEGIN/COMMIT and CONCURRENTLY succeeds.
 *
 * # Why the body discovers tenant schemas at runtime
 *
 * `water_quality_measurements` is per-tenant cloned: the source copy
 * lives at `farm.water_quality_measurements` and every tenant owns
 * its own `tenant_<hex16>.water_quality_measurements` produced via
 * `CREATE TABLE LIKE INCLUDING ALL` at provisioning time. INCLUDING
 * ALL copies indexes that exist AT PROVISIONING — but indexes added
 * to the source after the fact do not propagate to existing tenants
 * (they would only land on FUTURE tenants).
 *
 * For an existing-tenant migration we therefore need to enumerate
 * every tenant_<hex16> schema and CREATE INDEX CONCURRENTLY on each
 * one's table copy, plus the source `farm` schema for the template.
 *
 * The standard runner DOES walk tenant schemas and re-runs migrations
 * with `search_path` set to each one, but only when migrations follow
 * the unqualified-table-name pattern under a wrapping transaction.
 * Our `transaction = false` body cannot use that mechanism: the
 * runner's per-migration outer transaction is what carries the
 * search_path setting; with the transaction skipped the search_path
 * doesn't propagate the way the runner expects.
 *
 * The body therefore enumerates schemas itself via
 * `information_schema.schemata` (matching the canonical
 * `^tenant_[a-f0-9]{16}$` regex from
 * `libs/backend-common/src/database/tenant-schema.utils.ts`), plus
 * the explicit `farm` source schema, and CREATE INDEX CONCURRENTLY
 * IF NOT EXISTS on each one's table copy. The fully-qualified schema
 * names (`farm.water_quality_measurements`, `tenant_<hex16>.water_
 * quality_measurements`) bypass search_path entirely.
 *
 * # Failure-mode handling
 *
 * `CREATE INDEX CONCURRENTLY` can fail mid-build, leaving an INVALID
 * index (`pg_index.indisvalid = false`). `IF NOT EXISTS` does NOT
 * cover that case — a re-run hits the existing-but-invalid index and
 * skips. The migration logs a warning when that happens and proceeds
 * to the next schema rather than aborting the whole run; the operator
 * can DROP the invalid index via the canonical DBA path
 * (`DROP INDEX CONCURRENTLY <name>`) and re-run this migration.
 * Per-schema isolation means one tenant's invalid index does not
 * block the others from completing.
 *
 * # Idempotency
 *
 * `CREATE INDEX CONCURRENTLY IF NOT EXISTS` makes the body safe to
 * re-run on partially-applied environments (e.g. when a previous
 * run failed against tenant 47 of 100, the next run picks up
 * cleanly).
 *
 * # Down()
 *
 * `DROP INDEX CONCURRENTLY IF EXISTS` for both indexes across every
 * discovered schema. Concurrent drop avoids stalling readers on
 * production tables.
 */
export class AddWaterQualitySensorReadingCorrelationIndexes1788210000000
  implements MigrationInterface
{
  /** Required for CREATE INDEX CONCURRENTLY — see docblock § failure mode. */
  public transaction = false;

  private readonly logger = new MigrationLogger(
    'AddWaterQualitySensorReadingCorrelationIndexes1788210000000',
  );
  name = 'AddWaterQualitySensorReadingCorrelationIndexes1788210000000';

  /**
   * Sibling utility lives in `libs/backend-common/src/database/tenant-
   * schema.utils.ts::listTenantSchemas`, but importing it here would
   * couple the migration to a runtime module which violates the
   * "migrations carry their own infrastructure" rule that
   * 1775900000000-ConvergeTenantIdTypesAndDropPondBatch.ts established.
   * Inline copy — same regex, same intent.
   */
  private async discoverSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: { schema_name: string }[] = await queryRunner.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name = 'farm'
          OR schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );
    return rows.map((r) => r.schema_name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schemas = await this.discoverSchemas(queryRunner);
    this.logger.log(
      `Phase 7.4 indexes — fanning out across ${schemas.length} schema(s):`,
      schemas.join(', '),
    );

    let created = 0;
    let skippedInvalid = 0;
    for (const schema of schemas) {
      const uniqueIndexName = `idx_wq_related_sensor_reading_uniq_${schema}`;
      const lookupIndexName = `idx_wq_related_sensor_reading_lookup_${schema}`;

      // Partial UNIQUE — N:1 cardinality enforcement.
      try {
        await queryRunner.query(`
          CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${uniqueIndexName}"
          ON "${schema}"."water_quality_measurements" ("tenantId", "relatedSensorReadingId")
          WHERE "relatedSensorReadingId" IS NOT NULL
        `);
        created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CREATE UNIQUE INDEX CONCURRENTLY failed on "${schema}": ${msg}. ` +
            'If pg_index.indisvalid=false for this name, drop manually via ' +
            `DROP INDEX CONCURRENTLY "${schema}"."${uniqueIndexName}" and re-run.`,
        );
        skippedInvalid++;
      }

      // Partial lookup — reverse-correlation query path.
      try {
        await queryRunner.query(`
          CREATE INDEX CONCURRENTLY IF NOT EXISTS "${lookupIndexName}"
          ON "${schema}"."water_quality_measurements" ("relatedSensorReadingId")
          WHERE "relatedSensorReadingId" IS NOT NULL
        `);
        created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `CREATE INDEX CONCURRENTLY failed on "${schema}": ${msg}. ` +
            'If pg_index.indisvalid=false for this name, drop manually via ' +
            `DROP INDEX CONCURRENTLY "${schema}"."${lookupIndexName}" and re-run.`,
        );
        skippedInvalid++;
      }
    }

    this.logger.log(
      `Phase 7.4 indexes — done: ${created} succeeded, ${skippedInvalid} skipped/failed across ${schemas.length} schema(s).`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schemas = await this.discoverSchemas(queryRunner);
    this.logger.warn(
      `Phase 7.4 indexes DOWN — dropping across ${schemas.length} schema(s):`,
      schemas.join(', '),
    );

    for (const schema of schemas) {
      const uniqueIndexName = `idx_wq_related_sensor_reading_uniq_${schema}`;
      const lookupIndexName = `idx_wq_related_sensor_reading_lookup_${schema}`;

      // Drop both indexes per schema. Concurrent drop avoids stalling
      // readers; IF EXISTS keeps the down() idempotent if some indexes
      // never landed (partial up()).
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${lookupIndexName}"`,
      );
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${uniqueIndexName}"`,
      );
    }

    this.logger.warn(
      'Phase 7.4 indexes dropped. The relatedSensorReadingId column ' +
        'remains; auto-correlation event-handlers (FARM-MEDIUM-007) MUST be ' +
        'paused before this DOWN runs in production — without the partial ' +
        'UNIQUE the N:1 invariant is no longer enforced at the DB layer.',
    );
  }
}
