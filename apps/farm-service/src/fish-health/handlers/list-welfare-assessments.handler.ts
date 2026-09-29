/**
 * List Welfare Assessments Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { WelfareAssessment } from '../entities/welfare-assessment.entity';
import { ListWelfareAssessmentsQuery } from '../queries/list-welfare-assessments.query';

@QueryHandler(ListWelfareAssessmentsQuery)
export class ListWelfareAssessmentsHandler implements IQueryHandler<ListWelfareAssessmentsQuery> {
  async execute(query: ListWelfareAssessmentsQuery): Promise<WelfareAssessment[]> {
    const { scope, siteId, tankId, fromDate, toDate } = query;
    const tenantId = scope.tenantId;

    const qb = scope.manager
      .createQueryBuilder(WelfareAssessment, 'wa')
      .where('wa.tenantId = :tenantId', { tenantId });

    if (siteId) qb.andWhere('wa.siteId = :siteId', { siteId });
    if (tankId) qb.andWhere('wa.tankId = :tankId', { tankId });
    if (fromDate) qb.andWhere('wa.assessedAt >= :fromDate', { fromDate });
    if (toDate) qb.andWhere('wa.assessedAt <= :toDate', { toDate });

    return qb.orderBy('wa.assessedAt', 'DESC').take(500).getMany();
  }
}
