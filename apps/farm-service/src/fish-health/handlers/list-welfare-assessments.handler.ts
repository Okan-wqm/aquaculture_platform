/**
 * List Welfare Assessments Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WelfareAssessment } from '../entities/welfare-assessment.entity';
import { ListWelfareAssessmentsQuery } from '../queries/list-welfare-assessments.query';

@QueryHandler(ListWelfareAssessmentsQuery)
export class ListWelfareAssessmentsHandler implements IQueryHandler<ListWelfareAssessmentsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListWelfareAssessmentsQuery): Promise<WelfareAssessment[]> {
    const { tenantId, siteId, tankId, fromDate, toDate } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(WelfareAssessment, 'wa')
        .where('wa.tenantId = :tenantId', { tenantId });

      if (siteId) qb.andWhere('wa.siteId = :siteId', { siteId });
      if (tankId) qb.andWhere('wa.tankId = :tankId', { tankId });
      if (fromDate) qb.andWhere('wa.assessedAt >= :fromDate', { fromDate });
      if (toDate) qb.andWhere('wa.assessedAt <= :toDate', { toDate });

      return qb.orderBy('wa.assessedAt', 'DESC').take(500).getMany();
    });
  }
}
