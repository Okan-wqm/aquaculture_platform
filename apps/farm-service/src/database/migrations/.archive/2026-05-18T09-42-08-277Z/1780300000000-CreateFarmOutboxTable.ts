import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateFarmOutboxTable1780300000000
 *
 * Creates the `farm_outbox` table for the transactional outbox pattern.
 *
 * Domain handlers INSERT into this table inside the same DB transaction
 * that performs the domain write (mortality, cull, transfer, harvest, etc.).
 * The OutboxWorkerService (from @platform/outbox) polls every second and
 * publishes pending rows to NATS via IEventBus. Either both DB writes commit
 * or neither — at-least-once delivery is guaranteed even if NATS is down.
 *
 * Index `idx_farm_outbox_poll` is a partial index over the polling predicate
 * (`publishedAt IS NULL`) so the worker's lookup stays fast even when the
 * table grows large with historical/dead-lettered events.
 *
 * @see Phase 2 of farm domain real-time visibility plan.
 */
export class CreateFarmOutboxTable1780300000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger(
    'CreateFarmOutboxTable1780300000000',
  );
  name = 'CreateFarmOutboxTable1780300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s: string = current_schema;
    this.logger.log(`Creating farm_outbox in schema "${s}"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."farm_outbox" (
        "id"           BIGSERIAL PRIMARY KEY,
        "eventType"    VARCHAR(100) NOT NULL,
        "payload"      JSONB NOT NULL,
        "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "publishedAt"  TIMESTAMPTZ,
        "retryCount"   INTEGER NOT NULL DEFAULT 0,
        "lastError"    TEXT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_outbox_poll"
        ON "${s}"."farm_outbox" ("createdAt" ASC)
        WHERE "publishedAt" IS NULL;
    `);

    // Secondary index used by the nightly cleanup job (delete published rows
    // older than 7 days). Partial index keeps it small.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_outbox_published_at"
        ON "${s}"."farm_outbox" ("publishedAt")
        WHERE "publishedAt" IS NOT NULL;
    `);

    this.logger.log('farm_outbox table and indexes created');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s: string = current_schema;

    await queryRunner.query(
      `DROP INDEX IF EXISTS "${s}"."idx_farm_outbox_published_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${s}"."idx_farm_outbox_poll"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "${s}"."farm_outbox"`);
  }
}
