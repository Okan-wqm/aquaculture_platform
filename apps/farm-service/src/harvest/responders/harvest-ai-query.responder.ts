/**
 * Harvest farm-AI read-only NATS responder (PR-4, Production specialist).
 * Two `request.farm.ai.*` subjects backed EXCLUSIVELY by the harvest
 * module's existing tenant-scoped CQRS query handlers via QueryBus — no
 * direct DB access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isHarvestPlanStatsRequest,
  isHarvestPlansRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { HarvestPlan } from '../entities/harvest-plan.entity';
import { ListUpcomingHarvestPlansQuery } from '../queries/list-upcoming-harvest-plans.query';
import { ListOverdueHarvestPlansQuery } from '../queries/list-overdue-harvest-plans.query';
import { GetHarvestPlanStatsQuery } from '../queries/get-harvest-plan-stats.query';
import { HarvestPlanStats } from '../services/harvest-plan.service';
import {
  HarvestPlanDto,
  HarvestPlanStatsDto,
  projectHarvestPlan,
  projectHarvestPlanStats,
} from './projections';

@Controller()
export class HarvestAiQueryResponder {
  private readonly logger = new Logger(HarvestAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.HARVEST_PLANS)
  async plans(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<HarvestPlanDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isHarvestPlansRequest,
      async (req) =>
        toBoundedList(
          req.scope === 'upcoming'
            ? await this.queryBus.execute<ListUpcomingHarvestPlansQuery, HarvestPlan[]>(
                new ListUpcomingHarvestPlansQuery(req.tenantId, req.days),
              )
            : await this.queryBus.execute<ListOverdueHarvestPlansQuery, HarvestPlan[]>(
                new ListOverdueHarvestPlansQuery(req.tenantId),
              ),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectHarvestPlan,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS)
  async stats(@Payload() payload: unknown): Promise<AiQueryReply<HarvestPlanStatsDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isHarvestPlanStatsRequest,
      async (req) =>
        projectHarvestPlanStats(
          await this.queryBus.execute<GetHarvestPlanStatsQuery, HarvestPlanStats>(
            new GetHarvestPlanStatsQuery(req.tenantId),
          ),
        ),
    );
  }
}
