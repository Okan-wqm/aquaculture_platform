import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropTenantFarmSensorCounts1800900000000 (MT-MEDIUM-002)
 *
 * WHY: auth.tenants carried denormalized `farm_count` / `sensor_count` columns
 * with NO maintainer — every writer set them to 0 and nothing ever reconciled
 * them as farms/sensors were created in the tenant's own schema. The admin-api
 * tenant-detail view read them and rendered a permanently-0 resource-usage
 * figure (verified against the live schema: always 0). Unlike `user_count`
 * (maintained in auth at user-creation time), farms and sensors are owned by the
 * per-tenant `tenant_<uuid>.farms` / `tenant_<uuid>.sensors` tables, which auth
 * cannot maintain without consuming cross-service events.
 *
 * The correct SSoT is the owning per-tenant tables. This migration removes the
 * stale denormalization from auth.tenants; admin-api now computes the real
 * counts at read time from those tables (same cross-schema analytics pattern it
 * already uses for user stats).
 *
 * BREAKING CHANGE: drops auth.tenants.farm_count and auth.tenants.sensor_count.
 *
 * R10 idempotency: each DROP is guarded on column existence, so a replay is a
 * clean no-op. Blue-green safe: an older revision still writing 0 to these
 * columns is gone before this runs (the new revision drops the entity fields);
 * the columns are never read for correctness, only the (stale) display.
 */
export class DropTenantFarmSensorCounts1800900000000 implements MigrationInterface {
  name = 'DropTenantFarmSensorCounts1800900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: drops auth.tenants.farm_count / sensor_count. Rollback =
    // down() re-adds them as integer DEFAULT 0; the data is NOT restored, but it
    // was an unmaintained always-0 denormalization with no source of truth, so no
    // real data is lost. Requires a pg_dump backup + ops stage-gate per the
    // MT-MEDIUM-002 PR. Idempotent (DROP COLUMN IF EXISTS) so a replay is a no-op.
    for (const column of ['farm_count', 'sensor_count']) {
      await queryRunner.query(
        `ALTER TABLE "auth"."tenants" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ['farm_count', 'sensor_count']) {
      await queryRunner.query(
        `ALTER TABLE "auth"."tenants" ADD COLUMN IF NOT EXISTS "${column}" integer NOT NULL DEFAULT 0`,
      );
    }
  }
}
