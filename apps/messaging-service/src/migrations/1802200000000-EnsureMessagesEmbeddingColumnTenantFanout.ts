import { pinSearchPath, assertSafeSchemaName } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ensure the semantic-search `embedding` column exists in EVERY existing
 * tenant schema (MSGFIX-FAZ2 2.1b).
 *
 * WHY: 1800700000000-AddMessagesEmbeddingColumn added `messages.embedding`
 * with UNQUALIFIED DDL under `pinSearchPath(queryRunner, 'messaging')`, so it
 * landed in the `messaging` SOURCE schema — but the live diagnosis showed
 * the column is MISSING from provisioned `tenant_<uuid>` schemas (they were
 * cloned before that migration, and the migration runner only re-pins tenant
 * clones at provision time). Result: `search-similar-messages.handler.ts`
 * ran `SELECT ... m."embedding" <=> ...` against tenant schemas without the
 * column and the similarMessages GraphQL query returned HTTP 500 for every
 * tenant. Keeping the column NULLABLE + fanning it out also means the GDPR
 * erasure `UPDATE messages SET embedding = NULL` (gdpr.service.ts and
 * messaging-nats.handler UserDeleted cascade) stops failing on old tenants.
 *
 * The Faz 2.1 decision on the column: KEEP it (nullable) even though the
 * embedding cron was deleted — the search path, the GDPR sweeps, and any
 * future re-introduction of embedding generation all read/write this column;
 * dropping it would be a destructive change with no Faz 2 benefit.
 *
 * Deliberately NOT `@SourceOnlyMigration` — the whole point is the per-tenant
 * fan-out. Each schema name from information_schema is re-validated through
 * `assertSafeSchemaName` before SQL identifier interpolation (defense in
 * depth against a tampered catalog). Idempotent: ADD COLUMN IF NOT EXISTS /
 * CREATE INDEX IF NOT EXISTS, safe to re-run.
 */
export class EnsureMessagesEmbeddingColumnTenantFanout1802200000000 implements MigrationInterface {
  name = 'EnsureMessagesEmbeddingColumnTenantFanout1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Source schema (keeps parity with 1800700000000 for fresh installs
    //    where this migration may run before/after it — IF NOT EXISTS makes
    //    the order irrelevant).
    await pinSearchPath(queryRunner, 'messaging');
    await this.addColumnIfMissing(queryRunner, 'messaging');

    // 2. Every provisioned tenant schema. Same enumeration guard the runtime
    //    crons use (`^tenant_[a-f0-9]{16}$`) — see
    //    backend-common/src/database/tenant-schema.utils.ts listTenantSchemas.
    const rows: Array<{ schema_name: string }> = await queryRunner.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );

    for (const row of rows) {
      const schema = row.schema_name;
      assertSafeSchemaName(schema);
      await this.addColumnIfMissing(queryRunner, schema);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');
    await this.dropColumnIfExists(queryRunner, 'messaging');

    const rows: Array<{ schema_name: string }> = await queryRunner.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );

    for (const row of rows) {
      const schema = row.schema_name;
      assertSafeSchemaName(schema);
      await this.dropColumnIfExists(queryRunner, schema);
    }
  }

  /**
   * Add the nullable vector column + HNSW cosine index to one schema.
   * The `vector` extension is created database-wide by db-migrate
   * 001-extensions.sql — this migration must NOT CREATE EXTENSION (the
   * per-service runner role is least-privilege).
   */
  private async addColumnIfMissing(queryRunner: QueryRunner, schema: string): Promise<void> {
    // Column check guards the CREATE INDEX: building the HNSW index before
    // the column exists would fail; ADD COLUMN IF NOT EXISTS alone would not
    // tell us which branch to take.
    const columnRows: Array<{ present: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'messages'
           AND column_name = 'embedding'
       ) AS present`,
      [schema],
    );
    if (columnRows[0]?.present === true) {
      // Column already there (e.g. re-run, or a newer provision-time clone) —
      // still (re)assert the index exists, then bail.
      await this.createIndexIfMissing(queryRunner, schema);
      return;
    }

    await queryRunner.query(
      `ALTER TABLE "${schema}"."messages"
       ADD COLUMN IF NOT EXISTS "embedding" vector(384)`,
    );
    await this.createIndexIfMissing(queryRunner, schema);
  }

  private async createIndexIfMissing(queryRunner: QueryRunner, schema: string): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_embedding"
       ON "${schema}"."messages" USING hnsw ("embedding" vector_cosine_ops)
       WITH (m = 16, ef_construction = 200)`,
    );
  }

  private async dropColumnIfExists(queryRunner: QueryRunner, schema: string): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "${schema}"."idx_messages_embedding"`);
    await queryRunner.query(`ALTER TABLE "${schema}"."messages" DROP COLUMN IF EXISTS "embedding"`);
  }
}
