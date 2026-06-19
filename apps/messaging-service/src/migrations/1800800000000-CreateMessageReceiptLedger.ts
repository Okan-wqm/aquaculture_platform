import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DBR-CRITICAL-004
 *
 * PostgreSQL cannot enforce UNIQUE(messageId,userId) on the partitioned
 * message_receipts parent unless the partition key is part of the unique key.
 * This non-partitioned ledger is the logical receipt SSoT; message_receipts
 * remains the time-series/history table keyed by receiptCreatedAt.
 */
export class CreateMessageReceiptLedger1800800000000
  implements MigrationInterface
{
  name = 'CreateMessageReceiptLedger1800800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "message_receipt_ledger" (
        "tenantId" uuid NOT NULL,
        "messageId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "messageCreatedAt" timestamptz NOT NULL,
        "receiptId" uuid NOT NULL DEFAULT gen_random_uuid(),
        "receiptCreatedAt" timestamptz NOT NULL DEFAULT now(),
        "status" varchar(20) NOT NULL DEFAULT 'delivered',
        "deliveredAt" timestamptz,
        "readAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_message_receipt_ledger"
          PRIMARY KEY ("tenantId", "messageId", "userId"),
        CONSTRAINT "uq_message_receipt_ledger_receipt_identity"
          UNIQUE ("receiptId", "receiptCreatedAt"),
        CONSTRAINT "chk_message_receipt_ledger_status"
          CHECK ("status" IN ('delivered', 'read')),
        CONSTRAINT "fk_message_receipt_ledger_message"
          FOREIGN KEY ("messageId", "messageCreatedAt")
          REFERENCES "messages"("id", "createdAt")
          ON DELETE RESTRICT
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_message_receipt_ledger_message"
        ON "message_receipt_ledger" ("messageId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_message_receipt_ledger_user_status"
        ON "message_receipt_ledger" ("userId", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "message_receipt_ledger"`,
    );
  }
}
