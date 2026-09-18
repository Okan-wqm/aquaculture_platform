import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { STAT_DAYS_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { WqStatsReply, isWqStats } from './reply-guards';

interface Input {
  systemId: string;
  days?: number;
}

/** Average water-quality statistics aggregated over every tank in a system. */
@Injectable()
@Tool({
  name: 'get_system_water_quality_stats',
  description:
    'Average water quality across ALL tanks of a recirculation system over the last N ' +
    'days (avg temperature °C, dissolved oxygen mg/L, pH, ammonia mg/L, nitrite mg/L, ' +
    'counts, latest reading). Use for system-level water trend questions.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { systemId: UUID_SCHEMA, days: STAT_DAYS_SCHEMA },
    required: ['systemId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetSystemWaterQualityStatsTool extends FarmAiQueryTool<
  Input,
  { systemId: string; days: number },
  WqStatsReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS);
  }

  protected isData(value: unknown): value is WqStatsReply {
    return isWqStats(value);
  }

  protected toRequestFields(input: Input): { systemId: string; days: number } {
    return { systemId: input.systemId, days: input.days ?? 7 };
  }
}
