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
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only: validated tenant-isolation constraints must remain valid.
  }
}
