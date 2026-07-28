import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateFeedingClockInfrastructure (W5 — FARM-LOW-264, FARM-MEDIUM-255,
 * FARM-MEDIUM-256, FARM-MEDIUM-290)
 *
 * Yemleme motorunun zaman semantiği bugüne dek İKİ yerde ve İKİ farklı
 * gerçeklikte tanımlıydı: `@Cron(..., { timeZone: 'Europe/Istanbul' })`
 * sabitleri (altı iş) ve `sites.timezone` (plan üretiminde okunan tek yer).
 * Norveç'te, Şili'de veya Türkiye'de aynı platformdan beslenen tenant'ların
 * hepsi İstanbul'un 06:00'ında plan üretiyor, İstanbul'un 20:00'ında gün
 * özetini alıyordu — kendi yerel günleri bitmeden.
 *
 * Bu migration iki cross-tenant tabloyu kurar (ikisi de `farm` kaynak
 * şemasında yaşar; tenant şemalarına KLONLANMAZ — bkz. @SourceOnlyMigration):
 *
 *  - `tenant_localization`: auth-service'in `TenantUpdated`/`TenantProvisioned`
 *    event'lerinden beslenen saat dilimi + yerel ayar projeksiyonu. Zon
 *    hiyerarşisinin (site → tenant → UTC) orta halkası; farm-service
 *    auth şemasına senkron sorgu ATMAZ.
 *
 *  - `feeding_job_runs`: "tenant'ın YEREL gününde tam bir kez" garantisinin
 *    kendisi. Saatlik UTC tick'i her tenant için yerel saati hesaplar; iş
 *    saati geldiğinde bu tabloya (tenantId, jobName, localDate) satırı
 *    yazılabiliyorsa iş koşar. Kısıt DB tarafında olduğu için çok-instance'lı
 *    dağıtımda da çift koşu YAPISAL olarak imkânsızdır (advisory lock yalnız
 *    eşzamanlılığı önler, "bugün zaten koştu"yu değil).
 *
 *    `status` sütunu kasıtlıdır: satır bir CLAIM'dir, bir "yapıldı" damgası
 *    değil. Başarısız (veya sayfalama nedeniyle yarım kalan) koşu
 *    `running`/`failed` kalır ve bir sonraki saatlik tick aynı yerel gün için
 *    yeniden dener; yalnız `succeeded` satırı yeniden denemeyi kapatır.
 */
@SourceOnlyMigration({
  reason:
    'tenant_localization + feeding_job_runs are cross-tenant farm infrastructure ledgers ' +
    '(tenantId-discriminated) and must not be cloned into tenant schemas',
})
export class CreateFeedingClockInfrastructure1807200000000 implements MigrationInterface {
  name = 'CreateFeedingClockInfrastructure1807200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "tenant_localization" (
         "tenantId"        uuid PRIMARY KEY,
         "timezone"        varchar(64) NOT NULL DEFAULT 'UTC',
         "locale"          varchar(16),
         "sourceUpdatedAt" TIMESTAMP WITH TIME ZONE,
         "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
       )`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "feeding_job_runs" (
         "id"          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
         "tenantId"    uuid NOT NULL,
         "jobName"     varchar(64) NOT NULL,
         "localDate"   date NOT NULL,
         "timezone"    varchar(64) NOT NULL,
         "status"      varchar(16) NOT NULL DEFAULT 'running',
         "attempts"    integer NOT NULL DEFAULT 1,
         "startedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "completedAt" TIMESTAMP WITH TIME ZONE,
         "error"       text,
         CONSTRAINT "CHK_fjr_status" CHECK ("status" IN ('running', 'succeeded', 'failed'))
       )`,
    );
    // Exactly-once-per-local-day kısıtı: claim yazımı bu indekse çarpar.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fjr_tenant_job_local_date"
         ON "feeding_job_runs" ("tenantId", "jobName", "localDate")`,
    );
    // Retention taraması (aylık purge) tarih üzerinden yürür.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fjr_started_at" ON "feeding_job_runs" ("startedAt")`,
    );
  }

  /** İki ledger de yaratıldı ve tekillik kısıtı yerinde (claim'in dayanağı). */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         to_regclass('tenant_localization') IS NOT NULL
         AND to_regclass('feeding_job_runs') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE indexname = 'UQ_fjr_tenant_job_local_date'
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "feeding_job_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_localization"`);
  }
}
