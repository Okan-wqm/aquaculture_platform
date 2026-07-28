import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDayPlanGrowthReconciliation (W1 — FARM-CRITICAL-244 + FARM-MEDIUM-289)
 *
 * DAILY büyüme rollup'ı iki yapısal kusur taşıyordu:
 *
 * 1. **Mod kararı plandan değil, protokolün O ANKİ ayarından okunuyordu.**
 *    Protokol ayarları yerinde güncelleniyor (`Object.assign(protocol, …)`),
 *    rollup sorgusunda `planDate` alt sınırı ve LIMIT yok, plan retention'ı
 *    24 ay. Sonuç: `per_meal → daily` dropdown'u ertesi 05:30'da 24 aya kadar
 *    plan'ı tek koşuda rollup'layıp ZATEN uygulanmış per-meal büyümenin
 *    üstüne ikinci kez ekliyor; `daily → per_meal` ise dün beslenmiş planları
 *    filtreden düşürüp bir günlük büyümeyi kalıcı kaybediyordu.
 *    → Mod artık PLANIN kolonudur: geçmiş planlar üretildikleri semantikle
 *      işlenir, protokol ayarı geçmişi yeniden yazamaz.
 *
 * 2. **Damga tek atımlıktı** (`rollupAppliedAt IS NOT NULL` = "bitti").
 *    Rollup'tan sonra gelen her gerçek — geç finalize edilen öğün,
 *    `correctMealPour` düzeltmesi — büyümeye HİÇ dönüşmüyordu: plan bir daha
 *    seçilmiyordu, `meal-execution` ise "rollup sahiplenir" diye atlıyordu.
 *    → Damga KÜMÜLATİF MUTABAKATa çevrilir: `rollupAppliedKg` o plan için
 *      büyümeye çevrilmiş toplam kg'dır; her koşu yalnız FARKI uygular ve
 *      seçim predikatı `rollupAppliedKg <> Σ actualKg`'dir. Geç finalize ve
 *      düzeltme deltaları yapısal olarak yakalanır.
 *
 * Ayrıca eski `IDX_fdp_rollup_pending` partial indeksi `rollupAppliedAt IS NULL`
 * üzerineydi: `planned`/`skipped`/`cancelled` planlar hiçbir zaman damgalanmadığı
 * için indekste sonsuza dek birikiyordu (FARM-MEDIUM-289). Yeni indeks rollup'ın
 * gerçek aday kümesini kapsar.
 *
 * `rollupAppliedAt` DÜŞÜRÜLMEZ (blue-green): okuma yolu yeni kolonlara geçer,
 * eski kolon bir sonraki temizlik dalgasında kalkar.
 */
export class AddDayPlanGrowthReconciliation1807000000000 implements MigrationInterface {
  name = 'AddDayPlanGrowthReconciliation1807000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    await queryRunner.query(
      `ALTER TABLE "feeding_day_plans"
         ADD COLUMN IF NOT EXISTS "growthApplicationMode" varchar(16) NOT NULL DEFAULT 'per_meal',
         ADD COLUMN IF NOT EXISTS "rollupAppliedKg" numeric(12,3) NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS "rollupGrowthKg" numeric(12,3) NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS "rollupLastRunAt" TIMESTAMP WITH TIME ZONE`,
    );

    // Mevcut planların modu: protokolün BUGÜNKÜ ayarı, tek seferlik en iyi
    // tahmin. Bundan sonrası üretim anında yazılır (meal-plan-generator).
    await queryRunner.query(
      `UPDATE "feeding_day_plans" dp
          SET "growthApplicationMode" =
                CASE WHEN p.settings->>'growthApplicationMode' = 'daily' THEN 'daily' ELSE 'per_meal' END
         FROM "feeding_protocols_v2" p
        WHERE p.id = dp."protocolId" AND p."tenantId" = dp."tenantId"`,
    );

    // Zaten rollup görmüş planlar: uygulanmış kg'ı gün toplamına eşitle ki
    // kümülatif predikat onları yeniden seçmesin (çift sayım olmaz).
    await queryRunner.query(
      `UPDATE "feeding_day_plans" dp
          SET "rollupAppliedKg" = t.total,
              "rollupGrowthKg" = CASE
                WHEN COALESCE((dp.snapshot->>'expectedFcr')::numeric, 0) > 0
                  THEN t.total / (dp.snapshot->>'expectedFcr')::numeric
                ELSE 0 END,
              "rollupLastRunAt" = dp."rollupAppliedAt"
         FROM (
           SELECT m."dayPlanId" AS id, COALESCE(SUM(m."actualKg"), 0) AS total
             FROM "feeding_meals" m
            GROUP BY m."dayPlanId"
         ) t
        WHERE t.id = dp.id AND dp."rollupAppliedAt" IS NOT NULL`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fdp_rollup_pending"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fdp_rollup_pending"
         ON "feeding_day_plans" ("tenantId", "planDate")
       WHERE "growthApplicationMode" = 'daily' AND status IN ('in_progress', 'completed')`,
    );
  }

  /** Kolonlar kurulu, indeks rollup aday kümesini kapsıyor. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'feeding_day_plans'
             AND column_name IN ('growthApplicationMode','rollupAppliedKg','rollupGrowthKg','rollupLastRunAt')
         ) = 4
         AND EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname = 'IDX_fdp_rollup_pending'
              AND indexdef LIKE '%growthApplicationMode%'
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fdp_rollup_pending"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fdp_rollup_pending"
         ON "feeding_day_plans" ("tenantId", "planDate")
       WHERE "rollupAppliedAt" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "feeding_day_plans"
         DROP COLUMN IF EXISTS "growthApplicationMode",
         DROP COLUMN IF EXISTS "rollupAppliedKg",
         DROP COLUMN IF EXISTS "rollupGrowthKg",
         DROP COLUMN IF EXISTS "rollupLastRunAt"`,
    );
  }
}
