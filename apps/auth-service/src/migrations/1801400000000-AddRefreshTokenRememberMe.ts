import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddRefreshTokenRememberMe1801400000000 (ORPHAN-LOW-135 — full-stack "remember me")
 *
 * WHY: "remember me / stay logged in" cannot be a frontend storage trick — the
 * access token is in-memory-only and the refresh token is a server-set httpOnly
 * cookie. Genuine persistence means the SERVER issues a persistent-vs-session
 * refresh cookie based on the user's choice. This column persists that choice on
 * the refresh-token row so every rotation preserves it (mirroring the familyId
 * lineage precedent) and a remembered session stays persistent across refreshes.
 *
 * Blue-green safe — SINGLE step (unlike familyId, which had no safe default):
 * the column has DEFAULT false, so existing rows backfill to false ("not
 * remembered" — the correct, safest interpretation) and new inserts default to
 * false. No nullable→backfill→NOT NULL second deploy is needed.
 *
 * Idempotent via IF NOT EXISTS / IF EXISTS guards.
 *
 * Timestamp note: 1801300000000 is taken by farm-service (db-migrate aggregates
 * all services), so this uses the next free repo-wide slot, 1801400000000.
 */
export class AddRefreshTokenRememberMe1801400000000 implements MigrationInterface {
  name = 'AddRefreshTokenRememberMe1801400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."refresh_tokens" ADD COLUMN IF NOT EXISTS "rememberMe" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."refresh_tokens" DROP COLUMN IF EXISTS "rememberMe"`,
    );
  }
}
