import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';
import { tableExists } from '@aquaculture/backend-common/database';

/**
 * Migration: Add `tenantId` column to the 7 child tables that still lack it.
 *
 * # Why this exists — ADR-011 convergence (2026-04-14 plan)
 *
 * The messaging service was the only platform service without
 * Row-Level Security on its source schema. The blocker was that
 * 7 tables lacked a `tenantId` column — RLS policies depend on
 * a per-row tenant discriminator. Migration 1782000000000 added
 * tenantId to the direct-aggregate tables (channels, channel_members,
 * messages, messaging_outbox); this migration closes the remaining
 * gap on the child tables.
 *
 * After this migration:
 *   - Every tenant-scoped messaging table has a `tenantId uuid NOT NULL` column
 *   - 7 new BTree indexes on tenantId support the RLS predicate
 *   - Follow-up migration 1782400000000-EnableRowLevelSecurity installs
 *     the canonical `tenant_isolation_policy` on all messaging tables
 *
 * # Tables touched
 *
 *   1. message_attachments      — FK via (messageId, messageCreatedAt) to messages
 *   2. message_receipts         — FK via (messageId, messageCreatedAt) to messages
 *   3. message_reactions        — FK via (messageId, messageCreatedAt) to messages
 *   4. pinned_messages          — FK via channelId to channels (chosen over msg FK)
 *   5. message_analysis         — FK via (messageId, messageCreatedAt) to messages
 *   6. message_entity_references — FK via (messageId, messageCreatedAt) to messages
 *   7. knowledge_entries        — FK via (sourceMessageId, sourceMessageCreatedAt), nullable
 *
 * # Partition awareness
 *
 * `messages` and `message_receipts` are partitioned by RANGE on
 * createdAt / receiptCreatedAt. `ALTER TABLE ... ADD COLUMN` on a
 * partition parent cascades to every partition automatically, so the
 * migration does NOT enumerate partitions directly.
 *
 * # Backfill strategy
 *
 * Each child's backfill UPDATE joins on the FK back to its parent and
 * copies `parent."tenantId"` into the new column. The migration then
 * asserts no NULLs remain before enabling the NOT NULL constraint.
 *
 * For `knowledge_entries` with NULL sourceMessageId (orphan rows that
 * the FK SET NULL behavior creates when parent messages are purged):
 * these rows are DELETED with a warning log. In the ADR-011 model,
 * every tenant-scoped row MUST have a tenant discriminator; rows with
 * no derivable tenant are a data-quality defect and must not survive
 * into the RLS-enforced world.
 *
 * # Idempotency
 *
 * `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` make
 * the DDL safely re-runnable. The backfill UPDATE is a no-op once the
 * rows already have non-NULL tenantId. The orphan DELETE runs against
 * a WHERE clause that's empty after the first pass.
 *
 * # Closes findings
 *
 * - docs/reviews/messaging-expert/2026-04-14-tenant-isolation-violation-e2e.md#CRITICAL-MSG-001
 *   (ADR-011 convergence, architectural track)
 */
export class AddTenantIdToMessageChildren1782300000000 implements MigrationInterface {
  name = 'AddTenantIdToMessageChildren1782300000000';

  private readonly logger = new Logger(this.name);

  async up(queryRunner: QueryRunner): Promise<void> {
    // SECURITY / CORRECTNESS: pin search_path so unqualified table names
    // resolve against the messaging schema regardless of any stale
    // session state from prior migrations in the same boot cycle.
    // The MessagingMigrationRunnerService pins this before every migration
    // but the explicit SET here is defense-in-depth for ad-hoc CLI use.
    await queryRunner.query(`SET search_path TO "messaging", public`);

    // Wave 4-A.2 Dalga 3 bootstrap-restoration guard: every block below
    // assumes the parent table exists; the parent CREATE TABLE for
    // message_attachments / message_receipts / etc. lives in the
    // squashed-out baseline. On fresh-volume bootstrap the body crashes
    // unless we skip when the parent table is absent.
    if (!(await tableExists(queryRunner, 'messages'))) {
      this.logger.log(
        'Skipping AddTenantIdToMessageChildren — messages table not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    // ── 1. message_attachments ──
    if (await tableExists(queryRunner, 'message_attachments')) {
      await queryRunner.query(`ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "tenantId" uuid`);
      await queryRunner.query(`
        UPDATE "message_attachments" ma
        SET "tenantId" = m."tenantId"
        FROM "messages" m
        WHERE ma."messageId" = m."id"
          AND ma."messageCreatedAt" = m."createdAt"
          AND ma."tenantId" IS NULL
      `);
      await this.assertNoNulls(queryRunner, 'message_attachments');
      await queryRunner.query(`ALTER TABLE "message_attachments" ALTER COLUMN "tenantId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_attachments_tenant" ON "message_attachments" ("tenantId")`);
    }

    // ── 2. message_receipts (partitioned; ADD COLUMN cascades to partitions) ──
    if (await tableExists(queryRunner, 'message_receipts')) {
      await queryRunner.query(`ALTER TABLE "message_receipts" ADD COLUMN IF NOT EXISTS "tenantId" uuid`);
      await queryRunner.query(`
        UPDATE "message_receipts" mr
        SET "tenantId" = m."tenantId"
        FROM "messages" m
        WHERE mr."messageId" = m."id"
          AND mr."messageCreatedAt" = m."createdAt"
          AND mr."tenantId" IS NULL
      `);
      await this.assertNoNulls(queryRunner, 'message_receipts');
      await queryRunner.query(`ALTER TABLE "message_receipts" ALTER COLUMN "tenantId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_receipts_tenant" ON "message_receipts" ("tenantId")`);
    }

    // ── 3. message_reactions ──
    if (await tableExists(queryRunner, 'message_reactions')) {
      await queryRunner.query(`ALTER TABLE "message_reactions" ADD COLUMN IF NOT EXISTS "tenantId" uuid`);
      await queryRunner.query(`
        UPDATE "message_reactions" mr
        SET "tenantId" = m."tenantId"
        FROM "messages" m
        WHERE mr."messageId" = m."id"
          AND mr."messageCreatedAt" = m."createdAt"
          AND mr."tenantId" IS NULL
      `);
      await this.assertNoNulls(queryRunner, 'message_reactions');
      await queryRunner.query(`ALTER TABLE "message_reactions" ALTER COLUMN "tenantId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_reactions_tenant" ON "message_reactions" ("tenantId")`);
    }

    // ── 4. pinned_messages (FK to channels AND messages; use channels — simpler) ──
    if (
      (await tableExists(queryRunner, 'pinned_messages')) &&
      (await tableExists(queryRunner, 'channels'))
    ) {
      await queryRunner.query(`ALTER TABLE "pinned_messages" ADD COLUMN IF NOT EXISTS "tenantId" uuid`);
      await queryRunner.query(`
        UPDATE "pinned_messages" pm
        SET "tenantId" = c."tenantId"
        FROM "channels" c
        WHERE pm."channelId" = c."id"
          AND pm."tenantId" IS NULL
      `);
      await this.assertNoNulls(queryRunner, 'pinned_messages');
      await queryRunner.query(`ALTER TABLE "pinned_messages" ALTER COLUMN "tenantId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_pins_tenant" ON "pinned_messages" ("tenantId")`);
    }

    // ── 5. message_analysis ──
    if (await tableExists(queryRunner, 'message_analysis')) {
      await queryRunner.query(`ALTER TABLE "message_analysis" ADD COLUMN IF NOT EXISTS "tenantId" uuid`);
      await queryRunner.query(`
        UPDATE "message_analysis" ma
        SET "tenantId" = m."tenantId"
        FROM "messages" m
        WHERE ma."messageId" = m."id"
          AND ma."messageCreatedAt" = m."createdAt"
          AND ma."tenantId" IS NULL
      `);
      await this.assertNoNulls(queryRunner, 'message_analysis');
      await queryRunner.query(`ALTER TABLE "message_analysis" ALTER COLUMN "tenantId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_analysis_tenant" ON "message_analysis" ("tenantId")`);
    }

    // ── 6. message_entity_references ──
    if (await tableExists(queryRunner, 'message_entity_references')) {
      await queryRunner.query(`ALTER TABLE "message_entity_references" ADD COLUMN IF NOT EXISTS "tenantId" uuid`);
      await queryRunner.query(`
        UPDATE "message_entity_references" mer
        SET "tenantId" = m."tenantId"
        FROM "messages" m
        WHERE mer."messageId" = m."id"
          AND mer."messageCreatedAt" = m."createdAt"
          AND mer."tenantId" IS NULL
      `);
      await this.assertNoNulls(queryRunner, 'message_entity_references');
      await queryRunner.query(`ALTER TABLE "message_entity_references" ALTER COLUMN "tenantId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_entity_refs_tenant" ON "message_entity_references" ("tenantId")`);
    }

    // ── 7. knowledge_entries (sourceMessageId nullable → orphan handling) ──
    if (await tableExists(queryRunner, 'knowledge_entries')) {
      await queryRunner.query(`ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "tenantId" uuid`);
      // Backfill from source message when available
      await queryRunner.query(`
        UPDATE "knowledge_entries" ke
        SET "tenantId" = m."tenantId"
        FROM "messages" m
        WHERE ke."sourceMessageId" = m."id"
          AND ke."sourceMessageCreatedAt" = m."createdAt"
          AND ke."tenantId" IS NULL
      `);
      // Orphans (no sourceMessageId) — delete with warning.
      // Rationale: in the ADR-011 model every tenant-scoped row MUST have
      // a tenant discriminator. Knowledge entries with no derivable tenant
      // are a pre-existing data-quality defect (the FK ON DELETE SET NULL
      // leaves rows pointing at deleted messages). They must not survive
      // into the RLS-enforced world.
      const orphans: Array<{ count: string }> = await queryRunner.query(`
        SELECT count(*)::text AS count FROM "knowledge_entries" WHERE "tenantId" IS NULL
      `);
      const orphanCount = parseInt(orphans[0]?.count ?? '0', 10);
      if (orphanCount > 0) {
        this.logger.warn(
          `Deleting ${orphanCount} orphan knowledge_entries rows (sourceMessageId IS NULL after FK cascade). ` +
            `These rows have no derivable tenant context and cannot survive into RLS.`,
        );
        await queryRunner.query(`DELETE FROM "knowledge_entries" WHERE "tenantId" IS NULL`);
      }
      await this.assertNoNulls(queryRunner, 'knowledge_entries');
      await queryRunner.query(`ALTER TABLE "knowledge_entries" ALTER COLUMN "tenantId" SET NOT NULL`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_knowledge_tenant" ON "knowledge_entries" ("tenantId")`);
    }

    this.logger.log('Added tenantId to 7 child tables; ready for EnableRowLevelSecurity migration.');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO "messaging", public`);

    // DROP INDEXes first — CASCADE on DROP COLUMN also drops them but being
    // explicit makes the rollback intent auditable.
    const tables = [
      { t: 'message_attachments', idx: 'idx_attachments_tenant' },
      { t: 'message_receipts', idx: 'idx_receipts_tenant' },
      { t: 'message_reactions', idx: 'idx_reactions_tenant' },
      { t: 'pinned_messages', idx: 'idx_pins_tenant' },
      { t: 'message_analysis', idx: 'idx_analysis_tenant' },
      { t: 'message_entity_references', idx: 'idx_entity_refs_tenant' },
      { t: 'knowledge_entries', idx: 'idx_knowledge_tenant' },
    ];

    for (const { t, idx } of tables) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${idx}"`);
      await queryRunner.query(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS "tenantId"`);
    }
  }

  /**
   * Assert that a table has zero NULL `tenantId` rows. Throws with a
   * diagnostic message if any remain — the migration is aborted and the
   * operator must resolve the data-quality issue before retrying.
   */
  private async assertNoNulls(queryRunner: QueryRunner, table: string): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count FROM "${table}" WHERE "tenantId" IS NULL`,
    );
    const nullCount = parseInt(rows[0]?.count ?? '0', 10);
    if (nullCount > 0) {
      throw new Error(
        `[${this.name}] ${nullCount} rows in "${table}" still have NULL tenantId after backfill. ` +
          `The migration cannot proceed — these rows have no derivable tenant context. ` +
          `Resolve the data-quality issue (delete orphans or fix FK integrity) and re-run.`,
      );
    }
  }
}
