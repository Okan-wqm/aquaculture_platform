import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * RestoreWaterQualityRelatedSensorReadingUnique1801400000000
 * ============================================================================
 *
 * # Why this migration exists (lost partial-UNIQUE invariant)
 *
 * Pre-baseline, `water_quality_measurements` carried a partial UNIQUE index
 * on `(tenantId, "relatedSensorReadingId") WHERE "relatedSensorReadingId" IS
 * NOT NULL` (originally landed by the archived
 * `1788210000000-AddWaterQualitySensorReadingCorrelationIndexes`). The
 * day-one baseline reset (1800000000000) reproduced only the PLAIN
 * non-unique index on `relatedSensorReadingId` — the UNIQUE qualifier was
 * dropped. The sibling `(tenantId, idempotencyKey)` partial-unique SURVIVED
 * the reset because it is expressed as a `@Index(..., { unique: true, where })`
 * decorator on the entity, whereas the related-sensor-reading uniqueness was
 * only ever a hand-written migration index (no decorator), so the baseline
 * regen had nothing to reproduce.
 *
 * IMPACT: the WQ measurement ←→ sensor reading correlation is N:1 — a given
 * upstream sensor reading produces AT MOST ONE WQ measurement. Without the
 * partial UNIQUE, a redelivered NATS `SensorReadingRecorded` event or a buggy
 * upcaster can insert DUPLICATE WQ rows pointing at the same source reading,
 * corrupting trend analysis and double-counting alarm triggers on life-safety
 * water-quality data.
 *
 * # Two halves of this fix (both shipped in this PR)
 *
 *   (a) ENTITY: the plain `@Index()` on `relatedSensorReadingId` in
 *       water-quality-measurement.entity.ts is upgraded to the same
 *       partial-unique class-level `@Index(..., { unique: true, where })`
 *       form already used for `idempotencyKey`, so a future baseline regen
 *       reproduces the UNIQUE qualifier (Tier-1 make-it-structural).
 *   (b) MIGRATION (this file): restores the index on already-deployed source
 *       + tenant schemas, which a regen alone never touches (INCLUDING ALL
 *       only copies indexes at tenant-provision time).
 *
 * # Why `transaction = false` + self-discovered schema fan-out
 *
 * `CREATE UNIQUE INDEX CONCURRENTLY` cannot run inside a transaction, and the
 * runner wraps every migration in `startTransaction/commitTransaction`. The
 * `transaction = false` escape hatch tells TypeORM's MigrationExecutor to
 * commit the outer transaction before the body runs. But with no wrapping
 * transaction the runner's per-migration `search_path` pin does not propagate
 * the way unqualified-table migrations rely on — so this body MUST enumerate
 * schemas itself and use fully-qualified `"<schema>"."water_quality_..."`
 * names. We do NOT use `@TenantFanOut` for the same reason: the orchestrator's
 * fan-out is a transactional-search_path mechanism this CONCURRENTLY body
 * cannot participate in. This mirrors the archived 1788210000000 exactly.
 *
 * The schema set is discovered via `information_schema.schemata`, matching
 * the canonical `^tenant_[a-f0-9]{16}$` tenant-schema regex plus the explicit
 * `farm` source schema. Every discovered name is RE-ASSERTED against that
 * regex (or `=== 'farm'`) before interpolation as a SQL-injection guard.
 *
 * # Pre-flight dedup audit — FAIL LOUD, never auto-delete
 *
 * `CREATE UNIQUE INDEX CONCURRENTLY` on a table that already contains
 * duplicate `(tenantId, relatedSensorReadingId)` pairs leaves an INVALID
 * index (`pg_index.indisvalid = false`) — silently broken, enforcing
 * nothing. We therefore probe for duplicates per-schema FIRST and throw with
 * the offending schema + sample pairs if any exist. We do NOT auto-delete:
 * WQ rows are life-safety records, and choosing which duplicate to keep is an
 * operator decision, not a migration's. The thrown error instructs the
 * operator to dedup before re-running.
 *
 * # down()
 *
 * `DROP INDEX CONCURRENTLY IF EXISTS` for the restored index across every
 * discovered schema. Concurrent drop avoids stalling readers; IF EXISTS keeps
 * it idempotent across a partial up().
 */
export class RestoreWaterQualityRelatedSensorReadingUnique1801400000000
  implements MigrationInterface
{
  /** Required for CREATE INDEX CONCURRENTLY — see docblock § transaction. */
  public transaction = false;

  name = 'RestoreWaterQualityRelatedSensorReadingUnique1801400000000';

  private readonly logger = new MigrationLogger(
    'RestoreWaterQualityRelatedSensorReadingUnique1801400000000',
  );

  /** Stable per-schema index name (matches the surviving lookup-index naming). */
  private uniqueIndexName(schema: string): string {
    return `idx_wq_related_sensor_reading_uniq_${schema}`;
  }

  /**
   * Enumerate the source `farm` schema + every per-tenant clone. Inline regex
   * copy (not the runtime tenant-schema util) keeps the migration carrying its
   * own infrastructure, the same rule the archived 1788210000000 followed.
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

  /** SQL-injection guard — re-assert every name before interpolation. */
  private assertSafeSchema(schema: string): void {
    if (schema !== 'farm' && !/^tenant_[a-f0-9]{16}$/.test(schema)) {
      throw new Error(
        `[RestoreWaterQualityRelatedSensorReadingUnique] Refusing unsafe ` +
          `schema name "${schema}" — expected 'farm' or /^tenant_[a-f0-9]{16}$/.`,
      );
    }
  }

  /**
   * FAIL-LOUD pre-flight: throw if any schema already holds duplicate
   * (tenantId, relatedSensorReadingId) pairs that would make the UNIQUE index
   * INVALID. Does NOT mutate data — WQ is life-safety; operator dedups first.
   */
  private async assertNoDuplicates(
    queryRunner: QueryRunner,
    schema: string,
  ): Promise<void> {
    const dupes: Array<{
      tenantId: string;
      relatedSensorReadingId: string;
      count: string;
    }> = await queryRunner.query(
      `SELECT "tenantId", "relatedSensorReadingId", COUNT(*) AS count
       FROM "${schema}"."water_quality_measurements"
       WHERE "relatedSensorReadingId" IS NOT NULL
       GROUP BY "tenantId", "relatedSensorReadingId"
       HAVING COUNT(*) > 1
       LIMIT 50`,
    );

    if (dupes.length > 0) {
      const sample = dupes
        .slice(0, 10)
        .map(
          (d) =>
            `(tenantId=${d.tenantId}, relatedSensorReadingId=${d.relatedSensorReadingId}, count=${d.count})`,
        )
        .join('; ');
      throw new Error(
        `[RestoreWaterQualityRelatedSensorReadingUnique] Schema "${schema}" ` +
          `holds duplicate (tenantId, relatedSensorReadingId) pairs — a UNIQUE ` +
          `index cannot be created (CREATE UNIQUE INDEX CONCURRENTLY would leave ` +
          `an INVALID index). WQ measurements are life-safety records; the ` +
          `migration will NOT auto-delete. Operator MUST dedup first ` +
          `(retain the authoritative row per pair), then re-run. ` +
          `Sample (up to 10 of ${dupes.length}): ${sample}`,
      );
    }
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schemas = await this.discoverSchemas(queryRunner);
    this.logger.log(
      `Restoring WQ related-sensor-reading partial UNIQUE across ${schemas.length} schema(s):`,
      schemas.join(', '),
    );

    for (const schema of schemas) {
      this.assertSafeSchema(schema);

      // Fail loud BEFORE creating the index so we never land an INVALID one.
      await this.assertNoDuplicates(queryRunner, schema);

      const indexName = this.uniqueIndexName(schema);
      await queryRunner.query(`
        CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}"
        ON "${schema}"."water_quality_measurements" ("tenantId", "relatedSensorReadingId")
        WHERE "relatedSensorReadingId" IS NOT NULL
      `);
      this.logger.log(
        `Partial UNIQUE "${indexName}" ensured on "${schema}".water_quality_measurements`,
      );
    }

    this.logger.log(
      `WQ related-sensor-reading partial UNIQUE restored across ${schemas.length} schema(s).`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schemas = await this.discoverSchemas(queryRunner);
    this.logger.warn(
      `Dropping WQ related-sensor-reading partial UNIQUE across ${schemas.length} schema(s) — ` +
        'the N:1 sensor-reading→measurement invariant will no longer be ' +
        'enforced at the DB layer; pause auto-correlation event handlers first.',
    );

    for (const schema of schemas) {
      this.assertSafeSchema(schema);
      const indexName = this.uniqueIndexName(schema);
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${indexName}"`,
      );
    }
  }
}
