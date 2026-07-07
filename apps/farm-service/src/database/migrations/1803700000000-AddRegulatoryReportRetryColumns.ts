import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddRegulatoryReportRetryColumns1803700000000
 *
 * Retry pipeline state on regulatory_reports (RPT-018): attempt_count,
 * next_attempt_at (when a TRANSIENT failure may be replayed), and
 * failure_class (TRANSIENT vs PERMANENT). The 30-minute retry sweep replays a
 * FAILED + TRANSIENT row whose next_attempt_at has passed, re-sending the
 * persisted payload under the SAME klientReferanse (Mattilsynet idempotency).
 *
 * Blue-green safe: attempt_count is NOT NULL with a DEFAULT (old-code inserts
 * get 0); the rest are nullable. The failure-class enum is created per-schema
 * for the (already per-tenant) regulatory_reports table.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class AddRegulatoryReportRetryColumns1803700000000 implements MigrationInterface {
  name = 'AddRegulatoryReportRetryColumns1803700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE regulatory_reports_failureclass_enum AS ENUM ('TRANSIENT', 'PERMANENT');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "regulatory_reports"
        ADD COLUMN IF NOT EXISTS "attemptCount" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "regulatory_reports"
        ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamptz
    `);
    await queryRunner.query(`
      ALTER TABLE "regulatory_reports"
        ADD COLUMN IF NOT EXISTS "failureClass" regulatory_reports_failureclass_enum
    `);

    // The retry sweep scans FAILED + TRANSIENT rows whose next_attempt_at is due.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_regulatory_reports_retry_due"
        ON "regulatory_reports" ("tenantId", "status", "nextAttemptAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_regulatory_reports_retry_due"`);
    await queryRunner.query(
      `ALTER TABLE "regulatory_reports" DROP COLUMN IF EXISTS "failureClass"`,
    );
    await queryRunner.query(
      `ALTER TABLE "regulatory_reports" DROP COLUMN IF EXISTS "nextAttemptAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "regulatory_reports" DROP COLUMN IF EXISTS "attemptCount"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS regulatory_reports_failureclass_enum`);
  }
}
