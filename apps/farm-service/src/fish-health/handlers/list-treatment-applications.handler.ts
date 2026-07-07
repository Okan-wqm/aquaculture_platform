/**
 * List Treatment Applications Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { TreatmentApplication } from '../entities/treatment-application.entity';
import { ListTreatmentApplicationsQuery } from '../queries/list-treatment-applications.query';

@QueryHandler(ListTreatmentApplicationsQuery)
export class ListTreatmentApplicationsHandler
  implements IQueryHandler<ListTreatmentApplicationsQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListTreatmentApplicationsQuery): Promise<TreatmentApplication[]> {
    const { tenantId, siteId, fromDate, toDate } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(TreatmentApplication, 'ta')
        .where('ta.tenantId = :tenantId', { tenantId });

      if (siteId) qb.andWhere('ta.siteId = :siteId', { siteId });
      if (fromDate) qb.andWhere('ta.appliedAt::date >= :fromDate', { fromDate });
      if (toDate) qb.andWhere('ta.appliedAt::date <= :toDate', { toDate });

      return qb.orderBy('ta.appliedAt', 'DESC').take(500).getMany();
    });
  }
}
