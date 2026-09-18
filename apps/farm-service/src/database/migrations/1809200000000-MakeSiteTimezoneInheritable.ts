import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MakeSiteTimezoneInheritable (W5 — FARM-LOW-264)
 *
 * `sites.timezone` `NOT NULL DEFAULT 'UTC'` idi: "saat dilimi belirtilmemiş"
 * ile "saat dilimi UTC" aynı satır değeriyle temsil ediliyor, dolayısıyla
 * kalıtım (site → tenant → UTC) İFADE EDİLEMİYORDU. Tenant kendi saat dilimini
 * ayarladığında, kolonu hiç doldurmamış siteleri yine de UTC'de kalırdı —
 * yemleme günü tenant'ın gününden kayardı.
 *
 * NULL artık "tenant'tan devral" demektir; zon çözümü tek fonksiyonda
 * (`FeedingClockService.resolveSiteZones`) yapılır. Backfill'in `'UTC'` →
 * NULL çevirmesi güvenlidir: `'UTC'` bir OPERATÖR SEÇİMİ değil, kolonun
 * kendi varsayılanıydı (Baseline `DEFAULT 'UTC'`), ve tenant lokalizasyonu
 * varsayılan olarak yine `'UTC'` döndürür — bugünkü davranış birebir korunur,
 * tenant zonunu ayarladığı AN siteler onu izlemeye başlar. Bundan sonra UTC'yi
 * bilinçli seçen site kolonu açıkça `'UTC'` yazar (site formunda "tenant
 * ayarını kullan" ayrı bir seçenektir).
 */
export class MakeSiteTimezoneInheritable1809200000000 implements MigrationInterface {
  name = 'MakeSiteTimezoneInheritable1809200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    // Replay-güvenli: kolon zaten nullable/default'suz ise DDL hiç koşmaz.
    // (Fan-out her tenant şemasında ayrı ayrı yürür; ikinci geçiş sessiz
    // no-op değil, ölçülmüş bir atlamadır.)
    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'sites'
              AND column_name = 'timezone'
              AND (is_nullable = 'NO' OR column_default IS NOT NULL)
         ) THEN
           ALTER TABLE "sites" ALTER COLUMN "timezone" DROP DEFAULT;
           ALTER TABLE "sites" ALTER COLUMN "timezone" DROP NOT NULL;
         END IF;
       END $$`,
    );
    await queryRunner.query(`UPDATE "sites" SET "timezone" = NULL WHERE "timezone" = 'UTC'`);
  }

  /** Kalıtım ifade edilebilir hâle geldi (kolon nullable ve default'suz). */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (c.is_nullable = 'YES' AND c.column_default IS NULL) AS ok
         FROM information_schema.columns c
        WHERE c.table_schema = current_schema()
          AND c.table_name = 'sites'
          AND c.column_name = 'timezone'`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "sites" SET "timezone" = 'UTC' WHERE "timezone" IS NULL`);
    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'sites'
              AND column_name = 'timezone'
              AND is_nullable = 'YES'
         ) THEN
           ALTER TABLE "sites" ALTER COLUMN "timezone" SET DEFAULT 'UTC';
           ALTER TABLE "sites" ALTER COLUMN "timezone" SET NOT NULL;
         END IF;
       END $$`,
    );
  }
}
