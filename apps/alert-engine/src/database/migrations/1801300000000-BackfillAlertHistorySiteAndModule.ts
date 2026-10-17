import { assertSafeSchemaName } from '@aquaculture/backend-common/database';
import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/** Rows one batch reads and may update; each batch commits on its own. */
export const ALERT_HISTORY_BACKFILL_BATCH_SIZE = 5_000;

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Synthetic rule ids alert-engine mints for farm-service signals. */
const FARM_RULE_PATTERNS = [
  'system:water-quality:%',
  'system:mortality:%',
  'system:fcr:%',
  'system:meal-underfed:%',
  'system:meal-missed:%',
  'system:unfed-unit:%',
  'system:feed-transition:%',
  'system:feed-transition-gap:%',
  'system:feed-stockout:%',
  'system:low-stock:%',
] as const;

/** Meal signals: the live path stamps their day plan's site. */
const MEAL_RULE_PATTERNS = ['system:meal-underfed:%', 'system:meal-missed:%'] as const;

/** Feed-coverage signals: their scope key is a site UUID, or `tenant`. */
const SCOPE_KEY_RULE_PATTERNS = ['system:feed-stockout:%', 'system:feed-transition-gap:%'] as const;

function sqlTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map((value) => `'${value}'`).join(', ')}]::text[]`;
}

/** A triggering-data field read as a uuid, or NULL when it is not one. */
function uuidField(field: string): string {
  return `CASE WHEN ah.triggering_data->>'${field}' ~ '${UUID_PATTERN}'
               THEN (ah.triggering_data->>'${field}')::uuid END`;
}

/** The one row a single-row SELECT returns. */
function onlyRow<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`${what} returned ${rows.length} rows instead of one`);
  }
  return row;
}

/** The sibling modules' tables the site sources read, where the tenant has them. */
interface SiblingTables {
  readonly dayPlans: boolean;
  readonly measurements: boolean;
}

interface BatchResult {
  readonly lastId: string | null;
  readonly scanned: number;
  readonly attributed: number;
}

/**
 * ALERT-MEDIUM-010: historic `alert_history` rows get the module and site
 * that 1801200000000 added — split from it so the expand DDL commits at once
 * (ALERT-MEDIUM-011), and exact (ALERT-LOW-012).
 *
 * # What a historic row gets: exact or nothing
 *
 * The module, from who wrote the row: alert-engine sets `sensor_id` only on
 * rule evaluation over SensorReading, and the pre-meal oxygen guard
 * (`system:feeding-window-oxygen:`) consumes sensor-service's
 * FeedingWindowReadiness, so both are `sensor`; every other `system:` rule
 * below is a farm-service signal, `farm`. A row matching neither stays NULL.
 *
 * The site, only where the row names the same source the live path stamps:
 *
 *  - unfed unit: the signal's own `siteId` (`triggering_data.siteId`);
 *  - feed stockout / transition gap: the `siteScopeKey` when it is a site
 *    UUID (`tenant`, the tenant-wide stock pool, names none);
 *  - meal underfed / missed: the day plan's site (`feeding_day_plans`), the
 *    site MealUnderfed / MealMissed carry;
 *  - water quality critical: the measurement's site
 *    (`water_quality_measurements`), the site WaterQualityCritical carries.
 *
 * Left NULL, because no exact source exists: a rule alarm on a sensor
 * reading (the live path stamps the site the sensor had at reading time;
 * only its current site is on record, and a sensor moved since would place
 * the alarm on the wrong site); the oxygen guard (the live path stamps its
 * DO sensor's site, and the row does not name the sensor); mortality, FCR,
 * low stock and feed type transitions (no single site, or none recorded); a
 * row whose day plan or measurement is gone; a tenant without the module.
 *
 * # Batches (ALERT-MEDIUM-011)
 *
 * alert_history keeps every alarm and the live alarm path writes it while
 * this runs. The migration declares `transaction = false` and walks the table
 * in primary-key order, BATCH_SIZE rows at a time. Each batch is one short
 * transaction under lock_timeout 2s and statement_timeout 30s, so an alarm
 * acknowledgement waits at most for one batch's row locks. A batch fills
 * only columns still NULL with values computed from the row alone, so a run
 * stopped midway leaves its committed batches correct and a re-run completes
 * the rest; the runner records the migration only after `up` returns.
 *
 * # Routing and RLS
 *
 * The runner replays this in every tenant schema with the search_path
 * pinned; the `alert` source schema holds the empty template and is skipped.
 * Each batch sets `app.bypass_rls` transaction-locally, as
 * 1822000000000-BackfillEdgeDeviceDirectory does: the runner binds no tenant
 * and the forced tenant-isolation policy would hide every row. The sibling
 * tables are qualified with the pinned schema, so a module the tenant lacks
 * never resolves through the search_path's `public` tail, and each is read
 * only when present.
 *
 * `down` is a no-op: the values are indistinguishable from the ones the live
 * path writes, and 1801200000000's `down` drops both columns.
 */
export class BackfillAlertHistorySiteAndModule1801300000000 implements MigrationInterface {
  name = 'BackfillAlertHistorySiteAndModule1801300000000';

  /** Every batch commits on its own (see "Batches"). */
  readonly transaction = false;

  private readonly logger = new Logger(BackfillAlertHistorySiteAndModule1801300000000.name);

  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.isTransactionActive) {
      throw new Error(
        `${this.name} commits each batch on its own and must run outside a transaction`,
      );
    }
    const { schema } = onlyRow<{ schema: string }>(
      await queryRunner.query(`SELECT current_schema() AS schema`),
      'current_schema()',
    );
    if (!schema.startsWith('tenant_')) {
      return;
    }
    assertSafeSchemaName(schema);

    const batchSql = this.batchSql(schema, await this.siblingTables(queryRunner));
    let after: string | null = null;
    let batches = 0;
    let attributed = 0;
    for (;;) {
      const batch = await this.runBatch(queryRunner, batchSql, after);
      batches += 1;
      attributed += batch.attributed;
      if (batch.lastId === null || batch.scanned < ALERT_HISTORY_BACKFILL_BATCH_SIZE) break;
      after = batch.lastId;
    }
    this.logger.log(
      `alert_history in ${schema}: ${attributed} row(s) attributed in ${batches} batch(es)`,
    );
  }

  async down(): Promise<void> {
    // Intentionally a no-op — see the class docblock.
  }

  private async siblingTables(queryRunner: QueryRunner): Promise<SiblingTables> {
    return onlyRow<SiblingTables>(
      await queryRunner.query(
        `SELECT to_regclass(format('%I.feeding_day_plans', current_schema())) IS NOT NULL
                  AS "dayPlans",
                to_regclass(format('%I.water_quality_measurements', current_schema())) IS NOT NULL
                  AS "measurements"`,
      ),
      'the sibling-table probe',
    );
  }

  /** One batch in its own transaction: bounded waits, bypass for this batch only. */
  private async runBatch(
    queryRunner: QueryRunner,
    batchSql: string,
    after: string | null,
  ): Promise<BatchResult> {
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
      await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
      await queryRunner.query(`SELECT pg_catalog.set_config('app.bypass_rls', 'on', true)`);
      const result = onlyRow<BatchResult>(
        await queryRunner.query(batchSql, [after, ALERT_HISTORY_BACKFILL_BATCH_SIZE]),
        'an alert_history attribution batch',
      );
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    }
  }

  /**
   * The next batch by primary key ($1: the last id done, NULL to start; $2:
   * the batch size). The module is written through a CASE whose first branch
   * is the column itself, so the string literals take the column's own enum
   * type — a tenant provisioned from the source schema carries the source
   * schema's type, not one of its own.
   */
  private batchSql(schema: string, siblings: SiblingTables): string {
    const siteSources = [
      `WHEN ah.rule_id LIKE 'system:unfed-unit:%' THEN ${uuidField('siteId')}`,
      `WHEN ah.rule_id LIKE ANY (${sqlTextArray(SCOPE_KEY_RULE_PATTERNS)})
         THEN ${uuidField('siteScopeKey')}`,
    ];
    if (siblings.dayPlans) {
      siteSources.push(
        `WHEN ah.rule_id LIKE ANY (${sqlTextArray(MEAL_RULE_PATTERNS)})
           THEN (SELECT dp."siteId" FROM "${schema}".feeding_day_plans dp
                  WHERE dp.id = ${uuidField('dayPlanId')})`,
      );
    }
    if (siblings.measurements) {
      siteSources.push(
        `WHEN ah.rule_id LIKE 'system:water-quality:%'
           THEN (SELECT m."siteId" FROM "${schema}".water_quality_measurements m
                  WHERE m.id = ${uuidField('measurementId')})`,
      );
    }
    return `
      WITH batch AS (
        SELECT ah.id,
               CASE WHEN ah."module" IS NULL THEN
                 CASE
                   WHEN ah.sensor_id IS NOT NULL
                     OR ah.rule_id LIKE 'system:feeding-window-oxygen:%' THEN 'sensor'
                   WHEN ah.rule_id LIKE ANY (${sqlTextArray(FARM_RULE_PATTERNS)}) THEN 'farm'
                 END
               END AS module_of,
               CASE WHEN ah.site_id IS NULL THEN
                 CASE ${siteSources.join('\n                   ')} END
               END AS site_of
          FROM alert_history ah
         WHERE $1::uuid IS NULL OR ah.id > $1::uuid
         ORDER BY ah.id
         LIMIT $2
      ),
      attributed AS (
        UPDATE alert_history ah
           SET "module" = CASE
                            WHEN ah."module" IS NOT NULL THEN ah."module"
                            WHEN b.module_of = 'sensor' THEN 'sensor'
                            WHEN b.module_of = 'farm' THEN 'farm'
                          END,
               site_id = COALESCE(ah.site_id, b.site_of)
          FROM batch b
         WHERE ah.id = b.id
           AND (b.module_of IS NOT NULL OR b.site_of IS NOT NULL)
        RETURNING 1
      )
      SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS "lastId",
             (SELECT count(*) FROM batch)::int AS scanned,
             (SELECT count(*) FROM attributed)::int AS attributed`;
  }
}
