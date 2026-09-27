import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  isFishHealthStatsReply,
  type FishHealthStatsReply,
  type FishHealthStatsRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';

type Input = Record<string, never>;

@Injectable()
@Tool({
  name: 'get_fish_health_stats',
  description:
    "Counts of the tenant's health events: total, active, critical, under treatment, quarantined, resolved, plus breakdowns by event type and severity. Tenant data; a quick health overview before drilling down.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  requiresConfirmation: false,
})
export class GetFishHealthStatsTool extends FarmAiQueryTool<
  Input,
  Omit<FishHealthStatsRequest, 'tenantId'>,
  FishHealthStatsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_STATS;
  protected readonly isData = isFishHealthStatsReply;

  protected toRequestFields(_input: Input): Omit<FishHealthStatsRequest, 'tenantId'> {
    return {};
  }
}
