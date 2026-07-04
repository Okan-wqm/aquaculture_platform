import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddBatchProtocolId1802000000000
 *
 * Adds `batches_v2.protocolId` — the feeding protocol a batch is created with.
 * A batch assigns exactly one protocol; because the batch identity persists
 * across tank transfers, the protocol follows the fish automatically, and the
 * association ends when the batch is harvested/closed. The daily feed rate is
 * computed from this protocol (feedPercent band × temperature multiplier) by
 * FeedingProtocolRateService.
 *
 * Soft reference (nullable, no FK): a protocol is a reference catalogue, and
 * deleting one must not be blocked by — nor cascade-corrupt — batches; the feed
 * calc simply falls back to its non-protocol path when the protocol is absent.
 * No hard FK also keeps the migration robust across tenant schemas that may not
 * yet hold `feeding_protocols`.
 *
 * current_schema-relative: db-migrate fans farm migrations out with search_path
 * pinned to `farm` and each `tenant_<uuid>`, so unqualified `batches_v2` is the
 * only correct target. Idempotent (IF NOT EXISTS), forward-only, blue-green safe
 * (nullable column — old pods writing NULL never fail mid-rollout).
 */
export class AddBatchProtocolId1802000000000 implements MigrationInterface {
  name = 'AddBatchProtocolId1802000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "batches_v2"
        ADD COLUMN IF NOT EXISTS "protocolId" uuid
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_protocolId"
        ON "batches_v2" ("protocolId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query('DROP INDEX IF EXISTS "IDX_batches_v2_protocolId"');
    await queryRunner.query(`
      ALTER TABLE "batches_v2" DROP COLUMN IF EXISTS "protocolId"
    `);
  }
}
