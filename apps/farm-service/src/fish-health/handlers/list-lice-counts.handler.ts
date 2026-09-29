/**
 * List Lice Counts Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { LiceCount } from '../entities/lice-count.entity';
import { ListLiceCountsQuery } from '../queries/list-lice-counts.query';

@QueryHandler(ListLiceCountsQuery)
export class ListLiceCountsHandler implements IQueryHandler<ListLiceCountsQuery> {
  async execute(query: ListLiceCountsQuery): Promise<LiceCount[]> {
    const { scope, siteId, tankId, reportingYear, reportingWeek } = query;
    const tenantId = scope.tenantId;

    const qb = scope.manager
      .createQueryBuilder(LiceCount, 'lc')
      .where('lc.tenantId = :tenantId', { tenantId });

    if (siteId) qb.andWhere('lc.siteId = :siteId', { siteId });
    if (tankId) qb.andWhere('lc.tankId = :tankId', { tankId });
    if (reportingYear !== undefined) {
      qb.andWhere('lc.reportingYear = :reportingYear', { reportingYear });
    }
    if (reportingWeek !== undefined) {
      qb.andWhere('lc.reportingWeek = :reportingWeek', { reportingWeek });
    }

    return qb.orderBy('lc.countDate', 'DESC').addOrderBy('lc.tankId', 'ASC').take(500).getMany();
  }
}
