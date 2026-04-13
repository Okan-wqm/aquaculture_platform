import { MigrationInterface, QueryRunner } from 'typeorm';

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
 */
export class AddMissingOutboxColumns1782200000000 implements MigrationInterface {
  name = 'AddMissingOutboxColumns1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

    // Update polling index to include new dead-letter and lease filters
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_outbox_poll";
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
        ON "messaging_outbox" ("createdAt")
        WHERE "publishedAt" IS NULL
          AND "isDeadLettered" = false
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
          AND ("leasedAt" IS NULL OR "leasedAt" < NOW() - INTERVAL '5 minutes');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_poll"`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
        ON "messaging_outbox" ("createdAt")
        WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= NOW();
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
