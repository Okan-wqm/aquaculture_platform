import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isHarvestPlanStatsRequest,
  isHarvestPlansRequest,
  toEventIso,
  type AiQueryReply,
  type HarvestPlanDto,
  type HarvestPlanStatsReply,
  type HarvestPlansReply,
} from '@platform/event-contracts';
import {
  isoOrNull,
  numberOrNull,
  respondAiQuery,
  toBoundedList,
} from '../../common/nats/ai-query-responder';
import type { HarvestPlan } from '../entities/harvest-plan.entity';
import { GetHarvestPlanStatsQuery } from '../queries/get-harvest-plan-stats.query';
import { ListOverdueHarvestPlansQuery } from '../queries/list-overdue-harvest-plans.query';
import { ListUpcomingHarvestPlansQuery } from '../queries/list-upcoming-harvest-plans.query';
import type { HarvestPlanStats } from '../services/harvest-plan.service';

/** No customer, address, contract price, approver or note ever crosses. */
export function projectPlan(row: HarvestPlan): HarvestPlanDto {
  return {
    id: row.id,
    planCode: row.planCode,
    name: row.name,
    batchId: row.batchId,
    status: row.status,
    harvestType: row.harvestType,
    plannedDate: toEventIso(row.plannedDate),
    windowStartDate: isoOrNull(row.windowStartDate),
    windowEndDate: isoOrNull(row.windowEndDate),
    estimatedQuantity: numberOrNull(row.estimates?.estimatedQuantity),
    estimatedBiomassKg: numberOrNull(row.estimates?.estimatedBiomass),
    estimatedAvgWeightG: numberOrNull(row.estimates?.estimatedAvgWeight),
    actualBiomassKg: numberOrNull(row.actualBiomassHarvested),
  };
}

export function projectStats(stats: HarvestPlanStats): HarvestPlanStatsReply {
  return {
    total: stats.total,
    draft: stats.draft,
    planned: stats.planned,
    approved: stats.approved,
    scheduled: stats.scheduled,
    inProgress: stats.inProgress,
    completed: stats.completed,
    cancelled: stats.cancelled,
    postponed: stats.postponed,
    totalEstimatedBiomassKg: Number(stats.totalEstimatedBiomass),
    totalActualBiomassKg: Number(stats.totalActualBiomass),
    upcomingCount: stats.upcomingCount,
    overdueCount: stats.overdueCount,
  };
}

/** Harvest planning read surface for the farm production specialist (FARM-MEDIUM-328). */
@Controller()
export class HarvestAiQueryResponder {
  private readonly logger = new Logger(HarvestAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.HARVEST_PLANS)
  listPlans(@Payload() payload: unknown): Promise<AiQueryReply<HarvestPlansReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.HARVEST_PLANS,
      payload,
      isHarvestPlansRequest,
      async (req) => {
        const rows =
          req.scope === 'upcoming'
            ? await this.queryBus.execute<ListUpcomingHarvestPlansQuery, HarvestPlan[]>(
                new ListUpcomingHarvestPlansQuery(req.tenantId, req.days),
              )
            : await this.queryBus.execute<ListOverdueHarvestPlansQuery, HarvestPlan[]>(
                new ListOverdueHarvestPlansQuery(req.tenantId),
              );
        return toBoundedList(rows, req.limit, projectPlan);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS)
  getStats(@Payload() payload: unknown): Promise<AiQueryReply<HarvestPlanStatsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS,
      payload,
      isHarvestPlanStatsRequest,
      async (req) => {
        const stats = await this.queryBus.execute<GetHarvestPlanStatsQuery, HarvestPlanStats>(
          new GetHarvestPlanStatsQuery(req.tenantId),
        );
        return projectStats(stats);
      },
    );
  }
}
