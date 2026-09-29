/**
 * List regulatory report submissions Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { FindOptionsWhere } from 'typeorm';

import { RegulatoryReport } from '../entities/regulatory-report.entity';
import { ListRegulatoryReportsQuery } from '../queries/list-regulatory-reports.query';

@QueryHandler(ListRegulatoryReportsQuery)
export class ListRegulatoryReportsHandler implements IQueryHandler<ListRegulatoryReportsQuery> {
  async execute(query: ListRegulatoryReportsQuery): Promise<RegulatoryReport[]> {
    const { scope, reportType, siteId, limit, offset } = query;
    const tenantId = scope.tenantId;
    const where: FindOptionsWhere<RegulatoryReport> = { tenantId, reportType };
    if (siteId) {
      where.siteId = siteId;
    }
    return scope.manager.find(RegulatoryReport, {
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
      skip: Math.max(offset, 0),
    });
  }
}
