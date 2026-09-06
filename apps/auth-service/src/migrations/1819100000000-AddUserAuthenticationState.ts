import { MigrationInterface, QueryRunner } from 'typeorm';

/** Authentication state is independent of generic modification timestamps. */
export class AddUserAuthenticationState1819100000000 implements MigrationInterface {
  name = 'AddUserAuthenticationState1819100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE auth.users
      ADD COLUMN IF NOT EXISTS "credentialVersion" integer,
      ADD COLUMN IF NOT EXISTS "accessTokenInvalidBeforeEpochSeconds" bigint`);
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.users'::regclass
        AND ((attname = 'credentialVersion' AND atttypid <> 'integer'::regtype)
          OR (attname = 'accessTokenInvalidBeforeEpochSeconds' AND atttypid <> 'bigint'::regtype))) THEN
        RAISE EXCEPTION 'Incompatible user authentication state columns';
      END IF;
    END $$`);
    await queryRunner.query(`UPDATE auth.users SET "credentialVersion" = 1 WHERE "credentialVersion" IS NULL`);
    await queryRunner.query(`UPDATE auth.users SET "accessTokenInvalidBeforeEpochSeconds" = 0
      WHERE "accessTokenInvalidBeforeEpochSeconds" IS NULL`);
    await queryRunner.query(`ALTER TABLE auth.users
      ALTER COLUMN "credentialVersion" SET DEFAULT 1,
      ALTER COLUMN "accessTokenInvalidBeforeEpochSeconds" SET DEFAULT 0`);
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth'
        AND table_name = 'users' AND column_name = 'credentialVersion' AND is_nullable = 'YES') THEN
        ALTER TABLE auth.users ALTER COLUMN "credentialVersion" SET NOT NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth'
        AND table_name = 'users' AND column_name = 'accessTokenInvalidBeforeEpochSeconds' AND is_nullable = 'YES') THEN
        ALTER TABLE auth.users ALTER COLUMN "accessTokenInvalidBeforeEpochSeconds" SET NOT NULL;
      END IF;
    END $$`);
    await queryRunner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'auth.users'::regclass
        AND conname = 'CHK_users_credential_version_positive') THEN
        ALTER TABLE auth.users ADD CONSTRAINT "CHK_users_credential_version_positive" CHECK ("credentialVersion" > 0);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'auth.users'::regclass
        AND conname = 'CHK_users_access_token_cutoff_range') THEN
        ALTER TABLE auth.users ADD CONSTRAINT "CHK_users_access_token_cutoff_range"
          CHECK ("accessTokenInvalidBeforeEpochSeconds" >= 0 AND "accessTokenInvalidBeforeEpochSeconds" <= 9007199254740991);
      END IF;
    END $$`);
    await queryRunner.query(`DO $$ DECLARE constraint_row record; expression text; BEGIN
      FOR constraint_row IN SELECT conname, contype, convalidated, conbin, conrelid
        FROM pg_constraint WHERE conrelid = 'auth.users'::regclass
          AND conname IN ('CHK_users_credential_version_positive', 'CHK_users_access_token_cutoff_range') LOOP
        expression := replace(regexp_replace(pg_get_expr(constraint_row.conbin, constraint_row.conrelid),
          '[[:space:]"()'']', '', 'g'), '::bigint', '');
        IF constraint_row.contype <> 'c' OR NOT constraint_row.convalidated
          OR (constraint_row.conname = 'CHK_users_credential_version_positive' AND expression <> 'credentialVersion>0')
          OR (constraint_row.conname = 'CHK_users_access_token_cutoff_range'
            AND expression <> 'accessTokenInvalidBeforeEpochSeconds>=0ANDaccessTokenInvalidBeforeEpochSeconds<=9007199254740991') THEN
          RAISE EXCEPTION 'Incompatible authentication state constraint: %', constraint_row.conname;
        END IF;
      END LOOP;
    END $$`);
    await queryRunner.query(`CREATE OR REPLACE FUNCTION auth.users_authentication_state() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW."credentialVersion" := 1;
      ELSE
        IF NEW.password IS DISTINCT FROM OLD.password OR NEW.role IS DISTINCT FROM OLD.role
          OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."isActive" IS DISTINCT FROM OLD."isActive"
          OR NEW."mfaEnabled" IS DISTINCT FROM OLD."mfaEnabled"
          OR ((OLD."mfaEnabled" OR NEW."mfaEnabled") AND NEW."mfaSecret" IS DISTINCT FROM OLD."mfaSecret") THEN
          NEW."credentialVersion" := OLD."credentialVersion" + 1;
        ELSE
          NEW."credentialVersion" := OLD."credentialVersion";
        END IF;
        NEW."accessTokenInvalidBeforeEpochSeconds" := GREATEST(OLD."accessTokenInvalidBeforeEpochSeconds", NEW."accessTokenInvalidBeforeEpochSeconds");
      END IF;
      RETURN NEW;
    END $$`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS users_authentication_state ON auth.users`);
    await queryRunner.query(`CREATE TRIGGER users_authentication_state BEFORE INSERT OR UPDATE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION auth.users_authentication_state()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS users_authentication_state ON auth.users`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS auth.users_authentication_state()`);
    await queryRunner.query(`ALTER TABLE auth.users DROP COLUMN IF EXISTS "credentialVersion",
      DROP COLUMN IF EXISTS "accessTokenInvalidBeforeEpochSeconds"`);
  }
}
