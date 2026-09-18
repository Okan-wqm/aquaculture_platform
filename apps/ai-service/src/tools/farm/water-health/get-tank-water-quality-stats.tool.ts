import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  isWaterQualityStatsReply,
  type TankWaterQualityStatsRequest,
  type WaterQualityStatsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  tankId: string;
  days?: number;
}

@Injectable()
@Tool({
  name: 'get_tank_water_quality_stats',
  description:
    'Averages (temperature °C, DO mg/L, pH, NH3 mg/L, NO2 mg/L), counts of critical/warning readings and the latest reading for ONE tank over the last N days (default 7, max 90). Tenant data. Resolve a tank name to tankId with get_farm_tanks first.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['tankId'],
    properties: { tankId: UUID_SCHEMA, days: { type: 'integer', minimum: 1, maximum: 90 } },
  },
  requiresConfirmation: false,
})
export class GetTankWaterQualityStatsTool extends FarmAiQueryTool<
  Input,
  Omit<TankWaterQualityStatsRequest, 'tenantId'>,
  WaterQualityStatsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS;
  protected readonly isData = isWaterQualityStatsReply;

  protected toRequestFields(input: Input): Omit<TankWaterQualityStatsRequest, 'tenantId'> {
    return { tankId: input.tankId, days: input.days ?? 7 };
  }
}
