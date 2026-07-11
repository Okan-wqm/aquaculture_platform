import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddReportDraftDeadlineNotifiedBucket1803750000000
 *
 * Deadline-notification dedup state on regulatory_report_drafts (RPT-003):
 * `deadlineNotifiedBucket` records the last deadline bucket (APPROACHING /
 * DUE_SOON / DUE / OVERDUE) an outbox RegulatoryReportDeadlineApproachingEvent
 * was raised for. The daily deadline sweep enqueues the event + updates this
 * column in ONE transaction, and only when the computed bucket differs — so a
 * reminder fires exactly once per bucket transition without relying on catching
 * the outbox unique-key violation.
 *
 * Blue-green safe: nullable column, no backfill (a null means "not yet
 * notified"). current_schema-relative, idempotent, forward-only.
 */
export class AddReportDraftDeadlineNotifiedBucket1803750000000 implements MigrationInterface {
  name = 'AddReportDraftDeadlineNotifiedBucket1803750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "regulatory_report_drafts"
        ADD COLUMN IF NOT EXISTS "deadlineNotifiedBucket" varchar(16)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "regulatory_report_drafts" DROP COLUMN IF EXISTS "deadlineNotifiedBucket"`,
    );
  }
}
