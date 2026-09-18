import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { HarvestPlanStatsReply, isHarvestPlanStats } from './reply-guards';

/** No input — the tenant is taken from the (server-populated) context. */
type Input = Record<string, never>;

/** Harvest plan counters. */
@Injectable()
@Tool({
  name: 'get_harvest_plan_stats',
  description:
    'Harvest plan statistics for the tenant: counts by status (draft/planned/' +
    'approved/scheduled/in-progress/completed/cancelled/postponed), estimated vs ' +
    'actual biomass totals, and upcoming (next 30 days) vs overdue counts.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetHarvestPlanStatsTool extends FarmAiQueryTool<
  Input,
  Record<string, never>,
  HarvestPlanStatsReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.HARVEST_PLAN_STATS);
  }

  protected isData(value: unknown): value is HarvestPlanStatsReply {
    return isHarvestPlanStats(value);
  }

  protected toRequestFields(): Record<string, never> {
    return {};
  }
}
