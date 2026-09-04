import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BackfillFeedingRecordBatchLocationAttribution (W0 — FARM-HIGH-240 + FARM-CRITICAL-241)
 *
 * ## 1. Attribution kusuru (FARM-HIGH-240)
 *
 * `1806600000000-BackfillExecutionsToFeedingRecords` legacy execution'ları
 * `feeding_records`'a taşırken batch'i **anlık** doluluktan çözüyordu:
 *
 *   JOIN "tank_batches" tb ON tb."tankId" = e."equipmentId"  →  tb."primaryBatchId"
 *
 * `tank_batches` tank başına TEK satırdır ve `primaryBatchId` her doluluk
 * değişiminde ÜZERİNE yazılır — tankın ŞU ANKİ batch'ini gösterir, yemlemenin
 * yapıldığı tarihteki batch'i değil. Turnover görmüş bir tankta (A hasat
 * edildi, B stoklandı) A'nın 800 günlük yem geçmişi B'ye yazılır;
 * `fcr-calculation.service.ts` kümülatif FCR'ı alt tarih sınırı OLMADAN
 * `batchId` üzerinden okuduğu için hata doğrudan operatörün eylem aldığı FCR
 * KPI'sına ve finans türetimlerine akar. Hiçbir NOT NULL/FK ihlali üretmez —
 * sessizdir.
 *
 * ## 2. Provenans — `feeding_record_provenance` TEK yetkili kaynaktır
 *
 * Backfill satırlarını canlı drain satırlarından ayırt etmek için bu migration
 * eskiden kendi `feeding_records."backfillSource"` kolonunu ekliyordu. O kolon
 * KALDIRILDI: `1808600000000-ProtectFeedingRecordBackfillProvenance`
 * (FARM-CRITICAL-241) provenansı içerikten türetmeyi bırakıp yazan
 * transaction'ın `xmin`'i ile sınıflandıran, değiştirilemez
 * `feeding_record_provenance` defterini kurdu — `BACKFILL_180660`,
 * `LIVE_DRAIN`, `UNKNOWN`. İkinci bir damga ikinci bir doğruluk kaynağı olurdu
 * ve ikisi er ya da geç ayrışırdı; provenans TEK yerde yaşar.
 *
 * Bu yüzden onarım adayları `origin = 'BACKFILL_180660'` kanıtı olan satırlarla
 * SINIRLIDIR: `UNKNOWN` (kanıtlanamayan) satırlara dokunulmaz — fail-closed
 * yön veriyi KORUYAN yöndür. Bu migration 1808600000000'den SONRA koştuğu için
 * defter her zaman mevcuttur; sıra manifest'te sabittir.
 *
 * ## 3. Onarım politikası — üç sınıf, YIKICI OLMAYAN
 *
 *  - `batch_locations` o (ünite, tarih) için bir occupancy döndürüyorsa →
 *    `batchId` + `batchLocationId` ondan yazılır (yetkili kaynak);
 *  - ünitenin batch_locations GEÇMİŞİ VAR ama o tarihi kapsayan satır YOK →
 *    kayıt gerçekten attribute edilemez → `feeding_record_attribution_quarantine`
 *    tablosuna taşınır (silinmez: veri incelenebilir ve geri alınabilir kalır);
 *  - ünitenin hiç batch_locations geçmişi YOK → daha iyi bilgi mevcut değil,
 *    satır OLDUĞU GİBİ bırakılır ve sayılır. (Turnover görmemiş tanklarda
 *    mevcut attribution zaten doğrudur; bu sınıfı silmek doğru veriyi yok
 *    ederdi.)
 *
 * Aggregate mutabakatı DELTA ile yapılır (yeniden hesap DEĞİL): retention
 * penceresi dışındaki (800 günden eski) yem katkısı `feeding_records`'ta artık
 * yoktur; toplamı sıfırdan hesaplamak o katkıyı silerdi.
 *
 * Orijinal migration DEĞİŞTİRİLMEZ (gönderilmiş migration bağışıklığı):
 * fan-out sırası manifest'te sabit olduğundan yeni tenant'larda önce eski
 * yazım, hemen ardından bu düzeltme koşar — deterministik zincir.
 */
export class BackfillFeedingRecordBatchLocationAttribution1808700000000
  implements MigrationInterface
{
  name = 'BackfillFeedingRecordBatchLocationAttribution1808700000000';

  /**
   * `feeding_record_provenance.origin` değeri: 1806600000000 backfill'inin
   * yazdığı, xmin ile KANITLANMIŞ satırlar. 1808600000000'in CHECK kısıtıyla
   * aynı sözcük — defterdeki sınıflandırma bu migration'ın da tek girdisidir.
   */
  static readonly BACKFILL_ORIGIN = 'BACKFILL_180660';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    // (1) Karantina tablosu (şema-nitelemesiz). Provenans kolonu YOK: sınıf
    // bilgisi `feeding_record_provenance` defterinde yaşar (1808600000000).
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "feeding_record_attribution_quarantine" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "tenantId" uuid NOT NULL,
         "feedingRecordId" uuid NOT NULL,
         "batchId" uuid NOT NULL,
         "tankId" uuid,
         "feedingDate" date NOT NULL,
         "actualAmount" numeric(10,3) NOT NULL,
         "feedCost" numeric(12,2),
         "currency" varchar(3),
         "feedId" uuid,
         "sourceExecutionId" uuid,
         "reason" varchar(64) NOT NULL,
         "quarantinedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_feeding_record_attribution_quarantine" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fraq_tenant_record"
         ON "feeding_record_attribution_quarantine" ("tenantId", "feedingRecordId")`,
    );

    // (2) Attribution onarımı — YALNIZ defterin `BACKFILL_180660` diye
    // KANITLADIĞI satırlar. `UNKNOWN` satırlar tahminle onarılmaz.
    const result: Array<{ repaired: number; quarantined: number; unknown_history: number }> =
      await queryRunner.query(
        `WITH candidate AS (
           SELECT fr.id,
                  fr."tenantId",
                  fr."batchId"               AS old_batch,
                  fr."tankId",
                  fr."feedingDate",
                  fr."actualAmount"          AS amount,
                  COALESCE(fr."feedCost", 0) AS cost,
                  fr.currency,
                  fr."feedId",
                  fr."sourceExecutionId",
                  bl."batchId"               AS new_batch,
                  bl.id                      AS batch_location_id,
                  EXISTS (
                    SELECT 1 FROM "batch_locations" h
                     WHERE h."tenantId" = fr."tenantId" AND h."tankId" = fr."tankId"
                  )                          AS has_history
             FROM "feeding_records" fr
             JOIN "feeding_record_provenance" p
               ON p.feeding_record_id = fr.id
              AND p.origin = $1
             LEFT JOIN LATERAL (
               SELECT bl."batchId", bl.id
                 FROM "batch_locations" bl
                WHERE bl."tenantId" = fr."tenantId"
                  AND bl."tankId" = fr."tankId"
                  AND bl."movedAt"::date <= fr."feedingDate"::date
                  AND (bl."exitedAt" IS NULL OR bl."exitedAt"::date > fr."feedingDate"::date)
                ORDER BY bl."movedAt" DESC
                LIMIT 1
             ) bl ON true
         ),
         repaired AS (
           UPDATE "feeding_records" fr
              SET "batchId" = c.new_batch,
                  "batchLocationId" = c.batch_location_id
             FROM candidate c
            WHERE fr.id = c.id
              AND fr."tenantId" = c."tenantId"
              AND c.new_batch IS NOT NULL
              AND (fr."batchId" <> c.new_batch
                   OR fr."batchLocationId" IS DISTINCT FROM c.batch_location_id)
           RETURNING c.old_batch, c.new_batch, c.amount, c.cost
         ),
         parked AS (
           INSERT INTO "feeding_record_attribution_quarantine"
             ("tenantId", "feedingRecordId", "batchId", "tankId", "feedingDate",
              "actualAmount", "feedCost", currency, "feedId", "sourceExecutionId", reason)
           SELECT c."tenantId", c.id, c.old_batch, c."tankId", c."feedingDate",
                  c.amount, c.cost, c.currency, c."feedId", c."sourceExecutionId",
                  'no_occupancy_on_feeding_date'
             FROM candidate c
            WHERE c.new_batch IS NULL AND c.has_history
           RETURNING "feedingRecordId", "batchId" AS old_batch, "actualAmount" AS amount,
                     COALESCE("feedCost", 0) AS cost
         ),
         removed AS (
           DELETE FROM "feeding_records" fr
            USING parked p
            WHERE fr.id = p."feedingRecordId"
           RETURNING p.old_batch, p.amount, p.cost
         ),
         deltas AS (
           SELECT old_batch AS batch, -SUM(amount) AS amount, -SUM(cost) AS cost
             FROM removed GROUP BY old_batch
           UNION ALL
           SELECT old_batch, -SUM(amount), -SUM(cost) FROM repaired GROUP BY old_batch
           UNION ALL
           SELECT new_batch, SUM(amount), SUM(cost) FROM repaired GROUP BY new_batch
         ),
         net AS (
           SELECT batch, SUM(amount) AS amount, SUM(cost) AS cost FROM deltas GROUP BY batch
         ),
         applied AS (
           UPDATE "batches_v2" b
              SET "totalFeedConsumed" = GREATEST(COALESCE(b."totalFeedConsumed", 0) + net.amount, 0),
                  "totalFeedCost" = GREATEST(COALESCE(b."totalFeedCost", 0) + net.cost, 0)
             FROM net
            WHERE b.id = net.batch
           RETURNING b.id
         )
         SELECT (SELECT COUNT(*) FROM repaired)::int AS repaired,
                (SELECT COUNT(*) FROM removed)::int  AS quarantined,
                (SELECT COUNT(*) FROM candidate WHERE new_batch IS NULL AND NOT has_history)::int
                  AS unknown_history`,
        [BackfillFeedingRecordBatchLocationAttribution1808700000000.BACKFILL_ORIGIN],
      );

    await queryRunner.query(
      `SELECT 'feeding-record attribution: ' || $1 ||
              ' re-attributed from batch_locations, ' || $2 ||
              ' quarantined (unit occupied by nobody on that date), ' || $3 ||
              ' left as-is (unit has no batch_locations history)' AS summary`,
      [
        Number(result[0]?.repaired ?? 0),
        Number(result[0]?.quarantined ?? 0),
        Number(result[0]?.unknown_history ?? 0),
      ],
    );
  }

  /**
   * Defterin `BACKFILL_180660` diye kanıtladığı hiçbir satır `batch_locations`
   * ile ÇELİŞMİYOR (çelişki = o tarihte o ünitede o batch yoktu VE ünitenin
   * occupancy geçmişi var).
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT NOT EXISTS (
         SELECT 1
           FROM "feeding_records" fr
           JOIN "feeding_record_provenance" p
             ON p.feeding_record_id = fr.id
            AND p.origin = $1
          WHERE EXISTS (
              SELECT 1 FROM "batch_locations" h
               WHERE h."tenantId" = fr."tenantId" AND h."tankId" = fr."tankId"
            )
            AND NOT EXISTS (
              SELECT 1
                FROM "batch_locations" bl
               WHERE bl."tenantId" = fr."tenantId"
                 AND bl."tankId" = fr."tankId"
                 AND bl."batchId" = fr."batchId"
                 AND bl."movedAt"::date <= fr."feedingDate"::date
                 AND (bl."exitedAt" IS NULL OR bl."exitedAt"::date > fr."feedingDate"::date)
            )
       ) AS ok`,
      [BackfillFeedingRecordBatchLocationAttribution1808700000000.BACKFILL_ORIGIN],
    );
    return rows[0]?.ok === true;
  }

  /**
   * Karantinaya alınan satırlar `feeding_records`'a geri konur ve aggregate
   * deltaları geri alınır. Attribution düzeltmesinin kendisi geri alınmaz: eski
   * (yanlış) `batchId` saklanmıyor ve onu geri yazmak bug'ı geri getirmek
   * olurdu — `batchLocationId` kalır.
   *
   * Provenans yakalama trigger'ı bu tek INSERT için KAPATILIR. Sebep davranışsal
   * değil anlamsal: geri konan satırın provenansı DEĞİŞMEDİ — defterdeki
   * `BACKFILL_180660` satırı hâlâ duruyor ve doğru. Trigger açık kalsaydı aynı
   * satırı `LIVE_DRAIN` diye yeniden sınıflandırmaya çalışır, defterin
   * değişmezlik kuralına çarpar ve geri almayı `23505` ile komple durdururdu.
   * Kapsam tek ifadedir (aynı transaction, `finally` ile hemen yeniden açılır)
   * ve yalnız defterin zaten kanıtladığı satırlara dokunur.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    await queryRunner.query(
      `ALTER TABLE "feeding_records"
         DISABLE TRIGGER trg_feeding_records_capture_live_drain_provenance`,
    );
    try {
      await queryRunner.query(
        `WITH restored AS (
           INSERT INTO "feeding_records"
             (id, "tenantId", "batchId", "tankId", "feedingDate", "feedingTime",
              "feedId", "plannedAmount", "actualAmount", "feedCost", currency,
              "sourceExecutionId")
           SELECT q."feedingRecordId", q."tenantId", q."batchId", q."tankId", q."feedingDate",
                  '00:00', q."feedId", 0, q."actualAmount", q."feedCost", q.currency,
                  q."sourceExecutionId"
             FROM "feeding_record_attribution_quarantine" q
           ON CONFLICT (id) DO NOTHING
           RETURNING "batchId", "actualAmount", COALESCE("feedCost", 0) AS cost
         ),
         agg AS (
           SELECT "batchId", SUM("actualAmount") AS total, SUM(cost) AS cost
             FROM restored GROUP BY "batchId"
         )
         UPDATE "batches_v2" b
            SET "totalFeedConsumed" = COALESCE(b."totalFeedConsumed", 0) + agg.total,
                "totalFeedCost" = COALESCE(b."totalFeedCost", 0) + agg.cost
           FROM agg
          WHERE b.id = agg."batchId"`,
      );
    } finally {
      await queryRunner.query(
        `ALTER TABLE "feeding_records"
           ENABLE TRIGGER trg_feeding_records_capture_live_drain_provenance`,
      );
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "feeding_record_attribution_quarantine"`);
  }
}
