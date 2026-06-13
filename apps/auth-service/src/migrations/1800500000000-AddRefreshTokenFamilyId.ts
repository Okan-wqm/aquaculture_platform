import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddRefreshTokenFamilyId1800500000000 (SEC-MEDIUM-003)
 *
 * WHY: refresh-token reuse-detection revoked the ENTIRE user's token chain on
 * a single replay (one stale cookie logged the user out of every device) and
 * the emitted SecurityEvent could not carry a true family-id. This column is
 * the rotation lineage: a fresh login starts a new family; each rotation
 * carries the family forward. Reuse-detection then revokes only the suspect
 * token's family.
 *
 * Blue-green safe:
 *   1. add the column nullable,
 *   2. backfill every existing row with its OWN id as the family (each legacy
 *      token becomes a singleton family — the safest interpretation, since we
 *      cannot reconstruct historical rotation lineage),
 *   3. create the lookup index.
 * The column stays nullable (no NOT NULL constraint) because the application
 * tolerates legacy NULL families by falling back to the user-wide revoke, and
 * a NOT NULL backfill-then-constrain would need a second deploy; nullable +
 * application-default is the correct contract here.
 *
 * Idempotent via IF NOT EXISTS / IF EXISTS guards.
 */
export class AddRefreshTokenFamilyId1800500000000 implements MigrationInterface {
  name = 'AddRefreshTokenFamilyId1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."refresh_tokens" ADD COLUMN IF NOT EXISTS "familyId" uuid NULL`,
    );
    // Backfill: each existing token becomes its own singleton family.
    await queryRunner.query(
      `UPDATE "auth"."refresh_tokens" SET "familyId" = "id" WHERE "familyId" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_family" ON "auth"."refresh_tokens" ("familyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "auth"."IDX_refresh_tokens_family"`);
    await queryRunner.query(
      `ALTER TABLE "auth"."refresh_tokens" DROP COLUMN IF EXISTS "familyId"`,
    );
  }
}
