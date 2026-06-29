/**
 * Get Harvest Plan Statistics Query Handler — fail-closed tenant boundary.
 * Loads the tenant's plans on the asserted connection and aggregates in memory.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { HarvestPlanStats } from '../services/harvest-plan.service';
import { GetHarvestPlanStatsQuery } from '../queries/get-harvest-plan-stats.query';

@QueryHandler(GetHarvestPlanStatsQuery)
export class GetHarvestPlanStatsHandler implements IQueryHandler<GetHarvestPlanStatsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHarvestPlanStatsQuery): Promise<HarvestPlanStats> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const plans = await queryRunner.manager.find(HarvestPlan, { where: { tenantId } });

      const today = new Date();
      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

      const stats: HarvestPlanStats = {
        total: plans.length,
        draft: 0,
        planned: 0,
        approved: 0,
        scheduled: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
        postponed: 0,
        totalEstimatedBiomass: 0,
        totalActualBiomass: 0,
        upcomingCount: 0,
        overdueCount: 0,
      };

      for (const plan of plans) {
        switch (plan.status) {
          case HarvestPlanStatus.DRAFT:
            stats.draft++;
            break;
          case HarvestPlanStatus.PLANNED:
            stats.planned++;
            break;
          case HarvestPlanStatus.APPROVED:
            stats.approved++;
            break;
          case HarvestPlanStatus.SCHEDULED:
            stats.scheduled++;
            break;
          case HarvestPlanStatus.IN_PROGRESS:
            stats.inProgress++;
            break;
          case HarvestPlanStatus.COMPLETED:
            stats.completed++;
            break;
          case HarvestPlanStatus.CANCELLED:
            stats.cancelled++;
            break;
          case HarvestPlanStatus.POSTPONED:
            stats.postponed++;
            break;
        }

        if (plan.estimates?.estimatedBiomass) {
          stats.totalEstimatedBiomass += plan.estimates.estimatedBiomass;
        }
        if (plan.actualBiomassHarvested) {
          stats.totalActualBiomass += Number(plan.actualBiomassHarvested);
        }

        const plannedDate = new Date(plan.plannedDate);
        const isActive = ![HarvestPlanStatus.COMPLETED, HarvestPlanStatus.CANCELLED].includes(
          plan.status,
        );
        if (isActive) {
          if (plannedDate < today) {
            stats.overdueCount++;
          } else if (plannedDate <= thirtyDaysFromNow) {
            stats.upcomingCount++;
          }
        }
      }

      return stats;
    });
  }
}
