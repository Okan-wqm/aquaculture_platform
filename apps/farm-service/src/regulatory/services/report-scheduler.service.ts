/**
 * Report Scheduler Service (RPT-003) — assembles regulatory report drafts on
 * the official Oslo-timezone cadence so operators find a ready-to-review draft
 * each period instead of starting from a blank form.
 *
 * Cadence (Europe/Oslo):
 *   - Mon 03:00  weekly rollover  → SEA_LICE + SLAUGHTER_EXECUTED for the
 *                                   previous ISO week, SLAUGHTER_PLANNED for
 *                                   the week two ahead (its Thursday deadline
 *                                   falls this week).
 *   - 1st 03:00  monthly rollover → SMOLT + CLEANER_FISH + BIOMASS for the
 *                                   previous month.
 *   - Daily 07:00 deadline sweep  → detect non-terminal drafts already due.
 *
 * Fail-closed: a draft is created ONLY for a site that carries a
 * lokalitetsnummer (the regulator keys reports by lokalitet). A tenant with
 * sites but no mappings gets one structured warning, never a guessed draft.
 * Rollover is idempotent — one draft per (tenant, reportType, site, period) via
 * INSERT … ON CONFLICT DO NOTHING, so a re-run never duplicates and never
 * resurrects a dismissed draft.
 *
 * Multi-instance safe via a PostgreSQL advisory lock per job. Tenant discovery
 * mirrors FeedingCronService: schema names are truncated (tenant_<16hex>), so
 * the full tenantId is read from each schema's `sites` rows, never derived from
 * the schema name.
 */
import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { listTenantSchemas, runInTenantTransaction } from '@aquaculture/backend-common/database';

import { ReportAssemblyService, ReportPrefillType } from '../assembly/report-assembly.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryReportStoreService } from './regulatory-report-store.service';
import { RegulatorySubmissionService } from './regulatory-submission.service';
import { isoWeekOf } from '../assembly/period.util';
import { computeDueDate, osloDateString } from './report-deadlines';
import { ReportDraftStatus } from '../entities/regulatory-report-draft.entity';

/** 'RPRT' in hex — the advisory-lock namespace for regulatory scheduling. */
const ADVISORY_LOCK_NAMESPACE = 0x52505254;

/**
 * Per-tenant cap on replays attempted in one retry-sweep tick. A single tenant
 * with a large backlog cannot monopolise the sweep; the remainder is picked up
 * on the next 30-minute run once their nextAttemptAt is still due.
 */
const RETRY_SWEEP_BATCH_LIMIT = 50;

/** A single report to assemble for a site in a rollover. */
export interface RolloverJob {
  reportType: ReportPrefillType;
  year: number;
  week?: number;
  month?: number;
}

export interface OverdueDraftRow {
  id: string;
  reportType: string;
  siteId: string;
  dueAt: string;
  status: string;
}

@Injectable()
export class ReportSchedulerService {
  private readonly logger = new Logger(ReportSchedulerService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly assemblyService: ReportAssemblyService,
    private readonly settingsService: RegulatorySettingsService,
    private readonly reportStore: RegulatoryReportStoreService,
    private readonly submissionService: RegulatorySubmissionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ==========================================================================
  // CRON ENTRY POINTS
  // ==========================================================================

  @Cron('0 3 * * 1', { name: 'regulatory-weekly-rollover', timeZone: 'Europe/Oslo' })
  async weeklyRollover(now: Date = new Date()): Promise<void> {
    await this.runJob('regulatory-weekly-rollover', (tenantId) =>
      this.rolloverForTenant(tenantId, ReportSchedulerService.weeklyJobs(now)),
    );
  }

  @Cron('0 3 1 * *', { name: 'regulatory-monthly-rollover', timeZone: 'Europe/Oslo' })
  async monthlyRollover(now: Date = new Date()): Promise<void> {
    await this.runJob('regulatory-monthly-rollover', (tenantId) =>
      this.rolloverForTenant(tenantId, ReportSchedulerService.monthlyJobs(now)),
    );
  }

  @Cron('0 7 * * *', { name: 'regulatory-deadline-sweep', timeZone: 'Europe/Oslo' })
  async deadlineSweep(now: Date = new Date()): Promise<void> {
    await this.runJob('regulatory-deadline-sweep', async (tenantId) => {
      const overdue = await this.sweepOverdueForTenant(tenantId, now);
      if (overdue.length > 0) {
        this.eventEmitter.emit('regulatory.deadline.overdue', {
          tenantId,
          count: overdue.length,
          drafts: overdue,
          detectedAt: osloDateString(now),
        });
        this.logger.warn(
          `Tenant ${tenantId.slice(0, 8)}…: ${overdue.length} regulatory report(s) past due`,
        );
      }
      return overdue.length;
    });
  }

  @Cron('*/30 * * * *', { name: 'regulatory-retry-sweep', timeZone: 'Europe/Oslo' })
  async retrySweep(now: Date = new Date()): Promise<void> {
    await this.runJob('regulatory-retry-sweep', (tenantId) =>
      this.retrySweepForTenant(tenantId, now),
    );
  }

  // ==========================================================================
  // PURE PERIOD MATH (testable without a clock)
  // ==========================================================================

  /** Weekly jobs: previous ISO week (lice + executed slaughter) + week+2 (planned). */
  static weeklyJobs(now: Date): RolloverJob[] {
    const prev = isoWeekOf(new Date(now.getTime() - 7 * 86_400_000));
    const planned = isoWeekOf(new Date(now.getTime() + 14 * 86_400_000));
    return [
      { reportType: ReportPrefillType.SEA_LICE, year: prev.isoYear, week: prev.isoWeek },
      { reportType: ReportPrefillType.SLAUGHTER_EXECUTED, year: prev.isoYear, week: prev.isoWeek },
      {
        reportType: ReportPrefillType.SLAUGHTER_PLANNED,
        year: planned.isoYear,
        week: planned.isoWeek,
      },
    ];
  }

  /** Monthly jobs: previous calendar month (smolt + cleaner fish + biomass). */
  static monthlyJobs(now: Date): RolloverJob[] {
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth(); // 0-based current → previous month is this value (1-based)
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    return [
      { reportType: ReportPrefillType.SMOLT, year, month },
      { reportType: ReportPrefillType.CLEANER_FISH, year, month },
      { reportType: ReportPrefillType.BIOMASS, year, month },
    ];
  }

  // ==========================================================================
  // PER-TENANT WORK (testable)
  // ==========================================================================

  /**
   * Assemble + upsert every job for every lokalitetsnummer-mapped site of the
   * tenant. Returns how many NEW drafts were created (idempotent re-runs → 0).
   */
  async rolloverForTenant(tenantId: string, jobs: RolloverJob[]): Promise<number> {
    const mappings = await this.settingsService.getEffectiveSiteLocalityMappings(tenantId);
    const siteIds = Object.keys(mappings);
    if (siteIds.length === 0) {
      this.logger.warn(
        `Tenant ${tenantId.slice(0, 8)}…: no sites carry a lokalitetsnummer — no drafts ` +
          'assembled (configure it in Setup → Sites to enable automated reporting).',
      );
      return 0;
    }

    let created = 0;
    for (const siteId of siteIds) {
      for (const job of jobs) {
        created += await this.upsertDraft(tenantId, siteId, job);
      }
    }
    return created;
  }

  /**
   * Assemble one draft and insert it, idempotently. Returns 1 when a new draft
   * row was created, 0 when one already existed (ON CONFLICT DO NOTHING) or the
   * assembler could not build the period (logged, never fatal to the batch).
   */
  async upsertDraft(tenantId: string, siteId: string, job: RolloverJob): Promise<number> {
    let assembled;
    try {
      assembled = await this.assemblyService.assemble(tenantId, job.reportType, siteId, {
        year: job.year,
        week: job.week,
        month: job.month,
      });
    } catch (error) {
      this.logger.error(
        `Assembly failed for ${job.reportType} site ${siteId.slice(0, 8)}…: ` +
          `${(error as Error).message}`,
      );
      return 0;
    }

    const dueAt = computeDueDate(job.reportType, {
      year: job.year,
      week: job.week,
      month: job.month,
    });
    const status = assembled.schemaValid ? ReportDraftStatus.READY : ReportDraftStatus.DRAFT;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const result = await queryRunner.manager.query(
        `INSERT INTO "regulatory_report_drafts"
           ("tenantId", "reportType", "siteId", "periodYear", "periodWeek", "periodMonth",
            "status", "assembledPayload", "fieldMeta", "schemaValid", "dueAt", "assembledAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
         ON CONFLICT ("tenantId", "reportType", "siteId", "periodYear",
                      COALESCE("periodWeek", 0), COALESCE("periodMonth", 0))
         DO NOTHING
         RETURNING id`,
        [
          tenantId,
          job.reportType,
          siteId,
          job.year,
          job.week ?? null,
          job.month ?? null,
          status,
          JSON.stringify(assembled.draftPayload),
          JSON.stringify(assembled.fields),
          assembled.schemaValid,
          dueAt,
          assembled.assembledAt,
        ],
      );
      // RETURNING id yields one row on a fresh insert and zero rows when the
      // period already had a draft (ON CONFLICT DO NOTHING) — so the row count
      // is exactly the number of NEW drafts created.
      return Array.isArray(result) ? result.length : 0;
    });
  }

  /** Non-terminal drafts whose deadline has passed (Oslo calendar date). */
  async sweepOverdueForTenant(tenantId: string, now: Date): Promise<OverdueDraftRow[]> {
    const today = osloDateString(now);
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.manager.query(
        `SELECT id, "reportType", "siteId", "dueAt"::text AS "dueAt", status
           FROM "regulatory_report_drafts"
          WHERE "tenantId" = $1
            AND "dueAt" IS NOT NULL
            AND "dueAt" <= $2
            AND status IN ('draft', 'ready', 'approved')
          ORDER BY "dueAt" ASC`,
        [tenantId, today],
      );
    });
  }

  /**
   * Replay every FAILED+TRANSIENT report whose backoff has elapsed. Each replay
   * goes through RegulatorySubmissionService.resubmit, which re-validates the
   * stored payload through the brand gate and re-applies the outcome (success →
   * SUBMITTED, still-transient → next backoff, now-permanent → terminal +
   * outbox). A single row's failure never aborts the batch. Returns the count of
   * rows that reached a terminal SUBMITTED state this tick.
   */
  async retrySweepForTenant(tenantId: string, now: Date): Promise<number> {
    const due = await this.reportStore.listDueRetries(tenantId, now, RETRY_SWEEP_BATCH_LIMIT);
    let submitted = 0;
    for (const row of due) {
      try {
        const result = await this.submissionService.resubmit(tenantId, row.id);
        if (result.success) submitted += 1;
      } catch (error) {
        this.logger.error(
          `Retry replay failed for report ${row.id.slice(0, 8)}…: ${(error as Error).message}`,
          (error as Error).stack,
        );
      }
    }
    if (due.length > 0) {
      this.logger.log(
        `Tenant ${tenantId.slice(0, 8)}…: replayed ${due.length} due report(s), ` +
          `${submitted} now SUBMITTED`,
      );
    }
    return submitted;
  }

  // ==========================================================================
  // ORCHESTRATION (advisory lock + tenant discovery)
  // ==========================================================================

  private async runJob(
    jobName: string,
    perTenant: (tenantId: string) => Promise<number>,
  ): Promise<void> {
    if (!(await this.tryAcquireAdvisoryLock(jobName))) {
      this.logger.log(`${jobName}: another instance holds the lock, skipping`);
      return;
    }
    const startedAt = Date.now();
    let tenants = 0;
    let total = 0;
    try {
      const tenantIds = await this.discoverTenantIds();
      for (const tenantId of tenantIds) {
        try {
          total += await perTenant(tenantId);
          tenants += 1;
        } catch (error) {
          this.logger.error(
            `${jobName} failed for tenant ${tenantId.slice(0, 8)}…: ${(error as Error).message}`,
            (error as Error).stack,
          );
        }
      }
      this.logger.log(
        `${jobName}: processed ${tenants} tenant(s), ${total} unit(s) in ${Date.now() - startedAt}ms`,
      );
    } finally {
      await this.releaseAdvisoryLock(jobName);
    }
  }

  /**
   * Distinct tenantIds across all tenant schemas. Each tenant_<uuid> schema
   * holds one tenant's rows; the full uuid is read from `sites` because the
   * schema name is a truncated 16-hex derivation and cannot be reversed.
   */
  private async discoverTenantIds(): Promise<string[]> {
    const schemas = await listTenantSchemas(this.dataSource);
    const tenantIds = new Set<string>();
    for (const schema of schemas) {
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}", farm, public`);
        const rows: Array<{ tenantId: string }> = await runner.query(
          `SELECT DISTINCT "tenantId" FROM sites LIMIT 1`,
        );
        for (const row of rows) {
          if (row.tenantId) tenantIds.add(row.tenantId);
        }
      } catch (error) {
        this.logger.error(
          `Tenant discovery failed for schema ${schema}: ${(error as Error).message}`,
        );
      } finally {
        await runner.query('RESET search_path').catch(() => undefined);
        await runner.release();
      }
    }
    return Array.from(tenantIds);
  }

  private getAdvisoryLockKey(jobName: string): number {
    return crypto.createHash('sha256').update(jobName).digest().readInt32LE(0);
  }

  private async tryAcquireAdvisoryLock(jobName: string): Promise<boolean> {
    const result = await this.dataSource.query(`SELECT pg_try_advisory_lock($1, $2) AS acquired`, [
      ADVISORY_LOCK_NAMESPACE,
      this.getAdvisoryLockKey(jobName),
    ]);
    return result[0]?.acquired === true;
  }

  private async releaseAdvisoryLock(jobName: string): Promise<void> {
    await this.dataSource.query(`SELECT pg_advisory_unlock($1, $2)`, [
      ADVISORY_LOCK_NAMESPACE,
      this.getAdvisoryLockKey(jobName),
    ]);
  }
}
