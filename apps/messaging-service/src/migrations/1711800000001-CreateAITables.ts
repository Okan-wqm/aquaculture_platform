import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 AI integration tables for the messaging service.
 *
 * Creates:
 *   - message_analysis    — sentiment, entity, topic analysis results
 *   - message_entity_references — links messages to domain entities (tanks, batches, etc.)
 *   - knowledge_entries   — extracted operational knowledge from message history
 *   - embeddings_metadata — tracks embedding model versions for re-embedding
 *   - embedding column on messages (VECTOR(384)) with HNSW index
 *
 * Prerequisite: pgvector extension must be available. The migration creates it
 * in the public schema (requires superuser or CREATE privilege). If it already
 * exists this is a no-op.
 *
 * See ADR-012 sections 12.1-12.3 for full design rationale.
 */
export class CreateAITables1711800000001 implements MigrationInterface {
  name = 'CreateAITables1711800000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s = current_schema;

    // ------------------------------------------------------------------
    // 0. pgvector extension (schema-independent, installed once globally)
    // ------------------------------------------------------------------
    await queryRunner.query(
      `CREATE EXTENSION IF NOT EXISTS vector;`,
    );

    // ------------------------------------------------------------------
    // 1. analysis_type enum (created per-schema to avoid cross-schema deps)
    //    Using a CHECK constraint instead of a shared enum keeps tenant
    //    schemas fully independent of the public schema.
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 2. message_analysis — AI analysis results per message
    //    Stores sentiment scores, entity extractions, and topic classifications.
    //    FK to partitioned messages via composite key.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."message_analysis" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "messageId"         UUID NOT NULL,
        "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
        "analysisType"      VARCHAR(20) NOT NULL,
        "result"            JSONB NOT NULL,
        "modelVersion"      VARCHAR(64) NOT NULL,
        "analyzedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "chk_analysis_type"
          CHECK ("analysisType" IN ('sentiment', 'entity', 'topic')),

        CONSTRAINT "fk_analysis_message"
          FOREIGN KEY ("messageId", "messageCreatedAt")
          REFERENCES "${s}"."messages" ("id", "createdAt") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_analysis_message"
        ON "${s}"."message_analysis" ("messageId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_analysis_type"
        ON "${s}"."message_analysis" ("analysisType", "analyzedAt" DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_analysis_sentiment"
        ON "${s}"."message_analysis" (("result"->>'score'))
        WHERE "analysisType" = 'sentiment';
    `);

    // ------------------------------------------------------------------
    // 3. message_entity_references — junction table linking messages
    //    to domain entities (tanks, batches, sites, species, parameters).
    //    FK to partitioned messages via composite key.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."message_entity_references" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "messageId"         UUID NOT NULL,
        "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
        "entityType"        VARCHAR(30) NOT NULL,
        "entityId"          UUID NOT NULL,
        "confidence"        NUMERIC(3, 2) NOT NULL DEFAULT 1.0,
        "extractedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "chk_entity_type"
          CHECK ("entityType" IN ('tank', 'batch', 'site', 'species', 'parameter')),
        CONSTRAINT "uq_message_entity"
          UNIQUE ("messageId", "entityType", "entityId"),

        CONSTRAINT "fk_entity_ref_message"
          FOREIGN KEY ("messageId", "messageCreatedAt")
          REFERENCES "${s}"."messages" ("id", "createdAt") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_entity_refs_entity"
        ON "${s}"."message_entity_references" ("entityType", "entityId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_entity_refs_message"
        ON "${s}"."message_entity_references" ("messageId");
    `);

    // ------------------------------------------------------------------
    // 4. knowledge_entries — extracted operational knowledge from messages
    //    Source message FK uses ON DELETE SET NULL so knowledge persists
    //    even if the original message is purged by retention policy.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."knowledge_entries" (
        "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "sourceMessageId"          UUID,
        "sourceMessageCreatedAt"   TIMESTAMPTZ,
        "category"                 VARCHAR(50) NOT NULL,
        "content"                  TEXT NOT NULL,
        "entities"                 JSONB,
        "confidence"               NUMERIC(3, 2) NOT NULL DEFAULT 1.0,
        "verifiedBy"               UUID,
        "createdAt"                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "fk_knowledge_message"
          FOREIGN KEY ("sourceMessageId", "sourceMessageCreatedAt")
          REFERENCES "${s}"."messages" ("id", "createdAt") ON DELETE SET NULL
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_knowledge_category"
        ON "${s}"."knowledge_entries" ("category", "createdAt" DESC);
    `);

    // ------------------------------------------------------------------
    // 5. embeddings_metadata — tracks embedding model versions
    //    Used to detect when re-embedding is needed after model upgrades.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."embeddings_metadata" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "modelName"       VARCHAR(128) NOT NULL,
        "modelVersion"    VARCHAR(64) NOT NULL,
        "dimension"       INTEGER NOT NULL,
        "distanceMetric"  VARCHAR(20) NOT NULL,
        "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "isActive"        BOOLEAN NOT NULL DEFAULT TRUE,

        CONSTRAINT "uq_active_model"
          UNIQUE ("modelName", "isActive")
      );
    `);

    // ------------------------------------------------------------------
    // 6. Add embedding column to messages table
    //    384 dimensions matches all-MiniLM-L6-v2 model output.
    //    Populated asynchronously by ai-service; NULL until processed.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "${s}"."messages"
        ADD COLUMN IF NOT EXISTS "embedding" vector(384);
    `);

    // ------------------------------------------------------------------
    // 7. HNSW index on embedding column for fast cosine similarity search
    //    Parameters: m=16 (connections per node), ef_construction=200
    //    (build-time accuracy). See ADR-012 section 12.1 for rationale.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_embedding"
        ON "${s}"."messages"
        USING hnsw ("embedding" vector_cosine_ops)
        WITH (m = 16, ef_construction = 200);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s = current_schema;

    // Drop HNSW index first, then the embedding column
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${s}"."idx_messages_embedding";`,
    );
    await queryRunner.query(`
      ALTER TABLE "${s}"."messages"
        DROP COLUMN IF EXISTS "embedding";
    `);

    // Drop tables in reverse dependency order
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."embeddings_metadata" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."knowledge_entries" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."message_entity_references" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."message_analysis" CASCADE;`,
    );

    // NOTE: We do NOT drop the vector extension here because other
    // schemas/services may depend on it. Extension removal is a
    // separate administrative action.
  }
}
