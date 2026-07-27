import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { buildEventDlqDownSql, buildEventDlqUpSql } from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateNotificationEventDlqAndSummaryReceipt (W7 — FARM-MEDIUM-260 + FARM-LOW-282)
 *
 * İki ayrı teslim boşluğunu AYNI yerde kapatır, çünkü ikisi de "aynı event
 * ikinci kez teslim edilirse ne olur" sorusunun cevabıdır:
 *
 * 1. `notification.event_dlq` (FARM-MEDIUM-260) — `FeedingDailySummary`
 *    tek-atımlıktır: farm tarafındaki `feeding_job_runs` claim'i tenant'ın
 *    yerel gününde ikinci bir özet üretilmesini engeller, dolayısıyla teslim
 *    kaybı özetin KENDİSİNİ kaybeder. Handler artık hatayı yeniden fırlatıyor;
 *    `max_deliver` tükenince mesajın gideceği kalıcı raf burasıdır.
 *
 * 2. `notification_logs."delivery_id"` + kısmi UNIQUE index (FARM-LOW-282) —
 *    push tarafı zaten `command_receipts` üzerinden deterministik
 *    `deliveryId` ile makbuzluydu; in-app satırı DEĞİLDİ. Push denemesi
 *    hata verip in-app satırı yazıldıktan sonra gelen bir yeniden teslimde
 *    push taze makbuzla başarılı olur (`replayed=false`) ve in-app satırı
 *    İKİNCİ kez yazılırdı. Kolon + `WHERE channel='in_app' AND delivery_id IS
 *    NOT NULL` kısmi unique index'i kopyayı VERİTABANI düzeyinde imkânsız
 *    kılar (tier-1) — yazıcı `ON CONFLICT DO NOTHING` ile idempotent olur.
 *    Kolon nullable: makbuz kimliği olmayan eski/serbest in-app satırları
 *    (uyarı bildirimleri) index'in dışında kalır.
 */
@SourceOnlyMigration({
  reason:
    'notification-service is platform-level (not tenant-cloned); event_dlq is cross-tenant delivery infrastructure and notification_logs lives in the notification source schema',
})
export class CreateNotificationEventDlqAndSummaryReceipt1801100000000
  implements MigrationInterface
{
  name = 'CreateNotificationEventDlqAndSummaryReceipt1801100000000';

  private static readonly DLQ_OPTIONS = {
    schema: 'notification',
    failedAtIndexName: 'idx_notification_event_dlq_failed_at',
    tenantIndexName: 'idx_notification_event_dlq_tenant',
  } as const;

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildEventDlqUpSql(
      CreateNotificationEventDlqAndSummaryReceipt1801100000000.DLQ_OPTIONS,
    )) {
      await queryRunner.query(sql);
    }

    await queryRunner.query(
      `ALTER TABLE "notification"."notification_logs"
         ADD COLUMN IF NOT EXISTS "delivery_id" VARCHAR(255) NULL`,
    );
    // Kopya satırlar bu index'ten ÖNCE temizlenir: aynı (tenant, alıcı,
    // deliveryId) için en eski satır korunur — okunma durumu ondadır.
    await queryRunner.query(
      `DELETE FROM "notification"."notification_logs" a
        USING "notification"."notification_logs" b
        WHERE a."channel" = 'in_app'
          AND b."channel" = 'in_app'
          AND a."delivery_id" IS NOT NULL
          AND a."delivery_id" = b."delivery_id"
          AND a."tenant_id" = b."tenant_id"
          AND a."recipient" = b."recipient"
          AND a."created_at" > b."created_at"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_logs_in_app_delivery"
         ON "notification"."notification_logs" ("tenant_id", "recipient", "delivery_id")
         WHERE "channel" = 'in_app' AND "delivery_id" IS NOT NULL`,
    );
  }

  /** Raf + kopya-imkânsızlığı index'i ikisi de yerinde. */
  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT to_regclass('notification.event_dlq') IS NOT NULL
              AND to_regclass('notification.uq_notification_logs_in_app_delivery') IS NOT NULL
              AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "notification"."uq_notification_logs_in_app_delivery"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification"."notification_logs" DROP COLUMN IF EXISTS "delivery_id"`,
    );
    for (const sql of buildEventDlqDownSql(
      CreateNotificationEventDlqAndSummaryReceipt1801100000000.DLQ_OPTIONS,
    )) {
      await queryRunner.query(sql);
    }
  }
}
