/**
 * List Harvest Plans for a batch Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { ListHarvestPlansByBatchQuery } from '../queries/list-harvest-plans-by-batch.query';

@QueryHandler(ListHarvestPlansByBatchQuery)
export class ListHarvestPlansByBatchHandler
  implements IQueryHandler<ListHarvestPlansByBatchQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListHarvestPlansByBatchQuery): Promise<HarvestPlan[]> {
    const { tenantId, batchId, activeOnly } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(HarvestPlan, 'hp')
        .where('hp.tenantId = :tenantId', { tenantId })
        .andWhere('hp.batchId = :batchId', { batchId });

      if (activeOnly) {
        qb.andWhere('hp.status NOT IN (:...excludedStatuses)', {
          excludedStatuses: [HarvestPlanStatus.COMPLETED, HarvestPlanStatus.CANCELLED],
        });
      }

      return qb.orderBy('hp.plannedDate', 'ASC').getMany();
    });
  }
}
