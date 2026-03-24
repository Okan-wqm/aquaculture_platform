import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise migration: Add accessType column to auth.users table.
 *
 * WHY: Platform needs to distinguish between panel-only, mobile-only,
 * and dual-access users. This enables auto-provisioning of mobile_user_settings
 * during user creation and enforces access control at the platform level.
 *
 * SAFETY: Uses IF NOT EXISTS / IF EXISTS patterns for idempotent execution.
 * Can be re-run safely on any environment without data loss.
 */
export class AddUserAccessType1711700000000 implements MigrationInterface {
  name = 'AddUserAccessType1711700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add accessType column if it doesn't already exist (idempotent)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'auth'
            AND table_name = 'users'
            AND column_name = 'accessType'
        ) THEN
          ALTER TABLE auth.users
          ADD COLUMN "accessType" varchar(20) DEFAULT 'BOTH';

          COMMENT ON COLUMN auth.users."accessType"
          IS 'Controls platform access: PANEL_ONLY, MOBILE_ONLY, or BOTH';
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'auth'
            AND table_name = 'users'
            AND column_name = 'accessType'
        ) THEN
          ALTER TABLE auth.users DROP COLUMN "accessType";
        END IF;
      END
      $$;
    `);
  }
}
