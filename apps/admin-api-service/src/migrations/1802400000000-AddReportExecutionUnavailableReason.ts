import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddReportExecutionUnavailableReason — give an execution somewhere to record
 * WHY a report could not be produced (APA-142).
 *
 * `report_executions.status` had four values, of which `'completed'` was the
 * only success-shaped terminal one. A report over a data source that does not
 * exist therefore landed as `'completed'` with a MinIO artifact, a sha256 and a
 * 7-day download link — cryptographic provenance over something nobody
 * measured. The new `'unavailable'` status separates "nothing to measure" from
 * both "produced" and "broke"; this column carries the reason.
 *
 * It is deliberately NOT `errorMessage`: an absent data source is not an error,
 * and rendering it under an error badge is the same conflation the status split
 * exists to remove.
 *
 * # SAFETY SHAPE (blue-green safe, idempotent)
 *   * One nullable TEXT column. No backfill, no NOT NULL step, no rewrite of
 *     existing rows, no index.
 *   * `status` is VARCHAR(20) with no CHECK constraint
 *     (1800200000000-CreateAdminEntitySurfaceTables.ts), so the new value needs
 *     no DDL of its own — only rows written by the new release can carry it.
 *   * The previous release ignores the column; the new release writes it only
 *     for status `'unavailable'`. Both can run against this schema at once.
 */
export class AddReportExecutionUnavailableReason1802400000000 implements MigrationInterface {
  name = 'AddReportExecutionUnavailableReason1802400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin"."report_executions"
      ADD COLUMN IF NOT EXISTS "unavailableReason" TEXT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin"."report_executions"
      DROP COLUMN IF EXISTS "unavailableReason"
    `);
  }
}
