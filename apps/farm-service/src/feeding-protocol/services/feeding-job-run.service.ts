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
 * @module FeedingProtocol/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';

import { FeedingJobRun } from '../entities/feeding-job-run.entity';

/** Yarım kalmış koşuların kaydı sonsuza dek büyümesin (aylık purge). */
export const JOB_RUN_RETENTION_DAYS = 120;

@Injectable()
export class FeedingJobRunService {
  private readonly logger = new Logger(FeedingJobRunService.name);

  constructor(
    // Claim ATOMİK olmak zorunda (INSERT … ON CONFLICT … RETURNING), bu yüzden
    // ham sorgu; kalan okumalar entity üzerinden.
    @InjectDataSource() private readonly dataSource: DataSource,
    /**
     * CROSS-TENANT ledger: `feeding_job_runs` `farm` kaynak şemasında yaşar ve
     * tenantId ile AYRIŞIR. Entity `schema: 'farm'` bildirdiği için repository
     * yazımı şema-niteliklidir; cron tick'i tenant bağlamı olmadan koşar.
     */
    @InjectRepository(FeedingJobRun)
    private readonly jobRunRepository: Repository<FeedingJobRun>,
  ) {}

  /**
   * Yerel gün için koşu hakkı ister. `null` = bu yerel gün ZATEN başarıyla
   * koştu (atla). Aksi hâlde dönen id ile `settle` çağrılmalıdır.
   */
  async claim(
    tenantId: string,
    jobName: string,
    localDate: string,
    timezone: string,
  ): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
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
  }

  /** Koşuyu kapatır. `succeeded` DIŞINDAKİ her sonuç yeniden denemeye açıktır. */
  async settle(runId: string, succeeded: boolean, error?: string): Promise<void> {
    await this.jobRunRepository.update(
      { id: runId },
      {
        status: succeeded ? 'succeeded' : 'failed',
        completedAt: new Date(),
        error: error ? error.slice(0, 2000) : null,
      },
    );
  }

  /** Aylık retention — kayıt operasyonel kanıttır, sonsuz saklanmaz. */
  async purgeOlderThanRetention(): Promise<number> {
    const cutoff = new Date(Date.now() - JOB_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.jobRunRepository.delete({ startedAt: LessThan(cutoff) });
    const purged = result.affected ?? 0;
    if (purged > 0) this.logger.log(`Retention purge: ${purged} feeding job runs removed.`);
    return purged;
  }
}
