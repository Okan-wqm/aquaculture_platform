import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConfigurationTombstoneLifecycle1800200000000 implements MigrationInterface {
  name = 'ConfigurationTombstoneLifecycle1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"."configurations"
        ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "deleted_by" character varying(100),
        ADD COLUMN IF NOT EXISTS "delete_reason" character varying(255),
        ADD COLUMN IF NOT EXISTS "retention_until" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "suppress_fallback" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config"."configurations"
        DROP COLUMN IF EXISTS "suppress_fallback",
        DROP COLUMN IF EXISTS "retention_until",
        DROP COLUMN IF EXISTS "delete_reason",
        DROP COLUMN IF EXISTS "deleted_by",
        DROP COLUMN IF EXISTS "deleted_at"
    `);
  }
}
