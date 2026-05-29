import { MigrationInterface, QueryRunner } from 'typeorm';

const CONSTRAINTS = [
  ['channels', 'fk_channels_created_by_tenant_principals'],
  ['channel_members', 'fk_channel_members_channel_tenant'],
  ['channel_members', 'fk_channel_members_user_tenant_principals'],
  ['messages', 'fk_messages_channel_tenant'],
  ['messages', 'fk_messages_sender_tenant_principals'],
  ['message_attachments', 'fk_message_attachments_message_tenant'],
  ['message_receipts', 'fk_message_receipts_message_tenant'],
  ['message_receipts', 'fk_message_receipts_user_tenant_principals'],
  ['message_reactions', 'fk_message_reactions_message_tenant'],
  ['message_reactions', 'fk_message_reactions_user_tenant_principals'],
  ['pinned_messages', 'fk_pinned_messages_channel_tenant'],
  ['pinned_messages', 'fk_pinned_messages_message_tenant'],
  ['pinned_messages', 'fk_pinned_messages_user_tenant_principals'],
  ['message_send_idempotency', 'fk_message_send_idempotency_message'],
  ['message_read_receipt_keys', 'fk_message_read_receipt_keys_message'],
  ['message_read_receipt_keys', 'fk_message_read_receipt_keys_user_tenant_principals'],
  ['message_analysis', 'fk_message_analysis_message_tenant'],
  ['message_entity_references', 'fk_message_entity_references_message_tenant'],
  ['knowledge_entries', 'fk_knowledge_entries_message_tenant'],
] as const;

export class ValidateMessagingTenantIsolationConstraints1800410000000
  implements MigrationInterface
{
  name = 'ValidateMessagingTenantIsolationConstraints1800410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [tableName, constraintName] of CONSTRAINTS) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF to_regclass('"${tableName}"') IS NOT NULL AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = '${constraintName}'
              AND conrelid = to_regclass('"${tableName}"')
              AND convalidated = false
          ) THEN
            ALTER TABLE "${tableName}" VALIDATE CONSTRAINT "${constraintName}";
          END IF;
        END $$;
      `);
    }

    await this.assertExpectedConstraintsValid(queryRunner);
    await this.assertAllMessagingForeignKeysAreTenantAware(queryRunner);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only: validated tenant-isolation constraints must remain valid.
  }

  private async assertExpectedConstraintsValid(queryRunner: QueryRunner): Promise<void> {
    const values = CONSTRAINTS.map(
      ([tableName, constraintName]) => `('${tableName}', '${constraintName}')`,
    ).join(',\n');

    const rows: Array<{
      table_name: string;
      constraint_name: string;
      state: string;
    }> = await queryRunner.query(`
      WITH expected(table_name, constraint_name) AS (
        VALUES
          ${values}
      )
      SELECT e.table_name,
             e.constraint_name,
             CASE
               WHEN con.oid IS NULL THEN 'missing'
               WHEN con.convalidated = false THEN 'not_validated'
               ELSE 'valid'
             END AS state
      FROM expected e
      LEFT JOIN pg_class rel
        ON rel.relname = e.table_name
       AND rel.relnamespace = current_schema()::regnamespace
      LEFT JOIN pg_constraint con
        ON con.conrelid = rel.oid
       AND con.conname = e.constraint_name
      WHERE con.oid IS NULL OR con.convalidated = false
    `);

    if (rows.length > 0) {
      throw new Error(
        `Messaging tenant isolation constraints are not valid: ${rows
          .map((row) => `${row.table_name}.${row.constraint_name}:${row.state}`)
          .join(', ')}`,
      );
    }
  }

  private async assertAllMessagingForeignKeysAreTenantAware(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const rows: Array<{
      table_name: string;
      constraint_name: string;
      child_columns: string[];
      parent_table: string;
    }> = await queryRunner.query(`
      SELECT rel.relname AS table_name,
             con.conname AS constraint_name,
             array_agg(att.attname ORDER BY ord.ordinality) AS child_columns,
             parent_rel.relname AS parent_table
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      JOIN pg_class parent_rel ON parent_rel.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent_rel.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ord.attnum
      WHERE con.contype = 'f'
        AND ns.nspname = current_schema()
        AND parent_ns.nspname = current_schema()
        AND rel.relname IN (
          'channel_members',
          'messages',
          'message_attachments',
          'message_receipts',
          'message_reactions',
          'pinned_messages',
          'message_analysis',
          'message_entity_references',
          'knowledge_entries',
          'message_send_idempotency',
          'message_read_receipt_keys'
        )
        AND parent_rel.relname IN ('channels', 'messages', 'tenant_principals')
      GROUP BY rel.relname, con.conname, parent_rel.relname
      HAVING NOT bool_or(att.attname = 'tenantId')
      ORDER BY rel.relname, con.conname
    `);

    if (rows.length > 0) {
      throw new Error(
        `Messaging foreign keys must include tenantId; non-tenant-aware constraints remain: ${rows
          .map(
            (row) =>
              `${row.table_name}.${row.constraint_name}->${row.parent_table}(${row.child_columns.join(',')})`,
          )
          .join(', ')}`,
      );
    }
  }
}
