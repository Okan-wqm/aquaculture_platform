import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddReportExecutionPreviewRows — give an execution somewhere to keep the first
 * few generated rows so the UI preview has a source (APA-144).
 *
 * The report body lives only in object storage, and a csv or pdf artifact
 * cannot be losslessly re-rowed, so no read-back endpoint could have supplied a
 * preview either. Without this column the modal's table branch was dead from
 * the day it shipped: it answered "No data available" beside a non-zero row
 * count, and the "showing first 10 records" note was unreachable.
 *
 * # SAFETY SHAPE (blue-green safe, idempotent)
 *   * One nullable JSONB column. No backfill, no NOT NULL step, no index.
 *   * Existing rows stay NULL ON PURPOSE — a reconstructed preview would be
 *     worse than none, and the UI renders "preview unavailable, download the
 *     report" for them rather than inventing one.
 *   * The previous release ignores the column; the new release writes it at
 *     execution time. Both run against this schema at once.
 */
export class AddReportExecutionPreviewRows1802500000000 implements MigrationInterface {
  name = 'AddReportExecutionPreviewRows1802500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin"."report_executions"
      ADD COLUMN IF NOT EXISTS "previewRows" JSONB NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin"."report_executions"
      DROP COLUMN IF EXISTS "previewRows"
    `);
  }
}
