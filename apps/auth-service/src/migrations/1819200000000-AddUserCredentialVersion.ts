import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddUserCredentialVersion1819200000000
 * ============================================================================
 *
 * Gives `auth.users` an integer `credentialVersion` that the database itself
 * advances whenever an authorization-bearing column changes, so token issuance
 * can fence on "the credentials I authenticated against are still the
 * credentials on the row" with an exact integer comparison.
 *
 * # Why a version column and not `updatedAt`
 *
 * The issuance fence in `TokenService.generateTokens` used to add
 * `updatedAt = <value loaded at authentication>` to its `SELECT … FOR UPDATE`
 * predicate. That equality can never hold:
 *
 *   - TypeORM writes `@UpdateDateColumn` as `SET "updatedAt" = CURRENT_TIMESTAMP`
 *     (`UpdateQueryBuilder.createUpdateExpression`), so the stored value carries
 *     Postgres' microsecond precision;
 *   - the `pg` driver hydrates `timestamptz` into a JavaScript `Date`, which
 *     holds milliseconds — the microsecond remainder is discarded on the way
 *     into the entity and can never be sent back.
 *
 * Every login therefore ended in `ForbiddenException('User credentials changed
 * during token issuance')` — production issued zero refresh tokens from the
 * moment the fence deployed (2026-09-03) until this migration. `updatedAt` is
 * also the wrong signal: the login path writes `lastLoginAt`, `lastLoginIp`
 * and `failedLoginAttempts` on the same row before minting, so a generic
 * modification timestamp cannot distinguish "an administrator changed this
 * account" from "this very request finished authenticating".
 *
 * # Why the database owns the counter
 *
 * A `BEFORE UPDATE` trigger compares `password`, `role`, `tenantId` and
 * `isActive` between OLD and NEW and increments the version only when one of
 * them changes; in every other case it pins NEW to OLD. The application can
 * therefore neither forget to bump the counter nor bump it by accident, and a
 * raw SQL update from an operator or another service is covered by the same
 * rule. The entity maps the column with `update: false`, so the value read at
 * authentication time survives the login's own bookkeeping `save()` as the
 * fence anchor.
 *
 * Blue-green: adding a NOT NULL column with a constant default is metadata-only
 * on Postgres 11+, and the running (pre-migration) service never names the
 * column, so its INSERTs receive the default and its UPDATEs pass through the
 * trigger untouched.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-CRITICAL-808
 */
export class AddUserCredentialVersion1819200000000 implements MigrationInterface {
  name = 'AddUserCredentialVersion1819200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "auth"."users"
        ADD COLUMN IF NOT EXISTS "credentialVersion" integer NOT NULL DEFAULT 1
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "auth".users_bump_credential_version()
      RETURNS trigger AS $credentialversion$
      BEGIN
        IF NEW."password"  IS DISTINCT FROM OLD."password"
        OR NEW."role"      IS DISTINCT FROM OLD."role"
        OR NEW."tenantId"  IS DISTINCT FROM OLD."tenantId"
        OR NEW."isActive"  IS DISTINCT FROM OLD."isActive" THEN
          NEW."credentialVersion" := OLD."credentialVersion" + 1;
        ELSE
          NEW."credentialVersion" := OLD."credentialVersion";
        END IF;
        RETURN NEW;
      END;
      $credentialversion$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_users_bump_credential_version ON "auth"."users"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_users_bump_credential_version
        BEFORE UPDATE ON "auth"."users"
        FOR EACH ROW EXECUTE FUNCTION "auth".users_bump_credential_version()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_users_bump_credential_version ON "auth"."users"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "auth".users_bump_credential_version()
    `);
    await queryRunner.query(`
      ALTER TABLE "auth"."users" DROP COLUMN IF EXISTS "credentialVersion"
    `);
  }
}
