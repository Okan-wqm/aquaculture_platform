import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddForecastPoolScope (W6 — FARM-HIGH-249)
 *
 * Forecast kapsamları aynı FİZİKSEL kg'ı iki kez taahhüt ediyordu: deposu olan
 * her sitenin satırı kendi stoğunu kendi tüketimine karşı simüle ederken,
 * deposuz siteler için üretilen `tenant` fallback satırı TÜM sitelerin
 * toplam stoğunu okuyordu. Site A'nın deposundaki 3 ton hem A'nın üniteleri
 * hem fallback üniteleri için "mevcut" sayılıyor, tedarik uyarı penceresi
 * sistematik olarak eriyordu (7 gün için tasarlanan uyarı ~4.2 günde çalar).
 *
 * Kullanıcı kararı: **havuz TEK tenant havuzudur** (deposuz sitenin öğünü
 * fiziksel olarak başka sitenin lotunu tüketir). Bu kolon o kararı satır
 * düzeyinde görünür kılar: `TENANT` satırı kapsama/alarm OTORİTESİDİR,
 * `SITE` satırları bilgilendiricidir ve alarm üretmez.
 *
 * Backfill mevcut satırları semantiklerine göre etiketler; bir sonraki
 * forecast koşusu (07:00 cron veya event-driven yenileme) satırları yeni
 * havuz matematiğiyle ZATEN üzerine yazar — bu migration yalnız aradaki
 * pencerede okunan satırların yanlış otorite iddia etmesini engeller.
 */
export class AddForecastPoolScope1809300000000 implements MigrationInterface {
  name = 'AddForecastPoolScope1809300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `ALTER TABLE "feeding_forecast_snapshots"
         ADD COLUMN IF NOT EXISTS "poolScope" varchar(8) NOT NULL DEFAULT 'SITE'`,
    );
    await queryRunner.query(
      `UPDATE "feeding_forecast_snapshots"
          SET "poolScope" = CASE WHEN "siteScopeKey" = 'tenant' THEN 'TENANT' ELSE 'SITE' END`,
    );
  }

  /** Her satır bir havuz semantiği taşıyor (otorite belirsizliği kalmadı). */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM "feeding_forecast_snapshots"
          WHERE "poolScope" NOT IN ('TENANT', 'SITE')
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "feeding_forecast_snapshots" DROP COLUMN IF EXISTS "poolScope"`,
    );
  }
}
