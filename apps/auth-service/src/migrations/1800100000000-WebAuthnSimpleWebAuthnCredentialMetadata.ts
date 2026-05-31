import { MigrationInterface, QueryRunner } from 'typeorm';

export class WebAuthnSimpleWebAuthnCredentialMetadata1800100000000 implements MigrationInterface {
  name = 'WebAuthnSimpleWebAuthnCredentialMetadata1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE auth.webauthn_credentials
        ADD COLUMN IF NOT EXISTS "webAuthnUserId" varchar(255),
        ADD COLUMN IF NOT EXISTS "version" integer,
        ADD COLUMN IF NOT EXISTS "deviceType" varchar(30),
        ADD COLUMN IF NOT EXISTS "backedUp" boolean,
        ADD COLUMN IF NOT EXISTS "aaguid" varchar(64)
    `);
    await queryRunner.query(`
      UPDATE auth.webauthn_credentials
      SET "version" = 1
      WHERE "version" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE auth.webauthn_credentials
        ALTER COLUMN "version" SET DEFAULT 2,
        ALTER COLUMN "backedUp" SET DEFAULT false
    `);
    await queryRunner.query(`
      UPDATE auth.webauthn_credentials
      SET "backedUp" = false
      WHERE "backedUp" IS NULL
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'auth'
            AND table_name = 'webauthn_credentials'
            AND column_name = 'version'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE auth.webauthn_credentials ALTER COLUMN "version" SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'auth'
            AND table_name = 'webauthn_credentials'
            AND column_name = 'backedUp'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE auth.webauthn_credentials ALTER COLUMN "backedUp" SET NOT NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE auth.webauthn_credentials
        DROP COLUMN IF EXISTS "aaguid",
        DROP COLUMN IF EXISTS "backedUp",
        DROP COLUMN IF EXISTS "deviceType",
        DROP COLUMN IF EXISTS "version",
        DROP COLUMN IF EXISTS "webAuthnUserId"
    `);
  }
}
