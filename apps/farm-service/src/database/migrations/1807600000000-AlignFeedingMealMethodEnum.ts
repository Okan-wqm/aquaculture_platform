import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AlignFeedingMealMethodEnum (W8 — FARM-MEDIUM-257)
 *
 * `RecordMealFeedingInput.feedingMethod` doğrulanmamış bir `string`di ve
 * `FeedingLedgerService`'e `as FeedingMethod` diye cast edilip
 * `feeding_records."feedingMethod"` PG ENUM kolonuna yazılıyordu. Enum üyesi
 * olmayan herhangi bir değer orada `22P02 invalid input value for enum` ile
 * patlıyor — ve bu, öğün kaydının TAMAMINI (döküm, stok düşümü, büyüme,
 * outbox satırı) rollback ettiriyordu. Yani mobil istemcideki bir yazım hatası
 * operatörün yemlemesini kaydedilemez hâle getiriyordu.
 *
 * DTO artık `@IsEnum(FeedingMethod)` ile kapıda reddediyor (tier-1 girdi
 * kenarı). Bu migration ikinci kapıyı DB'ye koyuyor: `feeding_meals`
 * kolonu da varchar(50)'den ENUM'a çekiliyor, böylece geçersiz bir değer
 * hangi yoldan gelirse gelsin YAZILAMAZ — GraphQL'i baypas eden bir yol
 * (ileride bir seeder, bir betik) da aynı kısıta çarpar.
 *
 * FAIL-CLOSED: eşlenemeyen değer varsa migration PATLAR ve o değerleri
 * listeler. Sessizce NULL'a çevirmek operatörün "otomatik besledim" kaydını
 * yok etmek olurdu; kararı operatör verir.
 *
 * Tenant-aware tablo: DDL şema-niteliksizdir; enum tipi `current_schema()`
 * içinde aranıp yoksa yaratılır (tanks_containerkind_enum emsali).
 */
export class AlignFeedingMealMethodEnum1807600000000 implements MigrationInterface {
  name = 'AlignFeedingMealMethodEnum1807600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = current_schema() AND t.typname = 'feeding_meals_feedingmethod_enum'
        ) THEN
          CREATE TYPE feeding_meals_feedingmethod_enum
            AS ENUM ('manual', 'automatic', 'demand', 'broadcast', 'spot');
        END IF;
      END $$;
    `);

    // Serbest metin döneminden kalan kozmetik sapmalar (büyük harf, boşluk)
    // normalize edilir — bunlar operatörün NİYETİ belli olan değerlerdir.
    await queryRunner.query(`
      UPDATE "feeding_meals"
         SET "feedingMethod" = lower(btrim("feedingMethod"))
       WHERE "feedingMethod" IS NOT NULL
         AND "feedingMethod" <> lower(btrim("feedingMethod"))
    `);
    await queryRunner.query(`
      UPDATE "feeding_meals"
         SET "feedingMethod" = NULL
       WHERE "feedingMethod" IS NOT NULL
         AND btrim("feedingMethod") = ''
    `);

    // Niyeti belli OLMAYAN değerlerde durur ve operatöre listeyi verir.
    const unmappable: Array<{ value: string; rows: string }> = await queryRunner.query(`
      SELECT DISTINCT "feedingMethod" AS value, count(*)::text AS rows
        FROM "feeding_meals"
       WHERE "feedingMethod" IS NOT NULL
         AND "feedingMethod" NOT IN ('manual', 'automatic', 'demand', 'broadcast', 'spot')
       GROUP BY 1
    `);
    if (unmappable.length > 0) {
      const detail = unmappable.map((r) => `${r.value} (${r.rows} satır)`).join(', ');
      throw new Error(
        `feeding_meals."feedingMethod" ENUM'a çekilemiyor — tanınmayan değerler: ${detail}. ` +
          'Bu satırları FeedingMethod üyelerinden birine güncelleyin veya NULL yapın, ' +
          'sonra migration’ı yeniden koşun.',
      );
    }

    // R10 replay güvenliği: kolon ZATEN enum ise ikinci koşuda `USING` cast'i
    // tip uyuşmazlığıyla patlardı. Mevcut şekli okuyup yalnız gerekliyse
    // dönüştürüyoruz.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'feeding_meals'
             AND column_name = 'feedingMethod'
             AND udt_name <> 'feeding_meals_feedingmethod_enum'
        ) THEN
          ALTER TABLE "feeding_meals"
            ALTER COLUMN "feedingMethod" TYPE feeding_meals_feedingmethod_enum
            USING "feedingMethod"::feeding_meals_feedingmethod_enum;
        END IF;
      END $$;
    `);
  }

  /** Kolon ENUM ve tip mevcut şemada tanımlı. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns c
         WHERE c.table_schema = current_schema()
           AND c.table_name = 'feeding_meals'
           AND c.column_name = 'feedingMethod'
           AND c.udt_name = 'feeding_meals_feedingmethod_enum'
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'feeding_meals'
             AND column_name = 'feedingMethod'
             AND udt_name = 'feeding_meals_feedingmethod_enum'
        ) THEN
          ALTER TABLE "feeding_meals"
            ALTER COLUMN "feedingMethod" TYPE character varying(50)
            USING "feedingMethod"::text;
        END IF;
      END $$;
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS feeding_meals_feedingmethod_enum`);
  }
}
