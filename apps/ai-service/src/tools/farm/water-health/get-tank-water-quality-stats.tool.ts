import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { STAT_DAYS_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { WqStatsReply, isWqStats } from './reply-guards';

interface Input {
  tankId: string;
  days?: number;
}

/** Average water-quality statistics for one tank over a trailing window. */
@Injectable()
@Tool({
  name: 'get_tank_water_quality_stats',
  description:
    'Average water quality for one tank over the last N days (avg temperature °C, ' +
    'dissolved oxygen mg/L, pH, ammonia mg/L, nitrite mg/L, measurement/critical/warning ' +
    'counts, latest reading). Call for tank health trends; resolve tankId via ' +
    'get_farm_tanks first.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { tankId: UUID_SCHEMA, days: STAT_DAYS_SCHEMA },
    required: ['tankId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetTankWaterQualityStatsTool extends FarmAiQueryTool<
  Input,
  { tankId: string; days: number },
  WqStatsReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS);
  }

  protected isData(value: unknown): value is WqStatsReply {
    return isWqStats(value);
  }

  protected toRequestFields(input: Input): { tankId: string; days: number } {
    return { tankId: input.tankId, days: input.days ?? 7 };
  }
}
