/**
 * List Treatment Applications Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { TreatmentApplication } from '../entities/treatment-application.entity';
import { ListTreatmentApplicationsQuery } from '../queries/list-treatment-applications.query';

@QueryHandler(ListTreatmentApplicationsQuery)
export class ListTreatmentApplicationsHandler
  implements IQueryHandler<ListTreatmentApplicationsQuery>
{
  async execute(query: ListTreatmentApplicationsQuery): Promise<TreatmentApplication[]> {
    const { scope, siteId, fromDate, toDate } = query;
    const tenantId = scope.tenantId;

    const qb = scope.manager
      .createQueryBuilder(TreatmentApplication, 'ta')
      .where('ta.tenantId = :tenantId', { tenantId });

    if (siteId) qb.andWhere('ta.siteId = :siteId', { siteId });
    if (fromDate) qb.andWhere('ta.appliedAt::date >= :fromDate', { fromDate });
    if (toDate) qb.andWhere('ta.appliedAt::date <= :toDate', { toDate });

    return qb.orderBy('ta.appliedAt', 'DESC').take(500).getMany();
  }
}
