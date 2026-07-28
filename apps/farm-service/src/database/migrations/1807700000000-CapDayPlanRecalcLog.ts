import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CapDayPlanRecalcLog (W8 — FARM-MEDIUM-286)
 *
 * `feeding_day_plans."recalcLog"` jsonb dizisi ÜST SINIRSIZ büyüyordu ve
 * tamamı GraphQL'de açıktı. Bir gün planı sıcaklık sapması, ölüm, hasat,
 * transfer, ayıklama, protokol değişimi, atama değişimi ve manuel geçişle
 * yeniden hesaplanabilir — yoğun bir ünitede tek satır günde onlarca girdi
 * biriktirip hem jsonb'yi hem tel yükünü şişiriyordu.
 *
 * Kırpmak tek başına BİLGİ KAYBIDIR, bu yüzden `recalcCount` sayacı aynı
 * migration'da eklenir ve mevcut satırlar için dizinin GERÇEK uzunluğundan
 * backfill edilir: kırpılmış planlar bile "bugün kaç kez hesaplandım"
 * sorusuna doğru cevap verir. Denetim izinin tamamı zaten outbox/audit
 * tarafında yaşamaya devam eder.
 *
 * Tenant-aware tablo: DDL şema-niteliksizdir, search_path yönlendirir.
 */
export class CapDayPlanRecalcLog1807700000000 implements MigrationInterface {
  name = 'CapDayPlanRecalcLog1807700000000';

  /** Uygulama sabiti `RECALC_LOG_MAX_ENTRIES` ile aynı olmalı. */
  private static readonly MAX_ENTRIES = 50;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `ALTER TABLE "feeding_day_plans"
         ADD COLUMN IF NOT EXISTS "recalcCount" integer NOT NULL DEFAULT 0`,
    );

    // Sayaç ÖNCE doldurulur: kırpmadan sonra gerçek uzunluk okunamaz.
    await queryRunner.query(
      `UPDATE "feeding_day_plans"
          SET "recalcCount" = jsonb_array_length("recalcLog")
        WHERE "recalcLog" IS NOT NULL
          AND jsonb_typeof("recalcLog") = 'array'
          AND "recalcCount" = 0`,
    );

    // Son N girdi korunur (en yeniler operatöre anlamlı olanlar).
    await queryRunner.query(
      `UPDATE "feeding_day_plans"
          SET "recalcLog" = (
                SELECT COALESCE(jsonb_agg(entry ORDER BY ord), '[]'::jsonb)
                  FROM (
                    SELECT entry, ord
                      FROM jsonb_array_elements("recalcLog") WITH ORDINALITY AS t(entry, ord)
                     ORDER BY ord DESC
                     LIMIT ${CapDayPlanRecalcLog1807700000000.MAX_ENTRIES}
                  ) kept
              )
        WHERE "recalcLog" IS NOT NULL
          AND jsonb_typeof("recalcLog") = 'array'
          AND jsonb_array_length("recalcLog") > ${CapDayPlanRecalcLog1807700000000.MAX_ENTRIES}`,
    );
  }

  /** Hiçbir plan sınırın üstünde değil ve sayaç kolonu yerinde. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM "feeding_day_plans"
          WHERE jsonb_typeof("recalcLog") = 'array'
            AND jsonb_array_length("recalcLog") > ${CapDayPlanRecalcLog1807700000000.MAX_ENTRIES}
       ) AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'feeding_day_plans' AND column_name = 'recalcCount'
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Kırpılan girdiler geri gelmez (jsonb'de saklanmıyorlar) — yalnız sayaç
    // kolonu düşer; bu bilinçli ve belgeli tek yönlü kayıptır.
    await queryRunner.query(
      `ALTER TABLE "feeding_day_plans" DROP COLUMN IF EXISTS "recalcCount"`,
    );
  }
}
