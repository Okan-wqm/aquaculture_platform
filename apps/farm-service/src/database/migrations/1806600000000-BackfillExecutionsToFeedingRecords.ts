import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BackfillExecutionsToFeedingRecords (Faz 6 — plan §9.4, P-05 tarihsel bacak, C-12)
 *
 * Tamamlanmış legacy `daily_feeding_executions` kayıtları `feeding_records`'a
 * taşınır: FCR geçmişi (FCRCalculationService feeding_records'tan okur) ve
 * finans türetimleri (derived-cost-sources) legacy dönemin yemini artık görür.
 *
 *  - Kapsam (C-12): YALNIZ retention penceresi içindeki (800 gün —
 *    `cleanup_old_feeding_records` default'u) COMPLETED execution'lar; daha
 *    eskisi cold-storage export'ta kalır — pencere dışı satır üretmek gecelik
 *    temizlikte anında silinirdi.
 *  - İdempotency: `sourceExecutionId` unique partial index (Faz 5 şeması,
 *    IDX_fr_source_execution) — tekrar koşum VE K-4 delegasyonunun drain
 *    penceresinde yazdığı kayıtlar (aynı anahtar) çift satır üretemez.
 *  - batchId çözümü: ünitenin (equipmentId) tank_batches primary batch'i —
 *    execution'lar batch taşımaz. Primary batch'i çözülemeyen execution
 *    ATLANIR ve sayılır (fail-closed; feeding_records.batchId NOT NULL).
 *  - Maliyet (C-16): feeds.pricePerKg × actualKg (fiyatsız yem → NULL cost);
 *    para birimi tenant finance_settings default'u.
 *  - Mutabakat: eklenen satırların toplamı AYNI statement'ta
 *    `Batch.totalFeedConsumed/Cost`'a işlenir — legacy execution yolu bu
 *    aggregate'leri HİÇ artırmıyordu (K-4 commit'inde kapatılan bug'ın
 *    tarihsel bacağı). CTE tek-atomik olduğundan re-run'da (0 insert) aggregate
 *    bump da 0 olur. Plan §11 Faz 6 kapısı: rapor sorgusu aşağıdaki summary
 *    SELECT'idir; tenant bazında operatör incelemesi
 *    `feeding-protocol-v2-reconciliation.sql` üzerinden yapılır.
 *
 * DDL yok; tüm ifadeler ŞEMA-NİTELEMESİZ — her tenant pass'i kendi şemasının
 * verisini işler (tenant fan-out disiplini).
 */
export class BackfillExecutionsToFeedingRecords1806600000000 implements MigrationInterface {
  name = 'BackfillExecutionsToFeedingRecords1806600000000';

  /** C-12: feeding_records gecelik temizliğiyle hizalı pencere (gün). */
  static readonly RETENTION_WINDOW_DAYS = 800;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    const window = BackfillExecutionsToFeedingRecords1806600000000.RETENTION_WINDOW_DAYS;

    const inserted: Array<{ count: string | number }> = await queryRunner.query(
      `WITH eligible AS (
         SELECT e.id,
                e."tenantId",
                tb."primaryBatchId" AS "batchId",
                e."equipmentId",
                e."executionDate",
                to_char(COALESCE(e."completedAt", e."updatedAt"), 'HH24:MI') AS "feedingTime",
                (e.calculations->>'activeFeedId')::uuid AS "feedId",
                COALESCE((e.calculations->>'plannedFeedKg')::numeric, 0) AS planned,
                (e."actualResults"->>'actualFeedGivenKg')::numeric AS actual,
                COALESCE(e."completedBy", e."createdBy") AS "fedBy",
                e.notes,
                f."pricePerKg",
                fs.currency
           FROM "daily_feeding_executions" e
           JOIN "tank_batches" tb
             ON tb."tenantId" = e."tenantId" AND tb."tankId" = e."equipmentId"
            AND tb."primaryBatchId" IS NOT NULL
           LEFT JOIN "feeds" f
             ON f.id = (e.calculations->>'activeFeedId')::uuid AND f."tenantId" = e."tenantId"
           LEFT JOIN LATERAL (
             SELECT s."defaultCurrency" AS currency
               FROM "finance_settings" s
              WHERE s."tenantId" = e."tenantId"
              LIMIT 1
           ) fs ON true
          WHERE e.status = 'completed'
            AND e."actualResults" IS NOT NULL
            AND (e."actualResults"->>'actualFeedGivenKg')::numeric > 0
            AND e.calculations->>'activeFeedId' IS NOT NULL
            AND e."executionDate" >= CURRENT_DATE - INTERVAL '${window} days'
       ),
       ins AS (
         INSERT INTO "feeding_records"
           (id, "tenantId", "batchId", "tankId", "feedingDate", "feedingTime",
            "feedId", "plannedAmount", "actualAmount", variance, "variancePercent",
            "feedCost", currency, "fedBy", notes, "sourceExecutionId")
         SELECT uuid_generate_v4(), "tenantId", "batchId", "equipmentId",
                "executionDate", "feedingTime", "feedId", planned, actual,
                actual - planned,
                CASE WHEN planned > 0 THEN ROUND(((actual - planned) / planned) * 100, 2) ELSE 0 END,
                CASE WHEN "pricePerKg" IS NOT NULL THEN ROUND("pricePerKg"::numeric * actual, 2) END,
                -- Para birimi SSoT: finance_settings.defaultCurrency, yoksa
                -- platform default'u (PLATFORM_DEFAULT_CURRENCY = 'NOK').
                CASE WHEN "pricePerKg" IS NOT NULL THEN COALESCE(currency, 'NOK') END,
                "fedBy", notes, id
           FROM eligible
         ON CONFLICT ("sourceExecutionId") WHERE "sourceExecutionId" IS NOT NULL DO NOTHING
         RETURNING "batchId", "actualAmount", COALESCE("feedCost", 0) AS cost
       ),
       agg AS (
         SELECT "batchId", SUM("actualAmount") AS total, SUM(cost) AS cost
           FROM ins GROUP BY "batchId"
       ),
       upd AS (
         UPDATE "batches_v2" b
            SET "totalFeedConsumed" = COALESCE(b."totalFeedConsumed", 0) + agg.total,
                "totalFeedCost" = COALESCE(b."totalFeedCost", 0) + agg.cost
           FROM agg
          WHERE b.id = agg."batchId"
         RETURNING b.id
       )
       SELECT (SELECT COUNT(*) FROM ins)::int AS count`,
    );

    // Atlanan (batch'siz üniteli) completed execution sayısı — operasyonel rapor.
    const skipped: Array<{ count: string | number }> = await queryRunner.query(
      `SELECT COUNT(*)::int AS count
         FROM "daily_feeding_executions" e
        WHERE e.status = 'completed'
          AND e."actualResults" IS NOT NULL
          AND (e."actualResults"->>'actualFeedGivenKg')::numeric > 0
          AND e."executionDate" >= CURRENT_DATE - INTERVAL '${window} days'
          AND NOT EXISTS (
            SELECT 1 FROM "tank_batches" tb
             WHERE tb."tenantId" = e."tenantId" AND tb."tankId" = e."equipmentId"
               AND tb."primaryBatchId" IS NOT NULL
          )`,
    );

    await queryRunner.query(
      `SELECT 'execution-backfill: ' || $1 || ' records inserted, ' || $2 ||
              ' completed executions skipped (no resolvable primary batch)' AS summary`,
      [Number(inserted[0]?.count ?? 0), Number(skipped[0]?.count ?? 0)],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    // Yalnız backfill'in yazdığı satırlar (sourceExecutionId dolu VE öğün bağı
    // yok) geri alınır; aggregate'ler aynı toplamla düşülür. K-4 drain
    // kayıtları da sourceExecutionId taşır — onlar mealId'siz VE canlı yoldan
    // yazıldı; ayrım createdAt ile YAPILAMAZ, bu yüzden down() İKİSİNİ DE
    // kaldırır ve bu bilinçli bir kayıptır: rollback sonrası drain kayıtları
    // yeniden oluşturulamaz (migration down'ları veri kaybını her zaman
    // üstlenir; buradaki pencere cutover release'inin kendisidir).
    await queryRunner.query(
      `WITH removed AS (
         DELETE FROM "feeding_records"
          WHERE "sourceExecutionId" IS NOT NULL AND "mealId" IS NULL
         RETURNING "batchId", "actualAmount", COALESCE("feedCost", 0) AS cost
       ),
       agg AS (
         SELECT "batchId", SUM("actualAmount") AS total, SUM(cost) AS cost
           FROM removed GROUP BY "batchId"
       )
       UPDATE "batches_v2" b
          SET "totalFeedConsumed" = GREATEST(COALESCE(b."totalFeedConsumed", 0) - agg.total, 0),
              "totalFeedCost" = GREATEST(COALESCE(b."totalFeedCost", 0) - agg.cost, 0)
         FROM agg
        WHERE b.id = agg."batchId"`,
    );
  }
}
