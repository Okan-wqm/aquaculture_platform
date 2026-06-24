import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Database backup files contain tenant data and must be encrypted at rest.
 * This migration makes that rule a database invariant instead of an API option.
 */
export class BackupEncryptionInvariant1800800000000 implements MigrationInterface {
  name = 'BackupEncryptionInvariant1800800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.schema_backups') IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM "admin"."schema_backups"
              WHERE "isEncrypted" IS DISTINCT FROM true
           )
        THEN
          RAISE EXCEPTION
            'admin.schema_backups contains plaintext backup records; re-encrypt or retire them before enforcing backup encryption';
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."schema_backups"
        ALTER COLUMN "isEncrypted" SET DEFAULT true
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'admin.schema_backups'::regclass
             AND conname = 'chk_schema_backups_encrypted'
        ) THEN
          ALTER TABLE "admin"."schema_backups"
            ADD CONSTRAINT "chk_schema_backups_encrypted"
            CHECK ("isEncrypted" IS TRUE) NOT VALID;
          ALTER TABLE "admin"."schema_backups"
            VALIDATE CONSTRAINT "chk_schema_backups_encrypted";
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      ALTER TABLE "admin"."schema_backups"
        DROP CONSTRAINT IF EXISTS "chk_schema_backups_encrypted"
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."schema_backups"
        ALTER COLUMN "isEncrypted" SET DEFAULT false
    `);
  }
}
