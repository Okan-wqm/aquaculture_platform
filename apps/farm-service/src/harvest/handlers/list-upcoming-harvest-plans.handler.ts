/**
 * List Upcoming Harvest Plans Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { Between, In } from 'typeorm';

import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { ListUpcomingHarvestPlansQuery } from '../queries/list-upcoming-harvest-plans.query';

@QueryHandler(ListUpcomingHarvestPlansQuery)
export class ListUpcomingHarvestPlansHandler
  implements IQueryHandler<ListUpcomingHarvestPlansQuery>
{
  async execute(query: ListUpcomingHarvestPlansQuery): Promise<HarvestPlan[]> {
    const { scope, days } = query;
    const tenantId = scope.tenantId;
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return scope.manager.find(HarvestPlan, {
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
    });
  }
}
