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
 *   - Daily 07:00 deadline sweep  → raise an outbox reminder per draft whose
 *                                   deadline bucket transitions (approaching →
 *                                   due-soon → due → overdue).
 *   - 30-minute retry sweep       → replay FAILED+TRANSIENT submissions.
 *   After each rollover, READY drafts opted into auto-submit are transmitted.
 *
 * Fail-closed: a draft is created ONLY for a site that carries a
 * lokalitetsnummer (the regulator keys reports by lokalitet). A tenant with
 * sites but no mappings gets one structured warning, never a guessed draft.
 * Rollover is idempotent — one draft per (tenant, reportType, site, period) via
 * INSERT … ON CONFLICT DO NOTHING, so a re-run never duplicates and never
 * resurrects a dismissed draft.
 *
 * Multi-instance safe via a PostgreSQL advisory lock per job. Tenant discovery
 * mirrors `FeedingCronV2Service.tenantsForRetention`: schema names are truncated
 * (tenant_<16hex>), so the full tenantId is read from each schema's `sites` rows,
 * never derived from the schema name.
 */
import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { listTenantSchemas, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import type { RegulatoryReportDeadlineApproachingEvent } from '@platform/event-contracts';

import { ReportAssemblyService, ReportPrefillType } from '../assembly/report-assembly.service';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryReportStoreService } from './regulatory-report-store.service';
import { RegulatorySubmissionService } from './regulatory-submission.service';
import { RegulatoryReportDraftService } from './regulatory-report-draft.service';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import {
  AUTO_SUBMIT_ACTOR_ID,
  RegulatoryDraftSubmissionService,
} from './regulatory-draft-submission.service';
import { isoWeekOf } from '../assembly/period.util';
import { computeDueDate, deadlineBucket, osloDaysUntil } from './report-deadlines';
import {
  RegulatoryReportDraft,
  ReportDraftStatus,
} from '../entities/regulatory-report-draft.entity';

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
    private readonly draftService: RegulatoryReportDraftService,
    private readonly draftSubmissionService: RegulatoryDraftSubmissionService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly metrics: FarmDomainMetricsService,
  ) {}

  // ==========================================================================
  // CRON ENTRY POINTS
  // ==========================================================================

  @Cron('0 3 * * 1', { name: 'regulatory-weekly-rollover', timeZone: 'Europe/Oslo' })
  async weeklyRollover(now: Date = new Date()): Promise<void> {
    await this.runJob('regulatory-weekly-rollover', async (tenantId) => {
      const created = await this.rolloverForTenant(
        tenantId,
        ReportSchedulerService.weeklyJobs(now),
      );
      await this.autoSubmitForTenant(tenantId);
      return created;
    });
  }

  @Cron('0 3 1 * *', { name: 'regulatory-monthly-rollover', timeZone: 'Europe/Oslo' })
  async monthlyRollover(now: Date = new Date()): Promise<void> {
    await this.runJob('regulatory-monthly-rollover', async (tenantId) => {
      const created = await this.rolloverForTenant(
        tenantId,
        ReportSchedulerService.monthlyJobs(now),
      );
      await this.autoSubmitForTenant(tenantId);
      return created;
    });
  }

  @Cron('0 7 * * *', { name: 'regulatory-deadline-sweep', timeZone: 'Europe/Oslo' })
  async deadlineSweep(now: Date = new Date()): Promise<void> {
    await this.runJob('regulatory-deadline-sweep', (tenantId) =>
      this.notifyDeadlinesForTenant(tenantId, now),
    );
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

  /**
   * Monthly jobs: previous calendar month (smolt + cleaner fish). BIOMASS is NOT
   * a Mattilsynet REST report — it is the Fiskeridirektoratet FD-0001 / Altinn
   * manual channel with its own `biomass_reports` table and READY → Altinn-confirm
   * state machine. It must not flow through this REST draft pipeline: a BIOMASS
   * draft here surfaced in "Scheduled reports due" with a Mattilsynet "Approve &
   * Submit" that always errors, and duplicated the biomass_reports lifecycle
   * (FARM-HIGH-004 — no duplicate structures).
   */
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

  /**
   * Raise one outbox RegulatoryReportDeadlineApproachingEvent per non-terminal
   * draft whose deadline bucket has CHANGED since the last reminder (APPROACHING
   * → DUE_SOON → DUE → OVERDUE). The event enqueue and the draft's
   * deadlineNotifiedBucket update commit in ONE transaction, so a reminder fires
   * exactly once per transition (no reliance on catching the outbox unique-key
   * violation). Returns the number of reminders raised this run.
   */
  async notifyDeadlinesForTenant(tenantId: string, now: Date): Promise<number> {
    // Only non-terminal drafts that carry a dueAt can breach a deadline; the
    // predicate is applied in SQL (PERF-HIGH-003) so the daily sweep never loads
    // the tenant's full terminal-draft history.
    const drafts = await this.draftService.listDeadlineCandidates(tenantId);
    let notified = 0;
    for (const draft of drafts) {
      if (!draft.dueAt) continue;
      const bucket = deadlineBucket(draft.dueAt, now);
      if (!bucket || bucket === draft.deadlineNotifiedBucket) continue;

      const dueAt = draft.dueAt;
      await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
        await queryRunner.manager.update(
          RegulatoryReportDraft,
          { id: draft.id, tenantId },
          { deadlineNotifiedBucket: bucket },
        );
        const event: RegulatoryReportDeadlineApproachingEvent = {
          ...createBaseEvent<RegulatoryReportDeadlineApproachingEvent>(
            'RegulatoryReportDeadlineApproaching',
            tenantId,
            { aggregateId: draft.id, aggregateType: 'RegulatoryReportDraft' },
          ),
          draftId: draft.id,
          reportType: draft.reportType,
          siteId: draft.siteId,
          reportYear: draft.periodYear,
          reportWeek: draft.periodWeek,
          reportMonth: draft.periodMonth,
          dueAt,
          bucket,
          daysUntilDue: osloDaysUntil(dueAt, now),
        };
        await this.outboxPublisher.enqueue(event, queryRunner.manager, {
          idempotencyKey: `deadline:${draft.id}:${bucket}`,
          aggregateId: draft.id,
        });
      });
      notified += 1;
    }
    if (notified > 0) {
      this.logger.log(`Tenant ${tenantId.slice(0, 8)}…: raised ${notified} deadline reminder(s)`);
    }
    return notified;
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

  /**
   * Auto-submit every READY draft whose report type the tenant has opted into
   * (autoSubmitPolicies[type] === true). Each submission goes through the SAME
   * approveAndSubmit path as an operator, so persistence, classification, and
   * retry scheduling are identical; a per-draft failure never aborts the batch.
   * Runs inside the per-tenant withTenantContext frame established by runJob.
   */
  async autoSubmitForTenant(tenantId: string): Promise<number> {
    const settings = await this.settingsService.getSettings(tenantId);
    const policies = settings?.autoSubmitPolicies ?? {};
    const enabledTypes = Object.entries(policies)
      .filter(([, enabled]) => enabled)
      .map(([type]) => type);
    if (enabledTypes.length === 0) return 0;

    const ready = await this.draftService.listDrafts(tenantId, {
      status: ReportDraftStatus.READY,
    });
    const due = ready.filter((draft) => enabledTypes.includes(draft.reportType));

    let submitted = 0;
    for (const draft of due) {
      try {
        const result = await this.draftSubmissionService.approveAndSubmit(
          tenantId,
          AUTO_SUBMIT_ACTOR_ID,
          draft.id,
        );
        if (result.success) submitted += 1;
      } catch (error) {
        this.logger.error(
          `Auto-submit failed for draft ${draft.id.slice(0, 8)}…: ${(error as Error).message}`,
          (error as Error).stack,
        );
      }
    }
    if (due.length > 0) {
      this.logger.log(
        `Tenant ${tenantId.slice(0, 8)}…: auto-submitted ${submitted}/${due.length} READY draft(s)`,
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
    // pg_try_advisory_lock is SESSION-scoped: it stays held on the exact backend
    // connection that acquired it, and pg_advisory_unlock only releases it when
    // run on that SAME connection. DataSource.query() borrows an arbitrary pooled
    // connection per call, so acquiring and releasing through the pool would leak
    // the lock onto one connection forever (unlock lands on a different one, no-ops)
    // and every later run of every cron would then self-skip. Hold ONE dedicated
    // QueryRunner for the lock's whole lifetime so acquire + release are provably
    // the same session.
    const lockRunner = this.dataSource.createQueryRunner();
    await lockRunner.connect();
    try {
      if (!(await this.tryAcquireAdvisoryLock(lockRunner, jobName))) {
        this.logger.log(`${jobName}: another instance holds the lock, skipping`);
        // OBS-HIGH-002: a lock-skip is a legitimate run (another replica owns
        // the job) — still a heartbeat, so the "cron stalled" alert never fires
        // on the passive replicas.
        this.metrics.recordRegulatoryCronRun({ job: jobName, outcome: 'skipped_locked' });
        return;
      }
      const startedAt = Date.now();
      let tenants = 0;
      let total = 0;
      try {
        const tenantIds = await this.discoverTenantIds();
        for (const tenantId of tenantIds) {
          try {
            // Establish the tenant AsyncLocalStorage frame so every scoped-repo
            // read inside perTenant (settings, drafts) resolves search_path to
            // tenant_<uuid>; without it the connection bootstrap falls back to the
            // source `farm` schema and the job silently reads an empty template.
            total += await withTenantContext(tenantId, () => perTenant(tenantId));
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
        // OBS-HIGH-002: the job completed and stamped its heartbeat. Per-tenant
        // failures are absorbed above (one tenant must not fail the whole run);
        // an outcome=error below means the run itself broke (e.g. tenant
        // discovery), which the operator alert distinguishes from a quiet run.
        this.metrics.recordRegulatoryCronRun({ job: jobName, outcome: 'success' });
      } catch (error) {
        this.metrics.recordRegulatoryCronRun({ job: jobName, outcome: 'error' });
        this.logger.error(
          `${jobName}: run aborted — ${(error as Error).message}`,
          (error as Error).stack,
        );
        throw error;
      } finally {
        await this.releaseAdvisoryLock(lockRunner, jobName);
      }
    } finally {
      await lockRunner.release();
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
        // A schema is exactly one tenant, so any row's tenantId identifies it.
        // Anchor discovery on regulatory_settings (the SSoT for "this tenant
        // does regulatory reporting", populated at setup) UNION sites, so a
        // tenant that has configured reporting but has no sites row yet — or
        // vice-versa after a site was removed — is still discovered. Keying only
        // on `sites` silently skipped such tenants (their deadlines/retries never
        // ran).
        const rows: Array<{ tenantId: string }> = await runner.query(
          `SELECT "tenantId" FROM regulatory_settings WHERE "tenantId" IS NOT NULL
             UNION
           SELECT "tenantId" FROM sites WHERE "tenantId" IS NOT NULL
           LIMIT 1`,
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

  private async tryAcquireAdvisoryLock(runner: QueryRunner, jobName: string): Promise<boolean> {
    const result = await runner.query(`SELECT pg_try_advisory_lock($1, $2) AS acquired`, [
      ADVISORY_LOCK_NAMESPACE,
      this.getAdvisoryLockKey(jobName),
    ]);
    return result[0]?.acquired === true;
  }

  private async releaseAdvisoryLock(runner: QueryRunner, jobName: string): Promise<void> {
    await runner.query(`SELECT pg_advisory_unlock($1, $2)`, [
      ADVISORY_LOCK_NAMESPACE,
      this.getAdvisoryLockKey(jobName),
    ]);
  }
}
