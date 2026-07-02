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
 *      call; `markSubmitted` / `markFailed` update it afterwards. A crash
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

import {
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
  ) {}

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
    return manager.save(RegulatoryReport, row);
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
      await queryRunner.manager.save(RegulatoryReport, row);
    });
    this.logger.log(`Regulatory report ${id} marked SUBMITTED (referanse=${referanse ?? 'n/a'})`);
  }

  async markFailed(tenantId: string, id: string, feilmelding: string): Promise<void> {
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const row = await queryRunner.manager.findOneOrFail(RegulatoryReport, {
        where: { id, tenantId },
      });
      row.status = RegulatoryReportSubmissionStatus.FAILED;
      row.feilmelding = feilmelding;
      await queryRunner.manager.save(RegulatoryReport, row);
    });
    this.logger.warn(`Regulatory report ${id} marked FAILED`);
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
      existing.siteId = params.siteId ?? existing.siteId;
      existing.lokalitetsnummer = params.lokalitetsnummer;
      existing.reportYear = params.reportYear;
      existing.reportWeek = params.reportWeek;
      existing.reportMonth = params.reportMonth;
      existing.payload = params.payload;
      existing.submittedBy = params.submittedBy;
      existing.status = status;
      existing.feilmelding = null;
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
