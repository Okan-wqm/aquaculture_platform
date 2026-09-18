import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EnforceSingleLiveAssignmentPerUnit (W0 — FARM-MEDIUM-256 + FARM-MEDIUM-250a)
 *
 * `IDX_fpa_tenant_unit_active` yalnız `status = 'active'` satırlarını kapsıyor,
 * yani bir ünite 1 aktif + N paused atama taşıyabiliyor. Üretilebilir birikim
 * yolu: protokol arşivlenir → tüm aktif atamalar PAUSED olur → operatör yeni
 * protokolü atar → yeniden atama YALNIZ ACTIVE olanı ENDED yapar → eski PAUSED
 * satır sonsuza dek kalır. Sonuçlar:
 *
 *  - `detectUnfedUnits` LEFT JOIN'i ünite başına birden çok satır döndürür ve
 *    paused satır WHERE'i geçer → düzgün beslenen ünite her sabah
 *    `UnfedUnitDetected` → her gün CRITICAL incident (alarm körlüğü, D-5'in
 *    emniyet ağının kanıt değeri sıfırlanır);
 *  - operatör paused atamayı resume etmek isterse partial unique index'e
 *    çarpar ve temiz 409 yerine ham `duplicate key` 500 alır;
 *  - `1806500000000` aktivasyon migration'ının `NOT EXISTS` alt sorgusu
 *    statement-başı snapshot gördüğü için aynı ünitedeki iki paused satırı
 *    birlikte aktive edip index'i ihlal edebilir (fazlı/staging akışında
 *    migration rollback → servis boot etmez → filo yarı-migre kalır).
 *
 * Kalıcı çözüm invariant'ı DARALTMAK değil GENİŞLETMEKtir: "ünite başına tek
 * CANLI atama" (`status <> 'ended'`). Böylece hem çift planlama hem paused
 * birikimi DB tarafından imkânsız olur (tier-1) ve yukarıdaki üç belirti tek
 * kısıtla ölür.
 *
 * Tekilleştirme deterministiktir: aktif satır kazanır, eşitlikte en yeni
 * `effectiveFrom`/`createdAt`. Kaybedenler `ended` olarak tarihçeye iner
 * (silinmez — traceability bu geçmişi okur).
 */
export class EnforceSingleLiveAssignmentPerUnit1808800000000 implements MigrationInterface {
  name = 'EnforceSingleLiveAssignmentPerUnit1808800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    const demoted: Array<{ count: number }> = await queryRunner.query(
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY "tenantId", "unitId"
                  ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                           "effectiveFrom" DESC NULLS LAST,
                           "createdAt" DESC
                ) AS rn
           FROM "feeding_protocol_assignments"
          WHERE status <> 'ended'
       ),
       losers AS (
         UPDATE "feeding_protocol_assignments" a
            SET status = 'ended',
                "endedAt" = COALESCE(a."endedAt", now())
           FROM ranked r
          WHERE a.id = r.id AND r.rn > 1
         RETURNING a.id
       )
       SELECT (SELECT COUNT(*) FROM losers)::int AS count`,
    );

    // Index daraltma: 'active' → 'canlı' (active + paused).
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fpa_tenant_unit_active"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fpa_tenant_unit_live"
         ON "feeding_protocol_assignments" ("tenantId", "unitId")
       WHERE "status" <> 'ended'`,
    );

    await queryRunner.query(
      `SELECT 'single-live-assignment: ' || $1 || ' duplicate live assignment(s) ended' AS summary`,
      [Number(demoted[0]?.count ?? 0)],
    );
  }

  /** Ünite başına en fazla bir canlı atama VE kısıt gerçekten kurulu. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         NOT EXISTS (
           SELECT 1
             FROM "feeding_protocol_assignments"
            WHERE status <> 'ended'
            GROUP BY "tenantId", "unitId"
           HAVING COUNT(*) > 1
         )
         AND EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname = 'IDX_fpa_tenant_unit_live'
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fpa_tenant_unit_live"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fpa_tenant_unit_active"
         ON "feeding_protocol_assignments" ("tenantId", "unitId")
       WHERE "status" = 'active'`,
    );
  }
}
