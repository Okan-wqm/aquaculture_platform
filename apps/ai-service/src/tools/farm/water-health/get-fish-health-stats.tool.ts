import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { FishHealthStatsReply, isFishHealthStats } from './reply-guards';

/** No input — the tenant is taken from the (server-populated) context. */
type Input = Record<string, never>;

/** Tenant-wide health-event counters (the fish-health situation at a glance). */
@Injectable()
@Tool({
  name: 'get_fish_health_stats',
  description:
    'Health-event statistics for the tenant: total/active/critical/under-treatment/' +
    'quarantined/resolved counts plus breakdowns by event type and severity. Call first ' +
    'when assessing overall fish-health status, then drill into the list tools.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetFishHealthStatsTool extends FarmAiQueryTool<
  Input,
  Record<string, never>,
  FishHealthStatsReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_STATS);
  }

  protected isData(value: unknown): value is FishHealthStatsReply {
    return isFishHealthStats(value);
  }

  protected toRequestFields(): Record<string, never> {
    return {};
  }
}
