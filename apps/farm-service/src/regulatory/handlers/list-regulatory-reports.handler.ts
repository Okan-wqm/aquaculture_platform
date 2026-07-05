/**
 * List regulatory report submissions Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, FindOptionsWhere } from 'typeorm';

import { RegulatoryReport } from '../entities/regulatory-report.entity';
import { ListRegulatoryReportsQuery } from '../queries/list-regulatory-reports.query';

@QueryHandler(ListRegulatoryReportsQuery)
export class ListRegulatoryReportsHandler implements IQueryHandler<ListRegulatoryReportsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListRegulatoryReportsQuery): Promise<RegulatoryReport[]> {
    const { tenantId, reportType, siteId, limit, offset } = query;
    const where: FindOptionsWhere<RegulatoryReport> = { tenantId, reportType };
    if (siteId) {
      where.siteId = siteId;
    }
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(RegulatoryReport, {
        where,
        order: { createdAt: 'DESC' },
        take: Math.min(Math.max(limit, 1), 200),
        skip: Math.max(offset, 0),
      }),
    );
  }
}
