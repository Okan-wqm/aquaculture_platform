import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * AddCompositeFkIndexesOnMessageChildren1781600000000
 * ============================================================================
 *
 * Replaces single-column `(messageId)` indexes on the four child tables
 * that reference `messages(id, createdAt)` with composite
 * `(messageId, messageCreatedAt)` indexes, matching the foreign-key
 * shape exactly.
 *
 * # Why
 *
 * `messages` is a partitioned table with a composite primary key
 * `(id, createdAt)`. Four child tables declare composite foreign keys
 * into it:
 *
 *   message_attachments   (messageId, messageCreatedAt) → messages(id, createdAt)
 *   message_receipts      (messageId, messageCreatedAt) → messages(id, createdAt)
 *   message_reactions     (messageId, messageCreatedAt) → messages(id, createdAt)
 *   pinned_messages       (messageId, messageCreatedAt) → messages(id, createdAt)
 *
 * The original init script created single-column `(messageId)` indexes on
 * the first three and NO index at all on `pinned_messages`. This is
 * measurably worse than a matching composite index for two reasons:
 *
 * 1. **Referential integrity checks.** PostgreSQL verifies every INSERT
 *    and UPDATE of a child row against the parent via a
 *    `SELECT 1 FROM messages WHERE id = $1 AND createdAt = $2` probe.
 *    Without a composite index on the child, the referential integrity
 *    trigger that PG installs per-row on message deletion (ON DELETE
 *    CASCADE) must do a seq scan OR use the `(messageId)` index and
 *    then re-check `messageCreatedAt` per row. A composite index
 *    covering the exact FK shape lets the planner do a single index
 *    lookup with no re-check.
 *
 * 2. **Partition pruning.** `messages` is partitioned by `createdAt`
 *    (monthly RANGE). The composite FK's `messageCreatedAt` column
 *    carries the partition key forward to the child. When cascading
 *    deletes, PG can use the composite index on the child side to
 *    target a specific partition directly, eliminating scans of
 *    unrelated partitions.
 *
 * For `pinned_messages` the situation is worse: no `(messageId)` index
 * exists at all, so cascade delete on `messages` does a full seq scan
 * of pinned_messages per affected row. This migration adds the
 * composite index directly.
 *
 * # What stays single-column
 *
 * `message_receipts.uq_receipt_message_user` UNIQUE `(messageId, userId,
 * receiptCreatedAt)` is a DIFFERENT composite — the trailing column is
 * the receipt's own createdAt, not the message's. We leave that
 * constraint untouched. It cannot serve as the FK index because the
 * leading columns include `userId`, which breaks the `(messageId,
 * messageCreatedAt)` prefix match PG needs for FK validation.
 *
 * # Concurrent index creation
 *
 * `CREATE INDEX CONCURRENTLY` would allow the migration to run without
 * blocking writes, but TypeORM migrations run inside a transaction
 * (`transaction: 'each'` in MigrationRunnerService), and `CONCURRENTLY`
 * is forbidden inside transactions. The tradeoff:
 *
 *   - Non-concurrent `CREATE INDEX`: takes AccessShareLock → AccessExclusiveLock
 *     upgrade, blocks writes for the duration (seconds on the current
 *     table sizes).
 *   - `CONCURRENTLY`: non-blocking, but requires running outside a
 *     transaction and violates TypeORM's migration runner contract.
 *
 * We choose non-concurrent because:
 *   1. Messaging tables are small enough that blocking for a few seconds
 *      per schema is acceptable.
 *   2. Tenant schemas are processed serially, so only one tenant's
 *      pin/reaction/attachment writes are blocked at a time, not all of
 *      them at once.
 *   3. Running migrations outside transactions defeats the atomicity
 *      of migration application tracking — a crash mid-migration would
 *      leave the state inconsistent with the `migrations` table.
 *
 * If messaging tables grow past the ~1M row point, this migration
 * should be re-run out-of-band with `CREATE INDEX CONCURRENTLY` by a
 * DBA as a one-off operation.
 *
 * # Schema iteration
 *
 * messaging-service is schema-per-tenant. The composite indexes must
 * exist in the `messaging` source schema template AND in every
 * `tenant_<uuid>` schema provisioned from it. Same discovery pattern
 * as `ConvertMessagingOutboxToIdentity1781200000000` (C-2).
 *
 * The migration finds every schema containing a `messages` base table
 * via `information_schema.tables` and installs the four composite
 * indexes in each.
 *
 * # Idempotency
 *
 * `DROP INDEX IF EXISTS` + `CREATE INDEX IF NOT EXISTS` so rerunning is
 * a safe no-op. Partial failures leave the migration at a re-entrant
 * state, and a second run completes the work.
 */
export class AddCompositeFkIndexesOnMessageChildren1781600000000
  implements MigrationInterface
{
  name = 'AddCompositeFkIndexesOnMessageChildren1781600000000';
  private readonly logger = new MigrationLogger(this.name);

  /**
   * Index replacement plan. For each entry:
   *   - `oldIndex`: existing single-column index to drop (null if none)
   *   - `newIndex`: composite index to create
   *   - `table`: the child table
   *   - `cols`: the composite column list, always FK-shaped
   */
  private readonly replacements: ReadonlyArray<{
    table: string;
    oldIndex: string | null;
    newIndex: string;
    cols: readonly [string, string];
  }> = [
    {
      table: 'message_attachments',
      oldIndex: 'idx_attachments_message',
      newIndex: 'idx_attachments_message_composite',
      cols: ['messageId', 'messageCreatedAt'],
    },
    {
      table: 'message_receipts',
      oldIndex: 'idx_receipts_message',
      newIndex: 'idx_receipts_message_composite',
      cols: ['messageId', 'messageCreatedAt'],
    },
    {
      table: 'message_reactions',
      oldIndex: 'idx_reactions_message',
      newIndex: 'idx_reactions_message_composite',
      cols: ['messageId', 'messageCreatedAt'],
    },
    {
      table: 'pinned_messages',
      // pinned_messages had no (messageId) index at all — nothing to
      // drop. The new composite covers both cascade-delete performance
      // AND the existing uq_pin_channel_message UNIQUE constraint does
      // not help FK validation (leading column is channelId).
      oldIndex: null,
      newIndex: 'idx_pins_message_composite',
      cols: ['messageId', 'messageCreatedAt'],
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Installing composite (messageId, messageCreatedAt) indexes on message child tables',
    );

    const schemas = await this.discoverSchemas(queryRunner);

    if (schemas.length === 0) {
      this.logger.warn(
        'No schemas with messages table found — nothing to index. ' +
          'Expected on environments before any tenant has been provisioned.',
      );
      return;
    }

    this.logger.log(
      `Found ${schemas.length} schemas with messages: ${schemas.join(', ')}`,
    );

    for (const schema of schemas) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
        this.logger.warn(`Skipping invalid schema name: "${schema}"`);
        continue;
      }

      for (const { table, oldIndex, newIndex, cols } of this.replacements) {
        // Some environments may have tenant schemas without ALL of the
        // message child tables (e.g. a tenant that was provisioned
        // before pinned_messages was added). Skip missing tables so the
        // migration is resilient across mixed-version tenants.
        const tableExists = await this.tableExistsInSchema(
          queryRunner,
          schema,
          table,
        );
        if (!tableExists) {
          this.logger.warn(
            `[${schema}] ${table} not found — skipping (mixed tenant versions?)`,
          );
          continue;
        }

        // Drop the legacy single-column index if it exists. We drop
        // FIRST because the new composite index serves the same query
        // patterns the old one did, and keeping both would waste disk
        // and slow INSERTs for no benefit.
        if (oldIndex !== null) {
          await queryRunner.query(
            `DROP INDEX IF EXISTS "${schema}"."${oldIndex}"`,
          );
          this.logger.log(
            `[${schema}] dropped legacy index ${oldIndex}`,
          );
        }

        // Create the composite index. Note the quoted "camelCase"
        // column names — messaging schema uses camelCase unlike
        // farm-service. Partial index is NOT used here because
        // messageId is NOT NULL on all four tables; a partial
        // predicate would add no selectivity.
        const [col1, col2] = cols;
        await queryRunner.query(`
          CREATE INDEX IF NOT EXISTS "${newIndex}"
          ON "${schema}"."${table}" ("${col1}", "${col2}")
        `);
        this.logger.log(
          `[${schema}] created composite index ${newIndex} on (${col1}, ${col2})`,
        );
      }
    }

    this.logger.log(
      `Composite FK indexes installed across ${schemas.length} schemas`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Rolling back composite FK indexes on message child tables — ' +
        'cascade delete performance will regress, especially on ' +
        'pinned_messages which will go back to having no FK index.',
    );

    const schemas = await this.discoverSchemas(queryRunner);

    for (const schema of schemas) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) continue;

      for (const { table, oldIndex, newIndex, cols } of this.replacements) {
        const tableExists = await this.tableExistsInSchema(
          queryRunner,
          schema,
          table,
        );
        if (!tableExists) continue;

        // Drop the new composite index.
        await queryRunner.query(
          `DROP INDEX IF EXISTS "${schema}"."${newIndex}"`,
        );

        // Restore the legacy single-column index to exactly match the
        // pre-up() state. Not needed for pinned_messages (oldIndex is
        // null — it never had an index).
        if (oldIndex !== null) {
          const [col1] = cols;
          await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "${oldIndex}"
            ON "${schema}"."${table}" ("${col1}")
          `);
          this.logger.warn(
            `[${schema}] restored legacy ${oldIndex} on (${col1})`,
          );
        }
      }
    }

    this.logger.warn('Rollback complete');
  }

  /**
   * Find every schema containing a `messages` base table — the set of
   * schemas affected by this migration is the same set messages lives
   * in, by construction.
   */
  private async discoverSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ table_schema: string }> = await queryRunner.query(`
      SELECT table_schema
      FROM information_schema.tables
      WHERE table_name = 'messages'
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema
    `);
    return rows.map((r) => r.table_schema);
  }

  /** Defensive existence check — some schemas may lack optional tables. */
  private async tableExistsInSchema(
    queryRunner: QueryRunner,
    schema: string,
    tableName: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
          AND table_type = 'BASE TABLE'
      ) AS exists
      `,
      [schema, tableName],
    );
    return rows[0]?.exists === true;
  }
}
