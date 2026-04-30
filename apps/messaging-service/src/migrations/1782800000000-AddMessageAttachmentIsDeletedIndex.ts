import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * Migration: Partial index on `message_attachments.is_deleted` for
 * fast non-deleted-attachment lookups (INFRA-MEDIUM-014 cure).
 *
 * # Why this exists
 *
 * `MessageAttachment.isDeleted` carries `@Index()` in the entity as a
 * declared performance optimization for "fetch live attachments for a
 * message" queries (every attachment read filters `WHERE
 * isDeleted = false`). The 1782600000000-AlignMessagingEntityDrift
 * migration added the column itself but could NOT create the index
 * inline because the migration-sql-lint R3 rule (CREATE INDEX requires
 * CONCURRENTLY for populated tables) cannot be satisfied inside a
 * transactional migration — `CREATE INDEX CONCURRENTLY` is rejected
 * by Postgres inside a transaction block.
 *
 * # Cure shape
 *
 * Sibling migration with `transaction = 'none'`. The index is
 * declared as a PARTIAL index `WHERE is_deleted = false` because:
 *
 *   1. The selective lookup IS the read pattern — every queryBuilder
 *      attaches `att.isDeleted = false`. A full index over both
 *      values would double the size for no extra read locality.
 *   2. Soft-deleted attachments are a small fraction of the table
 *      lifetime; the partial index excludes the deleted rows from the
 *      index entirely, keeping its B-tree compact.
 *
 * # Tenant fan-out (load-bearing — see ADR-011)
 *
 * The runner declares the messaging schema slot as `tenantAware: true`,
 * so this migration runs against the source schema (`messaging`) AND
 * every existing tenant schema (`tenant_<uuid>`). Each iteration pins
 * `search_path` to the right schema, so the unqualified
 * `message_attachments` resolves correctly per-iteration. Per-tenant
 * `CREATE INDEX CONCURRENTLY` blocks for that tenant only — operators
 * see one progressive lock-free index build per tenant.
 *
 * # Why this is performance-only, not a correctness invariant
 *
 * The drift validator checks columns + nullability, NOT indexes; a
 * missing perf index does not re-open the schema-drift gate. Skipping
 * this index would make `WHERE isDeleted = false` queries
 * sequentially scan the table — slow at scale but functionally
 * correct. Landing the index closes the entity↔DB declaration gap so
 * the entity's `@Index()` decorator and the actual DB shape agree.
 *
 * @see docs/reviews/data-expert/2026-04-19-e2e-messaging-arch.md#INFRA-MEDIUM-014
 */
export class AddMessageAttachmentIsDeletedIndex1782800000000
  implements MigrationInterface
{
  name = 'AddMessageAttachmentIsDeletedIndex1782800000000';

  /**
   * CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
   * Setting transaction='none' opts this migration out of the runner's
   * default transactional wrapper.
   */
  transaction: 'none' = 'none';

  private readonly logger = new Logger(
    AddMessageAttachmentIsDeletedIndex1782800000000.name,
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    this.logger.log(
      `Applying INFRA-MEDIUM-014 partial index on message_attachments.is_deleted (schema=${schema})`,
    );

    // Idempotent: IF NOT EXISTS lets the migration re-run safely if a
    // previous attempt was interrupted mid-build (CONCURRENTLY can be
    // partially-built; the IF NOT EXISTS skips re-creation but does
    // NOT validate the existing index — operators inspecting after a
    // crash should run REINDEX CONCURRENTLY against this name to
    // ensure validity).
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_attachments_is_deleted
        ON message_attachments ("is_deleted")
        WHERE "is_deleted" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    this.logger.log(
      `Reverting INFRA-MEDIUM-014 partial index on message_attachments.is_deleted (schema=${schema})`,
    );

    // DROP INDEX CONCURRENTLY is also non-transactional. IF EXISTS
    // makes it safe to re-run after a partial drop.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_message_attachments_is_deleted`,
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async currentSchema(queryRunner: QueryRunner): Promise<string> {
    const rows: Array<{ current_schema: string }> = await queryRunner.query(
      `SELECT current_schema()`,
    );
    return rows[0]?.current_schema ?? 'unknown';
  }
}
