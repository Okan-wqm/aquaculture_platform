/**
 * RegulatoryReportStoreService
 *
 * Owns the persistence lifecycle of `regulatory_reports` (FARM-HIGH-125) —
 * the record-of-submission for every Mattilsynet report type that is not
 * biomass (which keeps its own draft-capable table).
 *
 * Two write shapes:
 *
 *   1. REST reports (sea lice, cleaner fish, smolt, planned/executed
 *      slaughter) — persist-FIRST: `recordPending` upserts the row in its
 *      own tenant-pinned transaction BEFORE the synchronous Mattilsynet
 *      call; `markSubmitted` / `recordFailure` update it afterwards. A crash
 *      between persist and submit leaves an honest PENDING row, and a
 *      retry with the same klientReferanse updates that row instead of
 *      duplicating (the unique key mirrors Mattilsynet's own idempotency
 *      contract).
 *
 *   2. Varsling reports (welfare / escape / disease) — `recordQueued`
 *      writes through the CALLER's EntityManager so the report row commits
 *      atomically with the outbox event that carries the urgent
 *      notification e-mail. The row exists iff the event is queued.
 *
 * All standalone writes go through runInTenantTransaction so search_path
 * is pinned to the tenant schema — a bare repository write from a fresh
 * query runner would land in the farm source schema and trip the
 * SourceSchemaWriteGuard.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import {
  RegulatoryFailureClass,
  RegulatoryReport,
  RegulatoryReportPayload,
  RegulatoryReportSubmissionStatus,
  RegulatoryReportType,
} from '../entities/regulatory-report.entity';

export interface RecordReportParams {
  reportType: RegulatoryReportType;
  klientReferanse: string;
  siteId?: string;
  lokalitetsnummer: number;
  reportYear?: number;
  reportWeek?: number;
  reportMonth?: number;
  payload: RegulatoryReportPayload;
  submittedBy: string;
}

@Injectable()
export class RegulatoryReportStoreService {
  private readonly logger = new Logger(RegulatoryReportStoreService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * COMPLIANCE-HIGH-001 — write the actor-attributed audit row for a
   * regulatory_reports state transition INSIDE the caller's transaction so
   * it commits atomically with the row change. The submitting operator
   * (`row.submittedBy`) is the actor; the wide `payload` is deliberately NOT
   * dumped into `changes` (it can carry PII and is already persisted on the
   * row). `farm_audit_logs` is cross-tenant farm-schema infrastructure, so
   * the write lands in the `farm` schema regardless of the pinned tenant
   * search_path.
   */
  private async auditTransition(
    manager: EntityManager,
    tenantId: string,
    row: RegulatoryReport,
    action: AuditAction,
    summary: string,
  ): Promise<void> {
    await this.auditLog.logWithManager(manager, {
      tenantId,
      entityType: 'RegulatoryReport',
      entityId: row.id,
      action,
      userId: row.submittedBy,
      changes: {
        after: {
          reportType: row.reportType,
          klientReferanse: row.klientReferanse,
          lokalitetsnummer: row.lokalitetsnummer,
          status: row.status,
          referanse: row.referanse ?? null,
          attemptCount: row.attemptCount,
        },
      },
      metadata: { source: 'regulatory-reporting' },
      summary,
    });
  }

  /**
   * Persist-first record for a REST report. Upserts on
   * (tenantId, reportType, klientReferanse) and resets the row to PENDING —
   * a retry of a previously FAILED submission legitimately re-enters the
   * pending state with the fresh payload.
   */
  async recordPending(tenantId: string, params: RecordReportParams): Promise<RegulatoryReport> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      this.upsert(queryRunner.manager, tenantId, params, RegulatoryReportSubmissionStatus.PENDING),
    );
  }

  /**
   * Varsling record — writes through the caller's EntityManager so the row
   * commits atomically with the outbox enqueue in the same transaction.
   */
  async recordQueued(
    manager: EntityManager,
    tenantId: string,
    params: RecordReportParams,
    referanse: string,
  ): Promise<RegulatoryReport> {
    const row = await this.upsert(
      manager,
      tenantId,
      params,
      RegulatoryReportSubmissionStatus.QUEUED,
    );
    row.referanse = referanse;
    row.submittedAt = new Date();
    const saved = await manager.save(RegulatoryReport, row);
    await this.auditTransition(
      manager,
      tenantId,
      saved,
      AuditAction.REGULATORY_SUBMITTED,
      `Varsling ${saved.reportType} queued for lokalitet ${saved.lokalitetsnummer} ` +
        `(klientReferanse ${saved.klientReferanse})`,
    );
    return saved;
  }

  async markSubmitted(tenantId: string, id: string, referanse?: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const row = await queryRunner.manager.findOneOrFail(RegulatoryReport, {
        where: { id, tenantId },
      });
      row.status = RegulatoryReportSubmissionStatus.SUBMITTED;
      row.referanse = referanse;
      row.feilmelding = null;
      row.submittedAt = new Date();
      // A success closes the retry pipeline for this row.
      row.nextAttemptAt = null;
      row.failureClass = null;
      const saved = await queryRunner.manager.save(RegulatoryReport, row);
      await this.auditTransition(
        queryRunner.manager,
        tenantId,
        saved,
        AuditAction.REGULATORY_SUBMITTED,
        `${saved.reportType} accepted by Mattilsynet (referanse ${referanse ?? 'n/a'}` +
          `${saved.attemptCount > 1 ? `, after ${saved.attemptCount} attempts` : ''})`,
      );
    });
    this.logger.log(`Regulatory report ${id} marked SUBMITTED (referanse=${referanse ?? 'n/a'})`);
  }

  /**
   * Record a failed attempt with its retry classification. Increments
   * attemptCount, sets failureClass, and schedules (TRANSIENT) or clears
   * (PERMANENT) the next replay. A failed submission carries no receipt.
   */
  async recordFailure(
    tenantId: string,
    id: string,
    feilmelding: string,
    failureClass: RegulatoryFailureClass,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      this.applyFailure(
        queryRunner.manager,
        tenantId,
        id,
        feilmelding,
        failureClass,
        nextAttemptAt,
      ),
    );
  }

  /**
   * Manager-based failure write so a PERMANENT failure can commit atomically
   * with its outbox notification event in the caller's transaction (mirrors
   * recordQueued). recordFailure wraps this in its own transaction for the
   * TRANSIENT path, so the row-update logic lives in exactly one place.
   */
  async applyFailure(
    manager: EntityManager,
    tenantId: string,
    id: string,
    feilmelding: string,
    failureClass: RegulatoryFailureClass,
    nextAttemptAt: Date | null,
  ): Promise<RegulatoryReport> {
    const row = await manager.findOneOrFail(RegulatoryReport, { where: { id, tenantId } });
    row.status = RegulatoryReportSubmissionStatus.FAILED;
    row.feilmelding = feilmelding;
    // FARM-LOW-133: a failed submission has no valid receipt.
    row.referanse = null;
    row.attemptCount = (row.attemptCount ?? 0) + 1;
    row.failureClass = failureClass;
    row.nextAttemptAt = nextAttemptAt;
    const saved = await manager.save(RegulatoryReport, row);
    await this.auditTransition(
      manager,
      tenantId,
      saved,
      AuditAction.REGULATORY_FAILED,
      `${saved.reportType} submission FAILED (${failureClass}, attempt ${saved.attemptCount}` +
        `${nextAttemptAt ? `, retry at ${nextAttemptAt.toISOString()}` : ''})`,
    );
    this.logger.warn(
      `Regulatory report ${id} marked FAILED (${failureClass}` +
        `${nextAttemptAt ? `, retry at ${nextAttemptAt.toISOString()}` : ''})`,
    );
    return saved;
  }

  async findById(tenantId: string, id: string): Promise<RegulatoryReport | null> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(RegulatoryReport, { where: { id, tenantId } }),
    );
  }

  /**
   * The submission row for a (reportType, klientReferanse) pair — the SSoT for
   * whether a draft has already been filed. Used to reconcile a draft against its
   * out-of-band submission state (e.g. the retry sweep accepted a report after a
   * transient failure) so a re-approval never re-files an accepted report.
   */
  async findByKlientReferanse(
    tenantId: string,
    reportType: RegulatoryReportType,
    klientReferanse: string,
  ): Promise<RegulatoryReport | null> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(RegulatoryReport, {
        where: { tenantId, reportType, klientReferanse },
      }),
    );
  }

  /**
   * FAILED + TRANSIENT rows whose scheduled retry is due — the 30-minute sweep's
   * work list. Ordered oldest-due first; bounded so one tenant cannot starve
   * the sweep.
   */
  async listDueRetries(tenantId: string, now: Date, limit: number): Promise<RegulatoryReport[]> {
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(RegulatoryReport, 'r')
        .where('r.tenantId = :tenantId', { tenantId })
        .andWhere('r.status = :status', { status: RegulatoryReportSubmissionStatus.FAILED })
        .andWhere('r.failureClass = :cls', { cls: RegulatoryFailureClass.TRANSIENT })
        .andWhere('r.nextAttemptAt IS NOT NULL')
        .andWhere('r.nextAttemptAt <= :now', { now })
        .orderBy('r.nextAttemptAt', 'ASC')
        .take(limit)
        .getMany(),
    );
  }

  private async upsert(
    manager: EntityManager,
    tenantId: string,
    params: RecordReportParams,
    status: RegulatoryReportSubmissionStatus,
  ): Promise<RegulatoryReport> {
    const existing = await manager.findOne(RegulatoryReport, {
      where: {
        tenantId,
        reportType: params.reportType,
        klientReferanse: params.klientReferanse,
      },
    });

    if (existing) {
      // Immutability (COMPLIANCE-HIGH-002): an accepted terminal filing must never
      // be reset to PENDING or lose its Mattilsynet receipt. A re-entry for an
      // already-accepted klientReferanse is an idempotent no-op — return the row
      // as-is. A genuine correction files under a NEW klientReferanse. Only a
      // FAILED/PENDING row may legitimately re-enter PENDING (the retry pipeline).
      if (
        existing.status === RegulatoryReportSubmissionStatus.SUBMITTED ||
        existing.status === RegulatoryReportSubmissionStatus.QUEUED
      ) {
        this.logger.warn(
          `Regulatory report ${existing.id} is already ${existing.status}; refusing to reset it ` +
            'to PENDING (accepted filings are immutable).',
        );
        return existing;
      }
      existing.siteId = params.siteId ?? existing.siteId;
      existing.lokalitetsnummer = params.lokalitetsnummer;
      existing.reportYear = params.reportYear;
      existing.reportWeek = params.reportWeek;
      existing.reportMonth = params.reportMonth;
      existing.payload = params.payload;
      existing.submittedBy = params.submittedBy;
      existing.status = status;
      existing.feilmelding = null;
      // FARM-LOW-133: a row re-entering PENDING/QUEUED carries no receipt yet —
      // drop any stale Mattilsynet referanse from a prior SUBMITTED attempt.
      existing.referanse = null;
      return manager.save(RegulatoryReport, existing);
    }

    const fresh = manager.create(RegulatoryReport, {
      tenantId,
      reportType: params.reportType,
      klientReferanse: params.klientReferanse,
      siteId: params.siteId,
      lokalitetsnummer: params.lokalitetsnummer,
      reportYear: params.reportYear,
      reportWeek: params.reportWeek,
      reportMonth: params.reportMonth,
      payload: params.payload,
      submittedBy: params.submittedBy,
      status,
    });
    return manager.save(RegulatoryReport, fresh);
  }
}
