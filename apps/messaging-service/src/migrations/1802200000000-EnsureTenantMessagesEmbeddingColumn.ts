import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MSG-HIGH-077 — `messages.embedding` never reached a single tenant schema.
 *
 * `1800700000000-AddMessagesEmbeddingColumn` adds the column to `messages`, a
 * PER-TENANT table (`MODULE_SCHEMAS.messaging.tables`, not
 * `infrastructureTables`). It is NOT `@SourceOnlyMigration`, yet both `up()`
 * and `down()` open with `pinSearchPath(queryRunner, 'messaging')`.
 * `pinSearchPath` (`libs/backend-common/src/database/base-migration.ts`) issues
 * `SET search_path TO "<its literal argument>", public`. It has no tenant
 * awareness.
 *
 * So on a tenant pass: the orchestrator pins `tenant_<uuid>`, the migration
 * re-pins `messaging`, `ADD COLUMN IF NOT EXISTS` no-ops against the source
 * column that is already there, and — because the migration is not source-only,
 * so `recordSourceOnlySkip` is never reached — the tenant's ledger records a
 * normal successful apply. Re-pinning the source schema is functionally
 * identical to qualifying every statement in the file; the only difference is
 * that `tenant-aware-migration-ddl-guard` cannot see it (DATA-HIGH-012), which
 * is why 1800700000000's docblock could cite that guard as proof of its own
 * correctness.
 *
 * Result: no tenant's `messages` table has an `embedding` column, and none ever
 * would, because every tenant ledger says the migration ran.
 * `EmbeddingService.processUnembeddedMessages` therefore fails per tenant with
 * `column m.embedding does not exist` — the same symptom ORPHAN-MEDIUM-055
 * fixed in the source schema, still live everywhere else.
 *
 * WHY A FORWARD MIGRATION RATHER THAN AN EDIT: 1800700000000 is post-Baseline
 * and already recorded applied in every existing tenant ledger, so correcting
 * that file would never re-run anywhere. Only a new migration heals the tenants
 * that exist today and the ones provisioned tomorrow, in one pass. Shape taken
 * from `1803100000000-HealAiProposedActionsUnqualified` (ORPHAN-HIGH-408), the
 * same class of defect in ai-service.
 *
 * The DDL below is UNQUALIFIED and calls no `pinSearchPath`, so it resolves
 * against `current_schema()` — the runner's pin, whatever schema that is. It is
 * a no-op in the source schema (the column and index are already there) and
 * blue-green safe (`IF NOT EXISTS` throughout). `messages` is RANGE partitioned
 * on `createdAt`; both statements propagate from the parent to its partitions.
 *
 * The `vector` extension is database-wide (db-migrate `001-extensions.sql`), so
 * this migration must NOT `CREATE EXTENSION` — the per-service runner role is
 * least-privilege.
 */
export class EnsureTenantMessagesEmbeddingColumn1802200000000 implements MigrationInterface {
  name = 'EnsureTenantMessagesEmbeddingColumn1802200000000';

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

  /**
   * The probe runs inside this migration's own transaction, before the ledger
   * row is written. Without it, a future re-pin of the session would once again
   * record "applied" over a schema the DDL never touched — which is the actual
   * defect being healed here, not merely its symptom.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'messages'
           AND column_name = 'embedding'
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only heal. The column's create/drop lifecycle is owned by
    // 1800700000000-AddMessagesEmbeddingColumn; dropping it here would re-open
    // the per-tenant gap this migration exists to close.
  }
}
