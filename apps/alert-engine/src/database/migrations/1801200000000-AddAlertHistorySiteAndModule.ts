import { addColumnWithIndex, dropColumnWithIndex } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ALERT-MEDIUM-010: `alert_history` gains the site and the module an alarm
 * belongs to, so the tenant console can count and list alarms per module
 * workspace and per site instead of tenant-wide only.
 *
 * # Expand (blue-green safe)
 *
 * Both columns are nullable and have no default: the running release never
 * reads them and keeps inserting without them; the new release stamps them on
 * every alarm it creates. Each column and its index go through the shared
 * addColumnWithIndex (DEBT-2026-05-07-001). Table, index and enum type names
 * are UNQUALIFIED: this migration is replayed into every tenant schema with
 * the search_path pinned to it (the class 1801100000000 documents), so each
 * schema gets its own `alert_history_module_enum`, as a later per-tenant enum
 * column does (hr 1801600000000-AddEmployeeLaborCategory).
 *
 * # Backfill — exact or nothing
 *
 * A historic row gets a value only where its provenance states it:
 *
 *  - module, from who wrote the row: alert-engine sets `sensor_id` only on
 *    rule evaluation over SensorReading, and the pre-meal oxygen guard
 *    (`system:feeding-window-oxygen:`) consumes sensor-service's
 *    FeedingWindowReadiness → `sensor`; every other `system:` rule below is a
 *    farm-service signal → `farm`. A row matching neither stays NULL.
 *  - site, from data the row names: the sensor's site (`sensors.site_id`), the
 *    site the farm signal itself carried (`triggering_data.siteId`, or a
 *    `siteScopeKey` that is a site UUID rather than `tenant`), the day plan's
 *    site for meal signals (`feeding_day_plans.siteId`) and the measurement's
 *    site for water-quality criticals (`water_quality_measurements.siteId`).
 *    Rows whose source has no single site — mortality (batch/tank, tenant-wide
 *    incident), FCR (a batch), low stock (tenant-wide stock), feed type
 *    transitions — stay NULL, as does a row whose referenced record is gone.
 *    The sensor join reads the sensor's current site: the live path stamps the
 *    same binding at reading time, and a sensor moved since keeps its old
 *    rows on the new site — the one inexact case, accepted for active alarms'
 *    sake and recorded in docs/reviews/claude/2026-10-17-module-dashboards.md.
 *
 * The site backfill reads sibling modules' tables in the same tenant schema
 * (`sensors`, `feeding_day_plans`, `water_quality_measurements`); each is
 * skipped when that module is not provisioned for the tenant. It runs only in
 * a tenant schema (the `alert` source schema holds the empty template) and,
 * like 1822000000000-BackfillEdgeDeviceDirectory, under a transaction-local
 * `app.bypass_rls` inside one DO block: the runner binds no tenant, and the
 * forced tenant-isolation policy would otherwise hide every row.
 */
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

/** Rules whose triggering data names the day plan the alarm is about. */
const DAY_PLAN_RULE_PATTERNS = [
  'system:meal-underfed:%',
  'system:meal-missed:%',
  'system:feeding-window-oxygen:%',
] as const;

function sqlTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map((value) => `'${value}'`).join(', ')}]::text[]`;
}

export class AddAlertHistorySiteAndModule1801200000000 implements MigrationInterface {
  name = 'AddAlertHistorySiteAndModule1801200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN
         CREATE TYPE "alert_history_module_enum" AS ENUM('farm', 'sensor', 'hydroponics');
       EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await addColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'site_id',
      columnType: 'uuid',
      indexName: 'IDX_alert_history_site_id_triggered_at',
      indexColumns: ['site_id', 'triggered_at'],
    });
    await addColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'module',
      columnType: { enumType: 'alert_history_module_enum' },
      indexName: 'IDX_alert_history_module_triggered_at',
      indexColumns: ['module', 'triggered_at'],
    });

    const tenantSchema: Array<{ ready: boolean }> = await queryRunner.query(
      `SELECT left(current_schema(), 7) = 'tenant_' AS ready`,
    );
    if (tenantSchema[0]?.ready !== true) {
      return;
    }
    await queryRunner.query(this.backfillSql());
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await dropColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'module',
      indexName: 'IDX_alert_history_module_triggered_at',
    });
    await dropColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'site_id',
      indexName: 'IDX_alert_history_site_id_triggered_at',
    });
    // A tenant provisioned from the source schema after this migration copied
    // its column with the source schema's type; the source's type goes only
    // once no column anywhere still uses it.
    await queryRunner.query(
      `DO $$ BEGIN
         DROP TYPE IF EXISTS "alert_history_module_enum";
       EXCEPTION WHEN dependent_objects_still_exist THEN NULL; END $$;`,
    );
  }

  /**
   * One DO block: the bypass is transaction-local and lasts exactly as long as
   * the backfill. Sibling tables are named through format('%I.…') on the
   * pinned schema, never resolved through the search_path's `public` tail.
   * LIKE patterns reach format() as %L arguments, so their `%` is data.
   */
  private backfillSql(): string {
    return `
      DO $backfill$
      DECLARE
        tenant_schema text := current_schema();
        uuid_pattern text := '${UUID_PATTERN}';
        day_plan_rules text[] := ${sqlTextArray(DAY_PLAN_RULE_PATTERNS)};
      BEGIN
        PERFORM pg_catalog.set_config('app.bypass_rls', 'on', true);

        UPDATE alert_history SET "module" = 'sensor'
         WHERE "module" IS NULL
           AND (sensor_id IS NOT NULL OR rule_id LIKE 'system:feeding-window-oxygen:%');
        UPDATE alert_history SET "module" = 'farm'
         WHERE "module" IS NULL AND rule_id LIKE ANY (${sqlTextArray(FARM_RULE_PATTERNS)});

        UPDATE alert_history SET site_id = (triggering_data->>'siteId')::uuid
         WHERE site_id IS NULL AND rule_id LIKE 'system:unfed-unit:%'
           AND triggering_data->>'siteId' ~ uuid_pattern;
        UPDATE alert_history SET site_id = (triggering_data->>'siteScopeKey')::uuid
         WHERE site_id IS NULL
           AND rule_id LIKE ANY (ARRAY['system:feed-stockout:%', 'system:feed-transition-gap:%'])
           AND triggering_data->>'siteScopeKey' ~ uuid_pattern;

        IF to_regclass(format('%I.sensors', tenant_schema)) IS NOT NULL THEN
          EXECUTE format(
            'UPDATE %I.alert_history ah SET site_id = s.site_id::text::uuid
               FROM %I.sensors s
              WHERE ah.site_id IS NULL AND ah.sensor_id = s.id::text
                AND s.site_id::text ~ %L',
            tenant_schema, tenant_schema, uuid_pattern);
        END IF;

        IF to_regclass(format('%I.feeding_day_plans', tenant_schema)) IS NOT NULL THEN
          EXECUTE format(
            'UPDATE %I.alert_history ah SET site_id = dp."siteId"
               FROM %I.feeding_day_plans dp
              WHERE ah.site_id IS NULL AND ah.rule_id LIKE ANY (%L::text[])
                AND ah.triggering_data->>%L = dp.id::text',
            tenant_schema, tenant_schema, day_plan_rules, 'dayPlanId');
        END IF;

        IF to_regclass(format('%I.water_quality_measurements', tenant_schema)) IS NOT NULL THEN
          EXECUTE format(
            'UPDATE %I.alert_history ah SET site_id = m."siteId"
               FROM %I.water_quality_measurements m
              WHERE ah.site_id IS NULL AND m."siteId" IS NOT NULL
                AND ah.rule_id LIKE %L
                AND ah.triggering_data->>%L = m.id::text',
            tenant_schema, tenant_schema, 'system:water-quality:%', 'measurementId');
        END IF;

        PERFORM pg_catalog.set_config('app.bypass_rls', 'off', true);
      END $backfill$;
    `;
  }
}
