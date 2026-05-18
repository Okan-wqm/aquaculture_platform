import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  tableExists,
} from '@aquaculture/backend-common/database';

/**
 * Adds columns to messaging_outbox that OutboxEntityBase declares but
 * no prior migration created:
 *   - aggregateId (UUID, nullable) — domain aggregate correlation
 *   - nextAttemptAt (TIMESTAMPTZ, nullable) — exponential backoff scheduling
 *   - idempotencyKey (VARCHAR 255, nullable) — dedup for enqueue retries
 *   - isDeadLettered (BOOLEAN, default false) — fast-path dead-letter filter
 *   - leasedAt (TIMESTAMPTZ, nullable) — worker lease acquisition timestamp
 *   - leasedBy (VARCHAR 128, nullable) — worker identity for debugging
 *
 * These columns were inherited from @platform/outbox OutboxEntityBase but
 * were added to the base class after the initial messaging_outbox migration.
 * Production may already have some via synchronize:true or manual ALTER.
 * Each ADD COLUMN uses IF NOT EXISTS for idempotent reruns.
 *
 * # Bootstrap-restoration guard (Wave 4-A.2 Dalga 3)
 *
 * `messaging_outbox` is created by sibling migration
 * 1711800000000-CreateMessagingTables. On a fresh-volume bootstrap that
 * runs this migration before the baseline lands the table, the ALTER
 * blocks crash with `relation "messaging_outbox" does not exist`. The
 * up()/down() bodies are guarded with `tableExists` so the migration
 * skips cleanly when the parent table is absent.
 */
export class AddMissingOutboxColumns1782200000000 implements MigrationInterface {
  name = 'AddMissingOutboxColumns1782200000000';

  private readonly logger = new MigrationLogger(
    'AddMissingOutboxColumns1782200000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await tableExists(queryRunner, 'messaging_outbox'))) {
      this.logger.log(
        'Skipping AddMissingOutboxColumns — messaging_outbox not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    // All columns use IF NOT EXISTS — safe to run even if some columns
    // were already added manually in production.
    const columns = [
      `ALTER TABLE "messaging_outbox" ADD COLUMN IF NOT EXISTS "aggregateId" UUID`,
      `ALTER TABLE "messaging_outbox" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ`,
      `ALTER TABLE "messaging_outbox" ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(255)`,
      `ALTER TABLE "messaging_outbox" ADD COLUMN IF NOT EXISTS "isDeadLettered" BOOLEAN DEFAULT false NOT NULL`,
      `ALTER TABLE "messaging_outbox" ADD COLUMN IF NOT EXISTS "leasedAt" TIMESTAMPTZ`,
      `ALTER TABLE "messaging_outbox" ADD COLUMN IF NOT EXISTS "leasedBy" VARCHAR(128)`,
    ];

    for (const sql of columns) {
      await queryRunner.query(sql);
    }

    // Update polling index to include dead-letter filter.
    //
    // WHY no NOW() in predicate: PostgreSQL requires functions in index
    // predicates to be IMMUTABLE. NOW() is VOLATILE and rejected. The
    // time-based filters (nextAttemptAt <= NOW(), leasedAt expiry) are
    // applied at query time in OutboxWorkerService, not in the index.
    // The index still dramatically reduces the scan set by filtering
    // out published and dead-lettered rows.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_outbox_poll";
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
        ON "messaging_outbox" ("createdAt")
        WHERE "publishedAt" IS NULL AND "isDeadLettered" = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await tableExists(queryRunner, 'messaging_outbox'))) {
      return;
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_poll"`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
        ON "messaging_outbox" ("createdAt")
        WHERE "publishedAt" IS NULL;
    `);

    const columns = [
      'leasedBy', 'leasedAt', 'isDeadLettered',
      'idempotencyKey', 'nextAttemptAt', 'aggregateId',
    ];
    for (const col of columns) {
      await queryRunner.query(
        `ALTER TABLE "messaging_outbox" DROP COLUMN IF EXISTS "${col}"`,
      );
    }
  }
}
