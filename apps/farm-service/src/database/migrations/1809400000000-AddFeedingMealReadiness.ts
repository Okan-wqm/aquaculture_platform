import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddFeedingMealReadiness (W7 — FARM-MEDIUM-271)
 *
 * `MealWindowUpcoming` her öğün için `minDissolvedOxygen` ve
 * `lowOxygenReductionPercent` taşıyordu ama platformda bu alanları OKUYAN
 * kimse yoktu: operatörün protokolde kurduğu oksijen koruması tele yazılıp
 * düşüyordu, üstelik `windowNotifiedAt` aynı transaction'da yandığı için
 * pencere yeniden üretilip kontrol telafi de edilemiyordu.
 *
 * Bu kolon, sensor-service'in ürettiği `FeedingWindowReadiness` verdiktinin
 * öğün düzeyindeki evidir: MealBoard rozeti buradan beslenir, yani kontrol
 * artık operatörün gözünde bir DAVRANIŞ üretir. Yalnız OLUMSUZ verdiktte
 * dolar — `NULL` "olumlu" anlamına gelmez, "bu öğün için olumsuz sinyal
 * gelmedi" anlamına gelir ve UI onu bilerek rozetsiz gösterir.
 *
 * Tenant-aware tablo: DDL şema-niteliksizdir, search_path yönlendirir.
 */
export class AddFeedingMealReadiness1809400000000 implements MigrationInterface {
  name = 'AddFeedingMealReadiness1809400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `ALTER TABLE "feeding_meals" ADD COLUMN IF NOT EXISTS "readiness" jsonb NULL`,
    );
  }

  /** Kolon var ve nullable — mevcut satırlar geriye dönük damgalanmaz. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'feeding_meals'
            AND column_name = 'readiness'
            AND is_nullable = 'YES'
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "feeding_meals" DROP COLUMN IF EXISTS "readiness"`);
  }
}
