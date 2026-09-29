/**
 * List Overdue Harvest Plans Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { In, LessThan } from 'typeorm';

import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { ListOverdueHarvestPlansQuery } from '../queries/list-overdue-harvest-plans.query';

@QueryHandler(ListOverdueHarvestPlansQuery)
export class ListOverdueHarvestPlansHandler
  implements IQueryHandler<ListOverdueHarvestPlansQuery>
{
  async execute(query: ListOverdueHarvestPlansQuery): Promise<HarvestPlan[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    const today = new Date();

    return scope.manager.find(HarvestPlan, {
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
    });
  }
}
