import { MigrationInterface, QueryRunner } from "typeorm";

export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "notification"."notification_logs_channel_enum" AS ENUM('email', 'sms', 'push', 'webhook', 'in_app', 'system')`);
        await queryRunner.query(`CREATE TYPE "notification"."notification_logs_status_enum" AS ENUM('pending', 'sent', 'failed', 'retrying', 'bounced', 'dead_letter')`);
        await queryRunner.query(`CREATE TABLE "notification"."notification_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "channel" "notification"."notification_logs_channel_enum" NOT NULL, "recipient" character varying NOT NULL, "subject" character varying NOT NULL, "content" text NOT NULL, "status" "notification"."notification_logs_status_enum" NOT NULL DEFAULT 'pending', "external_id" character varying, "metadata" jsonb, "error_message" text, "retry_count" integer NOT NULL DEFAULT '0', "next_retry_at" TIMESTAMP WITH TIME ZONE, "sent_at" TIMESTAMP WITH TIME ZONE, "delivered_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_19c524e644cdeaebfcffc284871" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_notification_tenant_recipient_channel" ON "notification"."notification_logs" ("tenant_id", "recipient", "channel") `);
        await queryRunner.query(`CREATE INDEX "IDX_cf3808c90b68b06f22820d6168" ON "notification"."notification_logs" ("channel", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_7ca4ed34a4206249d7092751bc" ON "notification"."notification_logs" ("tenant_id", "sent_at") `);
        await queryRunner.query(`CREATE TABLE "notification"."device_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "tenant_id" uuid NOT NULL, "token" character varying NOT NULL, "platform" character varying NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_seen_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_a070dfec1c8f06cd29b854169f2" UNIQUE ("user_id", "token"), CONSTRAINT "PK_84700be257607cfb1f9dc2e52c3" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "notification"."device_tokens"`);
        await queryRunner.query(`DROP INDEX "notification"."IDX_7ca4ed34a4206249d7092751bc"`);
        await queryRunner.query(`DROP INDEX "notification"."IDX_cf3808c90b68b06f22820d6168"`);
        await queryRunner.query(`DROP INDEX "notification"."IDX_notification_tenant_recipient_channel"`);
        await queryRunner.query(`DROP TABLE "notification"."notification_logs"`);
        await queryRunner.query(`DROP TYPE "notification"."notification_logs_status_enum"`);
        await queryRunner.query(`DROP TYPE "notification"."notification_logs_channel_enum"`);
    }

}
