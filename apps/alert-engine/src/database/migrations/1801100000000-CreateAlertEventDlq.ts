import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { buildEventDlqDownSql, buildEventDlqUpSql } from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateAlertEventDlq (W7 — FARM-MEDIUM-260)
 *
 * alert-engine, yemleme motorunun tek-atımlık durum geçişlerini
 * (`MealMissed`, `MealUnderfed`, `FeedTypeTransitioned`, `LowStockDetected`)
 * tüketiyor. Bu dalgaya kadar tüketici hatayı YUTUYORDU çünkü yutmamanın tek
 * alternatifi sonsuz yeniden teslimdi: mesajın gidebileceği kalıcı bir raf
 * yoktu. Raf bu tablodur — `max_deliver` tükenen mesaj `term()` edilmeden ÖNCE
 * buraya yazılır, böylece "kaybettik" bilgisi hiçbir zaman yalnızca bir log
 * satırı olmaz.
 *
 * DDL şekli `@platform/outbox`'ın paylaşılan `buildEventDlqUpSql`'inden gelir
 * (farm.event_dlq ile birebir aynı kolonlar) — üç servisin rafı elle yazılıp
 * birbirinden sapamaz.
 */
@SourceOnlyMigration({
  reason:
    'event_dlq is cross-tenant event-delivery infrastructure — an operator must see every tenant’s dropped messages in one place, so it is never cloned into tenant schemas',
})
export class CreateAlertEventDlq1801100000000 implements MigrationInterface {
  name = 'CreateAlertEventDlq1801100000000';

  private static readonly OPTIONS = {
    schema: 'alert',
    failedAtIndexName: 'idx_alert_event_dlq_failed_at',
    tenantIndexName: 'idx_alert_event_dlq_tenant',
  } as const;

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildEventDlqUpSql(CreateAlertEventDlq1801100000000.OPTIONS)) {
      await queryRunner.query(sql);
    }
  }

  /** Raf gerçekten var — tüketici `term()` etmeden önce yazacak bir yer buldu. */
  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT to_regclass('alert.event_dlq') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildEventDlqDownSql(CreateAlertEventDlq1801100000000.OPTIONS)) {
      await queryRunner.query(sql);
    }
  }
}
