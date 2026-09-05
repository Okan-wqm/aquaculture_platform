import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateNotificationInAppDeliveryReceipt (W7 — FARM-LOW-282)
 *
 * `notification_logs."delivery_id"` + kısmi UNIQUE index: push tarafı zaten
 * `command_receipts` üzerinden deterministik `deliveryId` ile makbuzluydu;
 * in-app satırı DEĞİLDİ. Push denemesi hata verip in-app satırı yazıldıktan
 * sonra gelen bir yeniden teslimde push taze makbuzla başarılı olur
 * (`replayed=false`) ve in-app satırı İKİNCİ kez yazılırdı. Kolon +
 * `WHERE channel='in_app' AND delivery_id IS NOT NULL` kısmi unique index'i
 * kopyayı VERİTABANI düzeyinde imkânsız kılar (tier-1) — yazıcı
 * `ON CONFLICT DO NOTHING` ile idempotent olur. Kolon nullable: makbuz
 * kimliği olmayan eski/serbest in-app satırları (uyarı bildirimleri)
 * index'in dışında kalır.
 *
 * Teslim tükenmesi (FARM-MEDIUM-260) bu serviste bir raf tablosuyla DEĞİL,
 * event-bus'ın platform dead-letter akışıyla (AQUACULTURE_DLQ) karşılanır;
 * handler yeniden fırlatır, bus NAK+backoff sonrası zarfı DLQ akışına yazar.
 */
@SourceOnlyMigration({
  reason:
    'notification-service is platform-level (not tenant-cloned); notification_logs lives in the notification source schema',
})
export class CreateNotificationInAppDeliveryReceipt1801100000000 implements MigrationInterface {
  name = 'CreateNotificationInAppDeliveryReceipt1801100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
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

  /** Kopya-imkânsızlığı index'i yerinde. */
  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT to_regclass('notification.uq_notification_logs_in_app_delivery') IS NOT NULL AS ok`,
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
  }
}
