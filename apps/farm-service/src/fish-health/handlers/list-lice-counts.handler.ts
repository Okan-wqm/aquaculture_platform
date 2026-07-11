/**
 * List Lice Counts Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { LiceCount } from '../entities/lice-count.entity';
import { ListLiceCountsQuery } from '../queries/list-lice-counts.query';

@QueryHandler(ListLiceCountsQuery)
export class ListLiceCountsHandler implements IQueryHandler<ListLiceCountsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListLiceCountsQuery): Promise<LiceCount[]> {
    const { tenantId, siteId, tankId, reportingYear, reportingWeek } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
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
    });
  }
}
