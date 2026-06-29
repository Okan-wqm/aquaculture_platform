/**
 * List Upcoming Harvest Plans Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { Between, DataSource, In } from 'typeorm';

import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { ListUpcomingHarvestPlansQuery } from '../queries/list-upcoming-harvest-plans.query';

@QueryHandler(ListUpcomingHarvestPlansQuery)
export class ListUpcomingHarvestPlansHandler
  implements IQueryHandler<ListUpcomingHarvestPlansQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListUpcomingHarvestPlansQuery): Promise<HarvestPlan[]> {
    const { tenantId, days } = query;
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(HarvestPlan, {
        where: {
          tenantId,
          status: In([
            HarvestPlanStatus.PLANNED,
            HarvestPlanStatus.APPROVED,
            HarvestPlanStatus.SCHEDULED,
          ]),
          plannedDate: Between(today, futureDate),
        },
        order: { plannedDate: 'ASC' },
      }),
    );
  }
}
