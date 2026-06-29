/**
 * List Overdue Harvest Plans Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In, LessThan } from 'typeorm';

import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { ListOverdueHarvestPlansQuery } from '../queries/list-overdue-harvest-plans.query';

@QueryHandler(ListOverdueHarvestPlansQuery)
export class ListOverdueHarvestPlansHandler
  implements IQueryHandler<ListOverdueHarvestPlansQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListOverdueHarvestPlansQuery): Promise<HarvestPlan[]> {
    const { tenantId } = query;
    const today = new Date();

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(HarvestPlan, {
        where: {
          tenantId,
          status: In([
            HarvestPlanStatus.PLANNED,
            HarvestPlanStatus.APPROVED,
            HarvestPlanStatus.SCHEDULED,
          ]),
          plannedDate: LessThan(today),
        },
        order: { plannedDate: 'ASC' },
      }),
    );
  }
}
