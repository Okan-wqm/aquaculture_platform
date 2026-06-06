import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotificationCommandReceipts1800100000000 implements MigrationInterface {
  name = 'CreateNotificationCommandReceipts1800100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification"."command_receipts" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "channel" varchar(32) NOT NULL,
        "requestReference" varchar(255) NOT NULL,
        "deliveryId" varchar(255) NOT NULL,
        "source" varchar(255) NOT NULL,
        "payloadHash" char(64) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'STARTED',
        "externalId" varchar(255) NULL,
        "error" text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "completedAt" timestamptz NULL,
        CONSTRAINT "chk_notification_command_receipts_status"
          CHECK ("status" IN ('STARTED', 'SUCCEEDED', 'FAILED'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uk_notification_command_receipts_tenant_channel_reference"
        ON "notification"."command_receipts" ("tenantId", "channel", "requestReference")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_notification_command_receipts_delivery"
        ON "notification"."command_receipts" ("tenantId", "deliveryId")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "notification"."idx_notification_command_receipts_delivery"');
    await queryRunner.query('DROP INDEX IF EXISTS "notification"."uk_notification_command_receipts_tenant_channel_reference"');
    await queryRunner.query('DROP TABLE IF EXISTS "notification"."command_receipts"');
  }
}
