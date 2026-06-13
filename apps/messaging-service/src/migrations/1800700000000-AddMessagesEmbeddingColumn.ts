import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the semantic-search `embedding` column (+ hnsw index) to messaging.messages.
 *
 * WHY (ORPHAN-MEDIUM-055): the embedding column + hnsw index existed ONLY in
 * the orphan `init-messaging-schema.sql` (which the migration runner never
 * executes) and an archived migration. The active migration set (Baseline +
 * outbox/idempotency contracts) created `embeddings_metadata` but NOT the
 * `messages.embedding` column, so `EmbeddingService.processUnembeddedMessages`
 * queried a non-existent column on every cron tick — failing with
 * "column m.embedding does not exist" (and spamming every messaging E2E run).
 * This ports the column DDL into the runner-owned source-schema migration set
 * so the semantic-search feature's schema is real and the cron query succeeds.
 *
 * The `vector` extension is created database-wide at platform bootstrap
 * (db-migrate 001-extensions.sql), so this migration must NOT CREATE EXTENSION
 * (the per-service runner role is least-privilege and cannot). Blue-green safe:
 * ADD COLUMN / CREATE INDEX are IF NOT EXISTS. Qualified to `messaging` and
 * decorator-free, matching how Baseline created `messages` (per-tenant table
 * cloned from the source schema by TenantSchemaSyncService).
 */
export class AddMessagesEmbeddingColumn1800700000000 implements MigrationInterface {
  name = 'AddMessagesEmbeddingColumn1800700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messaging"."messages" ADD COLUMN IF NOT EXISTS "embedding" vector(384)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_embedding" ` +
        `ON "messaging"."messages" USING hnsw ("embedding" vector_cosine_ops) ` +
        `WITH (m = 16, ef_construction = 200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "messaging"."idx_messages_embedding"`);
    await queryRunner.query(`ALTER TABLE "messaging"."messages" DROP COLUMN IF EXISTS "embedding"`);
  }
}
