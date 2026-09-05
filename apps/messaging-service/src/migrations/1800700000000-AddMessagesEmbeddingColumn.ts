import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the semantic-search `embedding` column (+ hnsw index) to the messaging
 * `messages` table.
 *
 * WHY (ORPHAN-MEDIUM-055): the embedding column + hnsw index existed ONLY in
 * a deleted service-local init SQL file (which the migration runner never
 * executed) and an archived migration. The active migration set (Baseline +
 * outbox/idempotency contracts) created `embeddings_metadata` but NOT the
 * `messages.embedding` column, so `EmbeddingService.processUnembeddedMessages`
 * queried a non-existent column on every cron tick — failing with
 * "column m.embedding does not exist" and spamming every messaging E2E run.
 *
 * CORRECTED 2026-09-04 (MSG-HIGH-077): this file previously opened `up()` and
 * `down()` with `pinSearchPath(queryRunner, 'messaging')`, and claimed in this
 * docblock that doing so made it tenant-routing-correct. The opposite is true.
 * `messages` is a PER-TENANT table and this migration is not
 * `@SourceOnlyMigration`, but `pinSearchPath` pins its literal argument and has
 * no tenant awareness — so on a tenant pass it OVERRODE the runner's
 * `tenant_<uuid>` pin, the `ADD COLUMN IF NOT EXISTS` no-oped against the
 * source schema's already-present column, and the tenant's ledger recorded a
 * successful apply. No tenant ever received the column. The pin calls are
 * removed here so the statements follow the runner's pin like every other
 * unqualified migration; all three execution paths (db-migrate orchestrator,
 * the service-local runner, and the TypeORM CLI data-source) set the schema
 * before running, so the source-schema result is unchanged.
 *
 * The edit cannot heal the tenants that already recorded this migration as
 * applied — `1802200000000-EnsureTenantMessagesEmbeddingColumn` does that, and
 * carries a `postCondition` so the class cannot recur silently.
 *
 * The `vector` extension is created database-wide at platform bootstrap
 * (db-migrate 001-extensions.sql), so this migration must NOT CREATE EXTENSION
 * (the per-service runner role is least-privilege). Blue-green safe: ADD COLUMN
 * / CREATE INDEX are IF NOT EXISTS.
 */
export class AddMessagesEmbeddingColumn1800700000000 implements MigrationInterface {
  name = 'AddMessagesEmbeddingColumn1800700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_embedding"`);
    await queryRunner.query(`ALTER TABLE messages DROP COLUMN IF EXISTS "embedding"`);
  }
}
