import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FeedingCutoverActivateAssignments (Faz 6 — plan §11 "migration #2", K-3/K-5/K-14)
 *
 * Cutover veri geçişi: Faz 4'ün `paused` yarattığı v2 atamaları aktive edilir
 * ve superseded legacy programlar kapatılır. Kod tarafındaki eşi K-5 kapısıdır
 * (`legacyFeedingEngineEnabled()` — legacy üretim/bildirim işleri kapalı):
 * bu ikili birlikte "tek üretici v2" durumunu kurar.
 *
 *  - Aktivasyon YALNIZ ACTIVE (silinmemiş) protokole işaret eden paused
 *    atamalar için: DRAFT/ARCHIVED protokole işaret eden atama AKTİVE
 *    EDİLMEZ (K-14 yapısal bacağı) — bu atamalar paused kalır ve D-5
 *    süpürmesi üniteyi `draft_protocol` gerekçesiyle raporlamaya devam eder.
 *  - Ünitesinde ZATEN aktif atama olan paused satır atlanır (partial unique
 *    index `(tenantId, unitId) WHERE status='active'` ihlal edilemez).
 *  - Aktive edilen satırlar `overrides.cutoverActivatedAt` işaretini taşır —
 *    down() yalnız bu işaretli satırları geri pause eder (operatörün elle
 *    aktive ettiği atamalara dokunulmaz).
 *  - Legacy `feeding_programs` (draft/active/paused) `completed`'a çekilir ve
 *    `settings.cutoverCompletedFrom` işaretini alır — down() yalnız işaretli
 *    satırları eski durumuna döndürür. Program tanımları Faz 8 drop'una kadar
 *    salt-okunur tarih olarak yaşar; `recordDailyFeeding` drain penceresi
 *    programa değil mevcut execution'lara bağlıdır, etkilenmez.
 *
 * Operatör kapısı (K-14/D-5): bu migration'ı içeren release'in merge'ü,
 * Faz 5 dry-run (`dryRunForTenant`) + Faz 4 mutabakat raporunun operatör
 * onayından geçtiğini varsayar — plan §11 Faz 6 kapı koşulu. Migration DRAFT
 * atamaları aktive ETMEYEREK yanlış onayda dahi fail-safe kalır.
 *
 * İdempotent: aktivasyon filtresi `status='paused'`, program filtresi işaret
 * yokluğu — tekrar koşum no-op. DDL yok; tüm ifadeler ŞEMA-NİTELEMESİZ, her
 * tenant pass'i kendi şemasının verisini işler (tenant fan-out disiplini).
 */
export class FeedingCutoverActivateAssignments1806500000000 implements MigrationInterface {
  name = 'FeedingCutoverActivateAssignments1806500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    // 1) Aktivasyon — yalnız ACTIVE protokollü paused atamalar; ünitede aktif
    // atama varsa atla. Işaret down() reversibility'si içindir.
    const activated: Array<{ id: string }> = await queryRunner.query(
      `UPDATE "feeding_protocol_assignments" pa
          SET status = 'active',
              "overrides" = pa."overrides" || jsonb_build_object('cutoverActivatedAt', now()::text),
              "updatedAt" = now()
        WHERE pa.status = 'paused'
          AND EXISTS (
            SELECT 1 FROM "feeding_protocols_v2" p
             WHERE p.id = pa."protocolId"
               AND p."tenantId" = pa."tenantId"
               AND p.status = 'active'
               AND p."isDeleted" = false
          )
          AND NOT EXISTS (
            SELECT 1 FROM "feeding_protocol_assignments" other
             WHERE other."tenantId" = pa."tenantId"
               AND other."unitId" = pa."unitId"
               AND other.status = 'active'
          )
        RETURNING pa.id`,
    );

    // 2) Aktive EDİLEMEYEN paused atamalar (DRAFT/ARCHIVED protokol) — sayı
    // operasyonel görünürlük için loglanır; D-5 süpürmesi üniteleri raporlar.
    const blocked: Array<{ count: string | number }> = await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM "feeding_protocol_assignments" pa
        WHERE pa.status = 'paused'
          AND NOT EXISTS (
            SELECT 1 FROM "feeding_protocols_v2" p
             WHERE p.id = pa."protocolId"
               AND p."tenantId" = pa."tenantId"
               AND p.status = 'active'
               AND p."isDeleted" = false
          )`,
    );

    // 3) Legacy programlar superseded → completed (işaretli, geri alınabilir).
    const completed: Array<{ id: string }> = await queryRunner.query(
      `UPDATE "feeding_programs"
          SET settings = COALESCE(settings, '{}'::jsonb)
                         || jsonb_build_object('cutoverCompletedFrom', status),
              status = 'completed',
              "updatedAt" = now()
        WHERE "isDeleted" = false
          AND status IN ('draft', 'active', 'paused')
        RETURNING id`,
    );

    // Migration çıktısı runner logunda görünür (RAISE yerine taşınabilir yol).
    await queryRunner.query(
      `SELECT 'feeding-cutover: ' || $1 || ' assignments activated, ' || $2 ||
              ' paused (blocked on non-active protocol), ' || $3 || ' programs completed' AS summary`,
      [activated.length, Number(blocked[0]?.count ?? 0), completed.length],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);

    // Yalnız cutover'ın aktive ettiği atamalar geri pause edilir.
    await queryRunner.query(
      `UPDATE "feeding_protocol_assignments"
          SET status = 'paused',
              "overrides" = "overrides" - 'cutoverActivatedAt',
              "updatedAt" = now()
        WHERE status = 'active'
          AND "overrides" ? 'cutoverActivatedAt'`,
    );

    // Yalnız cutover'ın kapattığı programlar eski durumuna döner.
    await queryRunner.query(
      `UPDATE "feeding_programs"
          SET status = (settings->>'cutoverCompletedFrom'),
              settings = settings - 'cutoverCompletedFrom',
              "updatedAt" = now()
        WHERE status = 'completed'
          AND settings ? 'cutoverCompletedFrom'`,
    );
  }
}
