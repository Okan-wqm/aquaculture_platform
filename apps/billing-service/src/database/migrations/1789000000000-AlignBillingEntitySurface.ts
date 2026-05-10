import { MigrationInterface, QueryRunner } from 'typeorm';
import { pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * AlignBillingEntitySurface1789000000000
 * ============================================================================
 *
 * Creates the two `billing` schema tables that the 2026-05-08
 * bootstrap-from-scratch test reported as completely missing:
 *
 *   - billing.usage_aggregations  (UsageAggregation entity)
 *   - billing.usage_hourly_data   (UsageHourlyData entity)
 *
 * Both are declared in `apps/billing-service/src/modules/metering/
 * entities/usage-aggregation.entity.ts` with explicit
 * `{ schema: 'billing' }` decorators. Pre-fix the only path that
 * materialised them was TypeORM's deprecated `synchronize: true` boot
 * mode — removed in W4-A2.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignBillingEntitySurface1789000000000
  implements MigrationInterface
{
  name = 'AlignBillingEntitySurface1789000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'billing');
    await qr.query(`CREATE SCHEMA IF NOT EXISTS billing`);

    // billing.usage_aggregations — composite-key id varchar(255).
    await qr.query(`
      CREATE TABLE IF NOT EXISTS billing.usage_aggregations (
        "id"             varchar(255) NOT NULL PRIMARY KEY,
        "tenant_id"      uuid NOT NULL,
        "period"         varchar(20) NOT NULL,
        "periodStart"    timestamptz NOT NULL,
        "periodEnd"      timestamptz NOT NULL,
        "meterType"      varchar(50) NOT NULL,
        "dimension"      varchar(20),
        "dimensionValue" varchar(255),
        "totalUsage"     decimal(20,6) NOT NULL DEFAULT 0,
        "peakUsage"      decimal(20,6) NOT NULL DEFAULT 0,
        "averageUsage"   decimal(20,6) NOT NULL DEFAULT 0,
        "minUsage"       decimal(20,6),
        "maxUsage"       decimal(20,6) NOT NULL DEFAULT 0,
        "eventCount"     int NOT NULL DEFAULT 0,
        "unit"           varchar(50) NOT NULL,
        "metadata"       jsonb,
        "createdAt"      timestamptz NOT NULL DEFAULT now(),
        "updatedAt"      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_usage_aggregations_tenant_period_periodStart"
        ON billing.usage_aggregations ("tenant_id", "period", "periodStart");
      CREATE INDEX IF NOT EXISTS "IDX_usage_aggregations_tenant_meterType"
        ON billing.usage_aggregations ("tenant_id", "meterType");
    `);

    // billing.usage_hourly_data — single-row-per-(tenant, meter), jsonb values array.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS billing.usage_hourly_data (
        "id"          varchar(100) NOT NULL PRIMARY KEY,
        "tenant_id"   uuid NOT NULL,
        "meterType"   varchar(50) NOT NULL,
        "values"      jsonb NOT NULL DEFAULT '[]'::jsonb,
        "updatedAt"   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_usage_hourly_data_tenant_meterType"
        ON billing.usage_hourly_data ("tenant_id", "meterType");
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'billing');
    await qr.query(`DROP TABLE IF EXISTS billing.usage_hourly_data`);
    await qr.query(`DROP TABLE IF EXISTS billing.usage_aggregations`);
  }
}
