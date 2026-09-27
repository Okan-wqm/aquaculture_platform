import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type HarvestPlanStatsReply,
  type HarvestPlanStatsRequest,
  isHarvestPlanStatsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';

type Input = Record<string, never>;

@Injectable()
@Tool({
  name: 'get_harvest_plan_stats',
  description:
    "Counts of the tenant's harvest plans by status (draft, planned, approved, scheduled, in progress, completed, cancelled, postponed), total estimated and actual biomass kg, upcoming and overdue counts.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  requiresConfirmation: false,
})
export class GetHarvestPlanStatsTool extends FarmAiQueryTool<
  Input,
  Omit<HarvestPlanStatsRequest, 'tenantId'>,
  HarvestPlanStatsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS;
  protected readonly isData = isHarvestPlanStatsReply;

  protected toRequestFields(_input: Input): Omit<HarvestPlanStatsRequest, 'tenantId'> {
    return {};
  }
}
