import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddMobileFeatureFlagDefaults1805300000000 (FARM-HIGH-214 / Phase 6)
 *
 * WHY: MobileAllowedFeatures gained liceCount/welfare/escape/reports (the
 * AquaMobil regulatory field-capture + report surface). The
 * `allowed_features` jsonb column DEFAULT embeds the serialized
 * DEFAULT_MOBILE_FEATURES object, so the entity edit IS a DDL delta: new
 * user rows must be seeded with the full 16-flag vocabulary. Existing rows
 * need no backfill — MobileSettingsService.getByUserId spreads
 * DEFAULT_MOBILE_FEATURES underneath the stored jsonb on every read
 * (forward-compatibility merge), so absent keys resolve to their defaults.
 *
 * Blue-green safe — a column DEFAULT swap takes no table rewrite. Idempotent:
 * SET DEFAULT is naturally last-write-wins.
 *
 * Timestamp note: db-migrate aggregates all services repo-wide;
 * 1805200000000 is taken by farm-service in this same PR, so this uses the
 * next free repo-wide slot, 1805300000000.
 */
export class AddMobileFeatureFlagDefaults1805300000000 implements MigrationInterface {
  name = 'AddMobileFeatureFlagDefaults1805300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "auth"."mobile_user_settings"
        ALTER COLUMN "allowed_features" SET DEFAULT '{
          "mortality": true, "cull": true, "harvest": true, "feeding": true,
          "waterQuality": true, "tankView": true, "transfer": true,
          "schedule": true, "attendance": true, "leave": true, "tasks": true,
          "storage": true, "liceCount": true, "welfare": true, "escape": true,
          "reports": true
        }'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "auth"."mobile_user_settings"
        ALTER COLUMN "allowed_features" SET DEFAULT '{
          "mortality": true, "cull": true, "harvest": true, "feeding": true,
          "waterQuality": true, "tankView": true, "transfer": true,
          "schedule": true, "attendance": true, "leave": true, "tasks": true,
          "storage": true
        }'::jsonb
    `);
  }
}
