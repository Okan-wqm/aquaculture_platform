import { pinSearchPath } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the semantic-search `embedding` column (+ hnsw index) to the messaging
 * `messages` table.
 *
 * WHY (ORPHAN-MEDIUM-055): the embedding column + hnsw index existed ONLY in
 * the orphan `init-messaging-schema.sql` (which the migration runner never
 * executes) and an archived migration. The active migration set (Baseline +
 * outbox/idempotency contracts) created `embeddings_metadata` but NOT the
 * `messages.embedding` column, so `EmbeddingService.processUnembeddedMessages`
 * queried a non-existent column on every cron tick — failing with
 * "column m.embedding does not exist" and spamming every messaging E2E run.
 *
 * Tenant-routing-correct (tenant-aware-migration-ddl-guard): the DDL is
 * UNQUALIFIED and the search_path is pinned via `pinSearchPath`, so the runner
 * applies it to whatever schema it is processing — the `messaging` source
 * schema here, and any tenant clone the runner pins — instead of hard-coding
 * `messaging.messages` (which would only ever touch the source schema and
 * break tenant-clone routing).
 *
 * The `vector` extension is created database-wide at platform bootstrap
 * (db-migrate 001-extensions.sql), so this migration must NOT CREATE EXTENSION
 * (the per-service runner role is least-privilege). Blue-green safe: ADD COLUMN
 * / CREATE INDEX are IF NOT EXISTS.
 */
export class AddMessagesEmbeddingColumn1800700000000 implements MigrationInterface {
  name = 'AddMessagesEmbeddingColumn1800700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');
    await queryRunner.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "embedding" vector(384)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_embedding" ` +
        `ON messages USING hnsw ("embedding" vector_cosine_ops) ` +
        `WITH (m = 16, ef_construction = 200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_embedding"`);
    await queryRunner.query(`ALTER TABLE messages DROP COLUMN IF EXISTS "embedding"`);
  }
}
