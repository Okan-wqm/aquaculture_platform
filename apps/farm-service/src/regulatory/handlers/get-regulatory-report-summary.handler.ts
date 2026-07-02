/**
 * Regulatory report summary Query Handler — fail-closed tenant boundary.
 *
 * One grouped aggregate per report type: status counts + the most recent
 * submission timestamp. Feeds the Reports page header stats and tab badges
 * that previously rendered mock numbers (FARM-HIGH-112).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  RegulatoryReport,
  RegulatoryReportType,
} from '../entities/regulatory-report.entity';
import { GetRegulatoryReportSummaryQuery } from '../queries/get-regulatory-report-summary.query';
import { RegulatoryReportTypeSummary } from '../dto/regulatory-report-summary.dto';

interface SummaryRow {
  reportType: RegulatoryReportType;
  pendingCount: string;
  submittedCount: string;
  queuedCount: string;
  failedCount: string;
  lastSubmittedAt: Date | null;
}

@QueryHandler(GetRegulatoryReportSummaryQuery)
export class GetRegulatoryReportSummaryHandler
  implements IQueryHandler<GetRegulatoryReportSummaryQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetRegulatoryReportSummaryQuery): Promise<RegulatoryReportTypeSummary[]> {
    const { tenantId, siteId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(RegulatoryReport, 'r')
        .select('r.reportType', 'reportType')
        .addSelect(`COUNT(*) FILTER (WHERE r.status = 'PENDING')`, 'pendingCount')
        .addSelect(`COUNT(*) FILTER (WHERE r.status = 'SUBMITTED')`, 'submittedCount')
        .addSelect(`COUNT(*) FILTER (WHERE r.status = 'QUEUED')`, 'queuedCount')
        .addSelect(`COUNT(*) FILTER (WHERE r.status = 'FAILED')`, 'failedCount')
        .addSelect('MAX(r.submittedAt)', 'lastSubmittedAt')
        .where('r.tenantId = :tenantId', { tenantId })
        .groupBy('r.reportType');
      if (siteId) {
        qb.andWhere('r.siteId = :siteId', { siteId });
      }
      const rows = await qb.getRawMany<SummaryRow>();
      return rows.map((row) => ({
        reportType: row.reportType,
        pendingCount: Number(row.pendingCount),
        submittedCount: Number(row.submittedCount),
        queuedCount: Number(row.queuedCount),
        failedCount: Number(row.failedCount),
        lastSubmittedAt: row.lastSubmittedAt ?? undefined,
      }));
    });
  }
}
