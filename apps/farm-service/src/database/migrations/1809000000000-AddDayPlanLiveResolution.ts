import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDayPlanLiveResolution (W3 — FARM-HIGH-247, FARM-MEDIUM-251/252, FARM-LOW-262/263)
 *
 * `feeding_day_plans.snapshot` iki farklı şeyi tek jsonb'de taşıyordu:
 * üretim anının ÖLÇÜMÜ (biyokütle, sayı, sıcaklık) ve protokol ÇÖZÜMÜ
 * (band, yem, oran, beklenen FCR). İkincisi gün içinde değişir — ama snapshot
 * hiçbir yolda güncellenmiyordu (`grep '\.snapshot\s*='` → sıfır eşleşme).
 * Sonuçlar sahaya doğrudan yansıyordu:
 *
 *  - band geçişinden sonra öğünlerin `feedId`'si YENİ yeme dönüyor, plan
 *    ekranı ve mobil hâlâ ESKİ yemi gösteriyordu: operatör yanlış pelleti
 *    döküyor, ledger başka ürünü düşüyordu (FARM-HIGH-247);
 *  - büyüme hesabı donmuş `snapshot.expectedFcr` ile yapılıyordu; band0 0.9 →
 *    band1 1.4 geçişinde o öğünün büyümesi ~%55 fazla hesaplanıp biyokütleye
 *    yazılıyor ve ertesi günün planına taban oluyordu (FARM-MEDIUM-252).
 *
 * `resolution` kolonu ÇÖZÜMÜ ayırır ve her yeniden hesapta atomik güncellenir;
 * `snapshot` üretim anı provenansı olarak DONUK kalır (tarihsel kayıt değeri
 * korunur). Backfill mevcut satırların çözüm alanlarını snapshot'tan taşır —
 * hiçbir plan boş `resolution` ile kalmaz.
 */
export class AddDayPlanLiveResolution1809000000000 implements MigrationInterface {
  name = 'AddDayPlanLiveResolution1809000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    await queryRunner.query(
      `ALTER TABLE "feeding_day_plans"
         ADD COLUMN IF NOT EXISTS "resolution" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );

    // Mevcut planlar: çözüm alanları snapshot'tan taşınır. `resolvedAt`
    // planın üretim anıdır (o çözüm o an geçerliydi).
    await queryRunner.query(
      `UPDATE "feeding_day_plans"
          SET "resolution" = jsonb_strip_nulls(
                jsonb_build_object(
                  'resolvedAt', to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'bandIndex', COALESCE((snapshot->>'bandIndex')::int, 0),
                  'feed', COALESCE(snapshot->'feed', '{}'::jsonb),
                  'baseRatePercent', COALESCE((snapshot->>'baseRatePercent')::numeric, 0),
                  'tempMultiplier', COALESCE((snapshot->>'tempMultiplier')::numeric, 1),
                  'effectiveRatePercent', COALESCE((snapshot->>'effectiveRatePercent')::numeric, 0),
                  'expectedFcr', COALESCE((snapshot->>'expectedFcr')::numeric, 0),
                  'fcrResolvedSource', COALESCE(snapshot->>'fcrResolvedSource', 'BAND'),
                  'bandBasisWeightG', COALESCE((snapshot->>'avgWeightG')::numeric, 0),
                  'waterTempC', snapshot->'waterTempC',
                  'temperatureSource', COALESCE(snapshot->>'temperatureSource', 'none')
                )
              )
        WHERE "resolution" = '{}'::jsonb`,
    );
  }

  /** Hiçbir plan çözümsüz kalmadı (boş jsonb = okuyucular için kör nokta). */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM "feeding_day_plans"
          WHERE "resolution" = '{}'::jsonb OR "resolution"->>'expectedFcr' IS NULL
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "feeding_day_plans" DROP COLUMN IF EXISTS "resolution"`);
  }
}
