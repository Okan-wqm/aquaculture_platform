import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ErrorGroupUserCountDerived — `admin.error_groups."userCount"` is removed
 * because it never counted users (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * WHY: `ErrorTrackingService.reportError` incremented it whenever the report's
 * tenant was one it had not seen on that group before — so it was a distinct
 * TENANT count wearing a user's name, and it moved only when `report.userId`
 * happened to be set at the same time. Its sole consumer is the alert rule's
 * `userCountThreshold`, which is the one place that actually needs the number,
 * and which can compute the real thing: `COUNT(DISTINCT "userId")` over
 * `admin.error_occurrences` for the group.
 *
 * Keeping a stored counter would mean either tracking every affected user id
 * in a jsonb array on `error_groups` — unbounded, and PII in a table the
 * tenant-erasure registry marks `excluded` — or an extra query per error on the
 * ingest path. Deriving it at threshold-evaluation time costs one query per
 * rule that asks for it, after the cheaper predicates have already run, and
 * only for rules that declare the threshold at all.
 *
 * The column had no reader outside that threshold: no controller, no DTO, no
 * admin-panel page. A stored number nothing maintains correctly is exactly the
 * class of defect this audit is about, so it goes rather than being carried.
 *
 * Blue-green: the reverse step re-adds the column with its original default, so
 * an older replica writing it finds it there.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */
export class ErrorGroupUserCountDerived1809700000000 implements MigrationInterface {
  name = 'ErrorGroupUserCountDerived1809700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`ALTER TABLE "admin"."error_groups" DROP COLUMN IF EXISTS "userCount"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(
      `ALTER TABLE "admin"."error_groups" ADD COLUMN IF NOT EXISTS "userCount" integer NOT NULL DEFAULT 0`,
    );
  }
}
