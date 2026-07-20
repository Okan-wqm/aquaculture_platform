import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Register the Marine Explorer rollout switch in the existing admin feature
 * toggle SSoT. It starts disabled and tenant-scoped with an empty allowlist;
 * both status=enabled and explicit tenant membership are required to activate.
 */
export class SeedMarineExplorerFeatureToggle1801600000000 implements MigrationInterface {
  name = 'SeedMarineExplorerFeatureToggle1801600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "admin"."feature_toggles" AS target (
        "key",
        "name",
        "description",
        "scope",
        "status",
        "category",
        "enabledTenants",
        "disabledTenants",
        "metadata",
        "defaultValue",
        "requiresRestart",
        "isExperimental"
      )
      VALUES (
        'marine_explorer',
        'Marine Data Explorer',
        'Tenant allowlist gate for the canonical Marine Data Explorer runtime',
        'tenant',
        'disabled',
        'marine',
        '[]'::jsonb,
        '[]'::jsonb,
        '{"seed":"marine-explorer-phase-1","authority":"admin.feature_toggles"}'::jsonb,
        'false'::jsonb,
        false,
        true
      )
      ON CONFLICT ("key") DO NOTHING;

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "admin"."feature_toggles"
          WHERE "key" = 'marine_explorer'
            AND "scope" <> 'tenant'
        ) THEN
          RAISE EXCEPTION 'marine_explorer must be tenant-scoped before rollout';
        END IF;
      END
      $$
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only rollout safety record. Deleting it on rollback could turn a
    // missing-toggle assumption into a split-brain with another deployed pod,
    // and an operator may already have attached audit-relevant policy metadata.
  }
}
