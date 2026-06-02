import { MigrationInterface, QueryRunner } from 'typeorm';

import { createMonthlyPartition } from '../partition/partition-queries';

type Row = Record<string, unknown>;

const MESSAGE_FKS = [
  ['message_attachments', 'FK_feba9c7cced72676c716bc3e7bd'],
  ['message_receipts', 'FK_113e9f1bde01433819f03b64dec'],
  ['message_reactions', 'FK_22658274347308477aff2ac94b5'],
  ['pinned_messages', 'FK_1eeca1ccc15159c0444e46c63bb'],
  ['message_entity_references', 'FK_bb838c8f5f3a05818a99b3df865'],
  ['message_analysis', 'FK_300a3fda524de884763af2697dd'],
  ['knowledge_entries', 'FK_c5a793a94bb4d551916c3912ffd'],
  ['message_idempotency_keys', 'FK_message_idempotency_keys_message'],
] as const;

export class PartitionMessagingParents1800600000000 implements MigrationInterface {
  name = 'PartitionMessagingParents1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertNoDuplicateMessageIdempotencyKeys(queryRunner);
    await this.dropMessageForeignKeys(queryRunner);
    await this.ensureMessagesPartitioned(queryRunner);
    await this.ensureReceiptsPartitioned(queryRunner);
    await this.ensureMessageIdempotencyLedger(queryRunner);
    await this.addMessageForeignKeys(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "message_idempotency_keys"
       DROP CONSTRAINT IF EXISTS "FK_message_idempotency_keys_message"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "message_idempotency_keys"`);
  }

  private async ensureMessagesPartitioned(queryRunner: QueryRunner): Promise<void> {
    const backupTable = 'messages_unpartitioned_1800600000000';
    const backupExists = await this.relationExists(queryRunner, backupTable);

    if (await this.isPartitioned(queryRunner, 'messages')) {
      await this.assertPartitionedBy(queryRunner, 'messages', 'createdAt');
      if (backupExists) {
        await this.ensurePartitionsForExistingData(
          queryRunner,
          backupTable,
          'messages',
          'createdAt',
        );
        await this.copyMessagesFromBackup(queryRunner, backupTable);
        await this.assertRowCountPreserved(queryRunner, backupTable, 'messages');
        await queryRunner.query(`
          -- DESTRUCTIVE: migration backup is dropped only after row-count-preserved copy into messages; rollback before this statement uses the retained backup table.
          DROP TABLE IF EXISTS "messages_unpartitioned_1800600000000"
        `);
      }
      await this.ensureMessageIndexes(queryRunner);
      return;
    }

    if (!backupExists) {
      await this.assertRelationExists(queryRunner, 'messages');
      await this.assertBackupAbsent(queryRunner, backupTable);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_idempotency"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_tenant"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_sender"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_channel_created"`);
      await queryRunner.query(
        `ALTER TABLE "messages" RENAME TO "messages_unpartitioned_1800600000000"`,
      );
      await queryRunner.query(
        `ALTER TABLE "messages_unpartitioned_1800600000000" DROP CONSTRAINT IF EXISTS "PK_18325f38ae6de43878487eff986"`,
      );
      await queryRunner.query(
        `ALTER TABLE "messages_unpartitioned_1800600000000" DROP CONSTRAINT IF EXISTS "CHK_860d0b704cc2f0938b989e0131"`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "channelId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "content" text,
        "contentType" character varying(20) NOT NULL DEFAULT 'text',
        "parentId" uuid,
        "forwardedFrom" uuid,
        "idempotencyKey" uuid NOT NULL,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "editedAt" TIMESTAMP WITH TIME ZONE,
        "updatedBy" uuid,
        "isAiGenerated" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        CONSTRAINT "CHK_860d0b704cc2f0938b989e0131" CHECK ("contentType" IN ('text', 'image', 'file', 'voice', 'system')),
        CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id", "createdAt")
      ) PARTITION BY RANGE ("createdAt")
    `);
    await this.ensurePartitionsForExistingData(queryRunner, backupTable, 'messages', 'createdAt');
    await this.assertPartitionedBy(queryRunner, 'messages', 'createdAt');
    await this.copyMessagesFromBackup(queryRunner, backupTable);
    await this.assertRowCountPreserved(queryRunner, backupTable, 'messages');
    await this.ensureMessageIndexes(queryRunner);
    await queryRunner.query(`
      -- DESTRUCTIVE: migration backup is dropped only after row-count-preserved copy into messages; rollback before this statement uses the retained backup table.
      DROP TABLE IF EXISTS "messages_unpartitioned_1800600000000"
    `);
  }

  private async ensureReceiptsPartitioned(queryRunner: QueryRunner): Promise<void> {
    const backupTable = 'message_receipts_unpartitioned_1800600000000';
    const backupExists = await this.relationExists(queryRunner, backupTable);

    if (await this.isPartitioned(queryRunner, 'message_receipts')) {
      await this.assertPartitionedBy(queryRunner, 'message_receipts', 'receiptCreatedAt');
      if (backupExists) {
        await this.ensurePartitionsForExistingData(
          queryRunner,
          backupTable,
          'message_receipts',
          'receiptCreatedAt',
        );
        await this.copyReceiptsFromBackup(queryRunner, backupTable);
        await this.assertRowCountPreserved(queryRunner, backupTable, 'message_receipts');
        await queryRunner.query(`
          -- DESTRUCTIVE: migration backup is dropped only after row-count-preserved copy into message_receipts; rollback before this statement uses the retained backup table.
          DROP TABLE IF EXISTS "message_receipts_unpartitioned_1800600000000"
        `);
      }
      await this.ensureReceiptIndexes(queryRunner);
      return;
    }

    if (!backupExists) {
      await this.assertRelationExists(queryRunner, 'message_receipts');
      await this.assertBackupAbsent(queryRunner, backupTable);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_receipts_tenant"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_receipts_message"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_receipts_user_status"`);
      await queryRunner.query(
        `ALTER TABLE "message_receipts" RENAME TO "message_receipts_unpartitioned_1800600000000"`,
      );
      await queryRunner.query(
        `ALTER TABLE "message_receipts_unpartitioned_1800600000000" DROP CONSTRAINT IF EXISTS "PK_38feda673852bdf8d2b9b2f2edc"`,
      );
      await queryRunner.query(
        `ALTER TABLE "message_receipts_unpartitioned_1800600000000" DROP CONSTRAINT IF EXISTS "CHK_2fed702fdd8a7d1c5e6a5925ec"`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "message_receipts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "messageId" uuid NOT NULL,
        "messageCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "userId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'delivered',
        "deliveredAt" TIMESTAMP WITH TIME ZONE,
        "readAt" TIMESTAMP WITH TIME ZONE,
        "receiptCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT "CHK_2fed702fdd8a7d1c5e6a5925ec" CHECK ("status" IN ('delivered', 'read')),
        CONSTRAINT "PK_38feda673852bdf8d2b9b2f2edc" PRIMARY KEY ("id", "receiptCreatedAt")
      ) PARTITION BY RANGE ("receiptCreatedAt")
    `);
    await this.ensurePartitionsForExistingData(
      queryRunner,
      backupTable,
      'message_receipts',
      'receiptCreatedAt',
    );
    await this.assertPartitionedBy(queryRunner, 'message_receipts', 'receiptCreatedAt');
    await this.copyReceiptsFromBackup(queryRunner, backupTable);
    await this.assertRowCountPreserved(queryRunner, backupTable, 'message_receipts');
    await this.ensureReceiptIndexes(queryRunner);
    await queryRunner.query(`
      -- DESTRUCTIVE: migration backup is dropped only after row-count-preserved copy into message_receipts; rollback before this statement uses the retained backup table.
      DROP TABLE IF EXISTS "message_receipts_unpartitioned_1800600000000"
    `);
  }

  private async ensureMessageIdempotencyLedger(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "message_idempotency_keys" (
        "tenantId" uuid NOT NULL,
        "idempotencyKey" uuid NOT NULL,
        "messageId" uuid,
        "messageCreatedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_idempotency_keys" PRIMARY KEY ("tenantId", "idempotencyKey")
      )
    `);
    await this.assertNoDuplicateMessageIdempotencyKeys(queryRunner);
    await queryRunner.query(`
      INSERT INTO "message_idempotency_keys" (
        "tenantId", "idempotencyKey", "messageId", "messageCreatedAt", "createdAt", "updatedAt"
      )
      SELECT "tenantId", "idempotencyKey", "id", "createdAt", "createdAt", now()
      FROM "messages"
      ON CONFLICT ("tenantId", "idempotencyKey") DO UPDATE
      SET "messageId" = EXCLUDED."messageId",
          "messageCreatedAt" = EXCLUDED."messageCreatedAt",
          "updatedAt" = now()
    `);
    await queryRunner.query(`
      ALTER TABLE "message_idempotency_keys"
      DROP CONSTRAINT IF EXISTS "FK_message_idempotency_keys_message"
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "message_idempotency_keys"
        ADD CONSTRAINT "FK_message_idempotency_keys_message"
        FOREIGN KEY ("messageId", "messageCreatedAt")
        REFERENCES "messages"("id","createdAt")
        ON DELETE SET NULL ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async dropMessageForeignKeys(queryRunner: QueryRunner): Promise<void> {
    for (const [table, constraint] of MESSAGE_FKS) {
      await queryRunner.query(
        `ALTER TABLE IF EXISTS "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`,
      );
    }
  }

  private async addMessageForeignKeys(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "message_attachments" ADD CONSTRAINT "FK_feba9c7cced72676c716bc3e7bd" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "message_receipts" ADD CONSTRAINT "FK_113e9f1bde01433819f03b64dec" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "message_reactions" ADD CONSTRAINT "FK_22658274347308477aff2ac94b5" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "pinned_messages" ADD CONSTRAINT "FK_1eeca1ccc15159c0444e46c63bb" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "message_entity_references" ADD CONSTRAINT "FK_bb838c8f5f3a05818a99b3df865" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "message_analysis" ADD CONSTRAINT "FK_300a3fda524de884763af2697dd" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "knowledge_entries" ADD CONSTRAINT "FK_c5a793a94bb4d551916c3912ffd" FOREIGN KEY ("sourceMessageId", "sourceMessageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async ensureMessageIndexes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_idempotency" ON "messages" ("tenantId", "idempotencyKey", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_tenant" ON "messages" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_sender" ON "messages" ("senderId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_messages_channel_created" ON "messages" ("channelId", "createdAt")`,
    );
  }

  private async ensureReceiptIndexes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_receipts_tenant" ON "message_receipts" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_receipts_message" ON "message_receipts" ("messageId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_receipts_user_status" ON "message_receipts" ("userId", "status")`,
    );
  }

  private async copyMessagesFromBackup(
    queryRunner: QueryRunner,
    backupTable: string,
  ): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "messages" (
        "id", "tenantId", "channelId", "senderId", "content", "contentType",
        "parentId", "forwardedFrom", "idempotencyKey", "isDeleted", "createdAt",
        "editedAt", "updatedBy", "isAiGenerated", "metadata"
      )
      SELECT
        "id", "tenantId", "channelId", "senderId", "content", "contentType",
        "parentId", "forwardedFrom", "idempotencyKey", "isDeleted", "createdAt",
        "editedAt", "updatedBy", "isAiGenerated", "metadata"
      FROM "${backupTable}"
      ON CONFLICT ("id", "createdAt") DO NOTHING
    `);
  }

  private async copyReceiptsFromBackup(
    queryRunner: QueryRunner,
    backupTable: string,
  ): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "message_receipts" (
        "id", "tenantId", "messageId", "messageCreatedAt", "userId", "status",
        "deliveredAt", "readAt", "receiptCreatedAt"
      )
      SELECT
        "id", "tenantId", "messageId", "messageCreatedAt", "userId", "status",
        "deliveredAt", "readAt", "receiptCreatedAt"
      FROM "${backupTable}"
      ON CONFLICT ("id", "receiptCreatedAt") DO NOTHING
    `);
  }

  private async ensurePartitionsForExistingData(
    queryRunner: QueryRunner,
    oldTable: string,
    newTable: 'messages' | 'message_receipts',
    timestampColumn: 'createdAt' | 'receiptCreatedAt',
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT MIN("${timestampColumn}") AS min_ts, MAX("${timestampColumn}") AS max_ts FROM "${oldTable}"`,
    )) as Array<{ min_ts: Date | string | null; max_ts: Date | string | null }>;
    const months = this.monthsCovering(rows[0]?.min_ts, rows[0]?.max_ts);
    const schema = await this.currentSchema(queryRunner);
    for (const { year, month } of months) {
      await queryRunner.query(createMonthlyPartition(schema, newTable, year, month));
    }
  }

  private monthsCovering(
    minTs: Date | string | null | undefined,
    maxTs: Date | string | null | undefined,
  ): Array<{ year: number; month: number }> {
    const currentAndNext = this.monthRange(new Date(), 0, 2);
    if (!minTs || !maxTs) {
      return currentAndNext;
    }

    const min = new Date(minTs);
    const max = new Date(maxTs);
    const months = new Map<string, { year: number; month: number }>();
    for (
      let cursor = new Date(min.getUTCFullYear(), min.getUTCMonth(), 1);
      cursor <= new Date(max.getUTCFullYear(), max.getUTCMonth(), 1);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    ) {
      const entry = { year: cursor.getFullYear(), month: cursor.getMonth() + 1 };
      months.set(`${entry.year}-${entry.month}`, entry);
    }
    for (const entry of currentAndNext) {
      months.set(`${entry.year}-${entry.month}`, entry);
    }
    return [...months.values()];
  }

  private monthRange(
    base: Date,
    offsetMonths: number,
    count: number,
  ): Array<{ year: number; month: number }> {
    const result: Array<{ year: number; month: number }> = [];
    for (let i = 0; i <= count; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + offsetMonths + i, 1);
      result.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }
    return result;
  }

  private async currentSchema(queryRunner: QueryRunner): Promise<string> {
    const rows = (await queryRunner.query(`SELECT current_schema() AS schema`)) as Array<{
      schema: string;
    }>;
    const schema = rows[0]?.schema;
    if (!schema) {
      throw new Error('Cannot determine current schema for partition migration');
    }
    return schema;
  }

  private async isPartitioned(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_class c
         WHERE c.oid = to_regclass($1)
           AND c.relkind = 'p'
       ) AS exists`,
      [table],
    )) as Row[];
    return rows[0]?.['exists'] === true;
  }

  private async relationExists(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows = (await queryRunner.query(`SELECT to_regclass($1) AS regclass`, [table])) as Array<{
      regclass: string | null;
    }>;
    return Boolean(rows[0]?.regclass);
  }

  private async assertRelationExists(queryRunner: QueryRunner, table: string): Promise<void> {
    if (!(await this.relationExists(queryRunner, table))) {
      throw new Error(`Cannot continue partition migration: source table ${table} is missing`);
    }
  }

  private async assertPartitionedBy(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT pg_get_partkeydef($1::regclass) AS partition_key`,
      [table],
    )) as Array<{ partition_key: string | null }>;
    const expectedPartitionKey = `RANGE ("${column}")`;
    const partitionKey = rows[0]?.partition_key?.replace(/\s+/g, ' ').trim();
    if (partitionKey !== expectedPartitionKey) {
      throw new Error(
        `Cannot continue partition migration: ${table} uses ${rows[0]?.partition_key ?? 'no partition key'}, expected ${expectedPartitionKey}`,
      );
    }
  }

  private async assertRowCountPreserved(
    queryRunner: QueryRunner,
    oldTable: string,
    newTable: string,
  ): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT
         (SELECT COUNT(*)::text FROM "${oldTable}") AS old_count,
         (SELECT COUNT(*)::text FROM "${newTable}") AS new_count`,
    )) as Array<{ old_count: string; new_count: string }>;
    const counts = rows[0];
    if (!counts || counts.old_count !== counts.new_count) {
      throw new Error(
        `Cannot continue partition migration: copied ${counts?.new_count ?? 'unknown'} of ${counts?.old_count ?? 'unknown'} rows from ${oldTable} to ${newTable}`,
      );
    }
  }

  private async assertNoDuplicateMessageIdempotencyKeys(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT "tenantId", "idempotencyKey", COUNT(*)::text AS count
      FROM "messages"
      GROUP BY "tenantId", "idempotencyKey"
      HAVING COUNT(*) > 1
      LIMIT 1
    `)) as Array<{ tenantId: string; idempotencyKey: string; count: string }>;
    const duplicate = rows[0];
    if (duplicate) {
      throw new Error(
        `Cannot backfill message idempotency ledger: duplicate key ${duplicate.tenantId}/${duplicate.idempotencyKey} appears ${duplicate.count} times`,
      );
    }
  }

  private async assertBackupAbsent(queryRunner: QueryRunner, table: string): Promise<void> {
    const rows = (await queryRunner.query(`SELECT to_regclass($1) AS regclass`, [table])) as Array<{
      regclass: string | null;
    }>;
    if (rows[0]?.regclass) {
      throw new Error(`Cannot continue partition migration: backup table ${table} already exists`);
    }
  }
}
