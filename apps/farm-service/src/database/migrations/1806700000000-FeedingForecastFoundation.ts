import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FeedingForecastFoundation1806700000000 (Faz 7 — plan §5 + K-10/K-17)
 *
 * Tükenme-tahmini altyapısının şema temeli:
 *  - `feeding_forecast_snapshots`: 07:00 cron'unun MAKS ufukta (120 gün)
 *    hesapladığı materyalize snapshot; sorgu istenen ufka DİLİMLER, yeniden
 *    hesap yapmaz (K-10 — belirlenebilir bayatlık > cache stampede).
 *    `(tenantId, siteScopeKey)` unique → site başına tek canlı satır;
 *    event-driven yenileme (D-6) aynı satırı günceller. `computedAt`
 *    indeksi tazelik süpürmeleri için.
 *  - `feeds.procurementLeadTimeDays` (K-17): geçiş-kapsama boşluğu hesabının
 *    tedarik süresi girdisi; nullable — belgeli default 7 gün servis
 *    katmanında uygulanır (sessiz DB default'u yok, kaynak görünür kalır).
 *
 * Tablo TENANT-SCOPED'tur; DDL şema-nitelemesizdir (her pass kendi şemasına
 * indirir — ORPHAN-HIGH-408 dersi). Salt additive; blue-green güvenli.
 */
export class FeedingForecastFoundation1806700000000 implements MigrationInterface {
  name = 'FeedingForecastFoundation1806700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "feeding_forecast_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "siteScopeKey" character varying(100) NOT NULL,
        "horizonDays" integer NOT NULL,
        "computedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "perFeed" jsonb NOT NULL DEFAULT '[]',
        "perUnit" jsonb NOT NULL DEFAULT '[]',
        "alerts" jsonb NOT NULL DEFAULT '[]',
        "mortalityAssumption" jsonb NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL,
        CONSTRAINT "PK_feeding_forecast_snapshots" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ffs_tenant_scope" ON "feeding_forecast_snapshots" ("tenantId", "siteScopeKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ffs_computed_at" ON "feeding_forecast_snapshots" ("computedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ffs_tenant" ON "feeding_forecast_snapshots" ("tenantId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "feeds" ADD COLUMN IF NOT EXISTS "procurementLeadTimeDays" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "feeds" DROP COLUMN IF EXISTS "procurementLeadTimeDays"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feeding_forecast_snapshots"`);
  }
}
