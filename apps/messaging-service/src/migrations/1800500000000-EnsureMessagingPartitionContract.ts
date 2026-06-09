import {
  pinSearchPath,
  SourceOnlyMigration,
} from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

type PartitionContractRow = {
  messages_partitioned: boolean;
  receipts_partitioned: boolean;
  idempotency_index_non_unique: boolean;
  idempotency_index_definition: string | null;
};

function isPartitionContractRow(value: unknown): value is PartitionContractRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PartitionContractRow).messages_partitioned === 'boolean' &&
    typeof (value as PartitionContractRow).receipts_partitioned === 'boolean' &&
    typeof (value as PartitionContractRow).idempotency_index_non_unique === 'boolean'
  );
}

@SourceOnlyMigration({
  reason:
    'messages/message_receipts partition parents are source-schema DDL; tenant schemas are provisioned from this source contract',
})
// TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: partition parent/index DDL is source-only
// and tenant ledgers record this migration as source-only skipped.
export class EnsureMessagingPartitionContract1800500000000
  implements MigrationInterface
{
  name = 'EnsureMessagingPartitionContract1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');

    await queryRunner.query(`
      DO $$
      DECLARE
        messages_reg regclass := to_regclass('messaging.messages');
        receipts_reg regclass := to_regclass('messaging.message_receipts');
        messages_partitioned boolean;
        receipts_partitioned boolean;
      BEGIN
        IF messages_reg IS NULL THEN
          RAISE EXCEPTION 'messaging.messages is missing; baseline migration must run before 180050';
        END IF;

        IF receipts_reg IS NULL THEN
          RAISE EXCEPTION 'messaging.message_receipts is missing; baseline migration must run before 180050';
        END IF;

        SELECT EXISTS (
          SELECT 1
          FROM pg_partitioned_table
          WHERE partrelid = messages_reg
        )
          INTO messages_partitioned;

        SELECT EXISTS (
          SELECT 1
          FROM pg_partitioned_table
          WHERE partrelid = receipts_reg
        )
          INTO receipts_partitioned;

        IF NOT messages_partitioned THEN
          RAISE EXCEPTION
            'messaging.messages must be RANGE partitioned before 180050; run audited repartitioning instead of booting with runtime partition drift';
        END IF;

        IF NOT receipts_partitioned THEN
          RAISE EXCEPTION
            'messaging.message_receipts must be RANGE partitioned before 180050; run audited repartitioning instead of booting with runtime partition drift';
        END IF;

        EXECUTE 'DROP INDEX IF EXISTS "messaging"."idx_messages_idempotency"';
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_idempotency"
        ON messaging.messages ("tenantId", "idempotencyKey")
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: unknown = await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_partitioned_table
          WHERE partrelid = 'messaging.messages'::regclass
        ) AS messages_partitioned,
        EXISTS (
          SELECT 1
          FROM pg_partitioned_table
          WHERE partrelid = 'messaging.message_receipts'::regclass
        ) AS receipts_partitioned,
        EXISTS (
          SELECT 1
          FROM pg_class idx
          JOIN pg_namespace n ON n.oid = idx.relnamespace
          JOIN pg_index i ON i.indexrelid = idx.oid
          WHERE n.nspname = 'messaging'
            AND idx.relname = 'idx_messages_idempotency'
            AND i.indisunique = false
        ) AS idempotency_index_non_unique,
        (
          SELECT pg_get_indexdef(idx.oid)
          FROM pg_class idx
          JOIN pg_namespace n ON n.oid = idx.relnamespace
          WHERE n.nspname = 'messaging'
            AND idx.relname = 'idx_messages_idempotency'
          LIMIT 1
        ) AS idempotency_index_definition
    `);

    const firstRow = Array.isArray(rows) ? rows[0] : undefined;
    if (!isPartitionContractRow(firstRow)) {
      return false;
    }

    return (
      firstRow.messages_partitioned &&
      firstRow.receipts_partitioned &&
      firstRow.idempotency_index_non_unique &&
      firstRow.idempotency_index_definition !== null &&
      firstRow.idempotency_index_definition.includes('"tenantId"') &&
      firstRow.idempotency_index_definition.includes('"idempotencyKey"')
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only repair: reintroducing a unique DB idempotency index would
    // conflict with partitioned-table semantics and ADR-012 command idempotency.
  }
}
