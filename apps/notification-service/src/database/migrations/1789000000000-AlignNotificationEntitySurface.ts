import { MigrationInterface, QueryRunner } from 'typeorm';
import { pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * AlignNotificationEntitySurface1789000000000
 * ============================================================================
 *
 * Creates the two `notification` schema tables that the 2026-05-08
 * bootstrap-from-scratch test reported as completely missing:
 *
 *   - notification.device_tokens      (DeviceToken entity)
 *   - notification.notification_logs  (NotificationLog entity)
 *
 * Both are declared with explicit `{ schema: 'notification' }`
 * decorators. The companion migration `1786000200000-MovePublic
 * TablesToNotification` relocates pre-existing `public.<name>` tables
 * INTO `notification.*` if they exist — but on a fresh-volume bootstrap
 * there is no public-schema source. This baseline creates the canonical
 * shape directly so the move-migration becomes a clean no-op.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignNotificationEntitySurface1789000000000
  implements MigrationInterface
{
  name = 'AlignNotificationEntitySurface1789000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'notification');
    await qr.query(`CREATE SCHEMA IF NOT EXISTS notification`);

    // 1. notification_logs_channel_enum — DO/EXCEPTION wrap (R8 idempotency).
    await qr.query(`
      DO $$
      BEGIN
        CREATE TYPE notification.notification_logs_channel_enum AS ENUM (
          'email', 'sms', 'push', 'webhook', 'in_app', 'system'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // 2. notification_logs_status_enum.
    await qr.query(`
      DO $$
      BEGIN
        CREATE TYPE notification.notification_logs_status_enum AS ENUM (
          'pending', 'sent', 'failed', 'retrying', 'bounced', 'dead_letter'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // 3. notification.device_tokens.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS notification.device_tokens (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        "user_id"       uuid NOT NULL,
        "tenant_id"     uuid NOT NULL,
        "token"         varchar NOT NULL,
        "platform"      varchar NOT NULL,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "last_seen_at"  timestamptz,
        CONSTRAINT "UQ_device_tokens_user_id_token" UNIQUE ("user_id", "token")
      );
    `);

    // 4. notification.notification_logs.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS notification.notification_logs (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        "tenant_id"     uuid NOT NULL,
        "channel"       notification.notification_logs_channel_enum NOT NULL,
        "recipient"     varchar NOT NULL,
        "subject"       varchar NOT NULL,
        "content"       text NOT NULL,
        "status"        notification.notification_logs_status_enum NOT NULL DEFAULT 'pending',
        "external_id"   varchar,
        "metadata"      jsonb,
        "error_message" text,
        "retry_count"   int NOT NULL DEFAULT 0,
        "next_retry_at" timestamptz,
        "sent_at"       timestamptz,
        "delivered_at"  timestamptz,
        "created_at"    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "IDX_notification_logs_tenant_sentAt"
        ON notification.notification_logs ("tenant_id", "sent_at");
      CREATE INDEX IF NOT EXISTS "IDX_notification_logs_channel_status"
        ON notification.notification_logs ("channel", "status");
      CREATE INDEX IF NOT EXISTS "IDX_notification_tenant_recipient_channel"
        ON notification.notification_logs ("tenant_id", "recipient", "channel");
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'notification');
    await qr.query(`DROP TABLE IF EXISTS notification.notification_logs`);
    await qr.query(`DROP TABLE IF EXISTS notification.device_tokens`);
    await qr.query(`DROP TYPE IF EXISTS notification.notification_logs_status_enum`);
    await qr.query(`DROP TYPE IF EXISTS notification.notification_logs_channel_enum`);
  }
}
