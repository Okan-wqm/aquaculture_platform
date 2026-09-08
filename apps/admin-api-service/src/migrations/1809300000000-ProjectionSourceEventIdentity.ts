import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ProjectionSourceEventIdentity — a projected row carries the identity of the
 * event that produced it (ADMIN-HIGH-014, ADR-0018).
 *
 * WHY: `admin.login_attempts` and `admin.api_usage_logs` are now written by a
 * JetStream consumer, and JetStream delivers AT LEAST ONCE. The consumer NAKs
 * on failure so a transient database error retries instead of losing a
 * security fact — which means a handler that fails after its INSERT committed
 * will run that INSERT again on redelivery.
 *
 * Both tables feed threshold detectors: five failed logins inside the window
 * is a `brute_force_attempt`. A duplicated row is therefore not a cosmetic
 * blemish, it is a manufactured security alert; and the mirror case, dropping
 * the retry to avoid duplicates, is a missed one. Neither is acceptable in a
 * detection path, so the duplicate is made structurally impossible instead of
 * being avoided by careful code: the projection writes the source event's id
 * and PostgreSQL refuses the second copy.
 *
 * The index is PARTIAL. `sourceEventId` is NULL for a row written by any path
 * other than the projection, and `NULL` values are distinct under a plain
 * unique index anyway — the predicate states the intent rather than relying on
 * that, and keeps the index the size of the projected set.
 *
 * Blue-green: the column is nullable with no backfill and no NOT NULL step, so
 * a replica running the previous image writes rows this index ignores.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */
export class ProjectionSourceEventIdentity1809300000000 implements MigrationInterface {
  name = 'ProjectionSourceEventIdentity1809300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(
      `ALTER TABLE "admin"."login_attempts" ADD COLUMN IF NOT EXISTS "sourceEventId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin"."api_usage_logs" ADD COLUMN IF NOT EXISTS "sourceEventId" uuid`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_login_attempts_source_event"
         ON "admin"."login_attempts" ("sourceEventId")
         WHERE "sourceEventId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_api_usage_logs_source_event"
         ON "admin"."api_usage_logs" ("sourceEventId")
         WHERE "sourceEventId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`DROP INDEX IF EXISTS "admin"."uk_api_usage_logs_source_event"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "admin"."uk_login_attempts_source_event"`);
    await queryRunner.query(
      `ALTER TABLE "admin"."api_usage_logs" DROP COLUMN IF EXISTS "sourceEventId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin"."login_attempts" DROP COLUMN IF EXISTS "sourceEventId"`,
    );
  }
}
