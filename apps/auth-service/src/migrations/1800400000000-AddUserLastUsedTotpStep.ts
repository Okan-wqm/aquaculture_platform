import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddUserLastUsedTotpStep1800400000000 (SEC-HIGH-001)
 *
 * WHY: TOTP codes were not one-time-use — a code captured (shoulder-surf,
 * proxy, log leak, MITM of the verify mutation) could be replayed any number
 * of times within its ±window validity across login AND step-up. This column
 * records the last consumed TOTP time-step; verification persists the matched
 * step and rejects any code whose step is ≤ the stored value.
 *
 * Nullable + no backfill: existing rows have never consumed a step, so NULL
 * correctly means "no prior step" and the first verification sets it. bigint
 * (epoch/period) never wraps. Idempotent via IF NOT EXISTS.
 */
export class AddUserLastUsedTotpStep1800400000000 implements MigrationInterface {
  name = 'AddUserLastUsedTotpStep1800400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "lastUsedTotpStep" bigint NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."users" DROP COLUMN IF EXISTS "lastUsedTotpStep"`,
    );
  }
}
