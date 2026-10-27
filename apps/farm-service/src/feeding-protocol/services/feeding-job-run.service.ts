/**
 * FeedingJobRunService — "tenant'ın yerel gününde tam bir kez" claim'i (W5).
 *
 * Saatlik UTC tick'i her tenant için yerel saati çözer; iş saati geldiğinde
 * buradan bir CLAIM ister. Claim `(tenantId, jobName, localDate)` UNIQUE
 * kısıtına çarpar, dolayısıyla:
 *
 *  - DST'de saat geri alındığında tick aynı yerel saati İKİ kez görse de iş
 *    bir kez koşar (eski `@Cron(timeZone)` çözümü bu gecede işi çiftliyordu),
 *  - çok-instance'lı dağıtımda ikinci başarılı koşu imkânsızdır,
 *  - başarısız veya sayfalama yüzünden YARIM kalan koşu `succeeded` olmaz ve
 *    bir sonraki saatlik tick aynı yerel gün için yeniden dener — "gün
 *    kaçtı, yarına kadar bekle" davranışı ölür.
 *
 * ## Tenant bağlamı
 *
 * `farm.feeding_job_runs` tenantId ile ayrışan bir CROSS-TENANT defterdir ama
 * FORCE row-level security altındadır (politika: `tenantId = app.current_tenant`).
 * Cron tick'inde istek yoktur; bağlamsız bir INSERT politikaya takılır ve her
 * claim reddedilirdi. Bu yüzden her claim/settle/purge çağrısı kendi tenant'ının
 * `runInTenantTransaction` bağlamında koşar — defter satırı, ait olduğu tenant
 * dışında hiçbir bağlamda görünmez veya yazılamaz.
 *
 * @module FeedingProtocol/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { DataSource, LessThan } from 'typeorm';

import { FeedingJobRun } from '../entities/feeding-job-run.entity';

/** Yarım kalmış koşuların kaydı sonsuza dek büyümesin (aylık purge). */
export const JOB_RUN_RETENTION_DAYS = 120;

/** `feeding_job_runs` `farm` kaynak şemasında yaşar; tenant bağlamı bu şemadan açılır. */
const LEDGER_SOURCE_SCHEMA = 'farm';

@Injectable()
export class FeedingJobRunService {
  private readonly logger = new Logger(FeedingJobRunService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Yerel gün için koşu hakkı ister. `null` = bu yerel gün ZATEN başarıyla
   * koştu (atla). Aksi hâlde dönen id ile `settle` çağrılmalıdır.
   *
   * Claim ATOMİK olmak zorunda (INSERT … ON CONFLICT … RETURNING), bu yüzden
   * ham sorgu; kalan erişimler entity üzerinden.
   */
  async claim(
    tenantId: string,
    jobName: string,
    localDate: string,
    timezone: string,
  ): Promise<string | null> {
    return runInTenantTransaction(
      this.dataSource,
      LEDGER_SOURCE_SCHEMA,
      tenantId,
      async (queryRunner) => {
        const rows: Array<{ id: string }> = await queryRunner.query(
          `INSERT INTO farm.feeding_job_runs
             ("tenantId", "jobName", "localDate", "timezone", "status", "attempts", "startedAt")
           VALUES ($1, $2, $3::date, $4, 'running', 1, now())
           ON CONFLICT ("tenantId", "jobName", "localDate") DO UPDATE
             SET "status" = 'running',
                 "attempts" = farm.feeding_job_runs."attempts" + 1,
                 "startedAt" = now(),
                 "completedAt" = NULL,
                 "error" = NULL
           WHERE farm.feeding_job_runs."status" <> 'succeeded'
           RETURNING id`,
          [tenantId, jobName, localDate, timezone],
        );
        return rows[0]?.id ?? null;
      },
    );
  }

  /** Koşuyu kapatır. `succeeded` DIŞINDAKİ her sonuç yeniden denemeye açıktır. */
  async settle(tenantId: string, runId: string, succeeded: boolean, error?: string): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      LEDGER_SOURCE_SCHEMA,
      tenantId,
      async (queryRunner) => {
        await queryRunner.manager.update(
          FeedingJobRun,
          { id: runId },
          {
            status: succeeded ? 'succeeded' : 'failed',
            completedAt: new Date(),
            error: error ? error.slice(0, 2000) : null,
          },
        );
      },
    );
  }

  /**
   * Aylık retention — kayıt operasyonel kanıttır, sonsuz saklanmaz. Tenant
   * başına koşar: defter RLS altında olduğundan tenant dışı çağrı hiçbir
   * satırı göremez ve sessizce 0 silerdi.
   */
  async purgeOlderThanRetention(tenantId: string): Promise<number> {
    const cutoff = new Date(Date.now() - JOB_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged = await runInTenantTransaction(
      this.dataSource,
      LEDGER_SOURCE_SCHEMA,
      tenantId,
      async (queryRunner) => {
        const result = await queryRunner.manager.delete(FeedingJobRun, {
          startedAt: LessThan(cutoff),
        });
        return result.affected ?? 0;
      },
    );
    if (purged > 0) {
      this.logger.log(
        `Retention purge: ${purged} feeding job runs removed (tenant ${tenantId.substring(0, 8)}...).`,
      );
    }
    return purged;
  }
}
