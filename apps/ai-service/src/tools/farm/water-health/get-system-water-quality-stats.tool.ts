import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  isWaterQualityStatsReply,
  type SystemWaterQualityStatsRequest,
  type WaterQualityStatsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  systemId: string;
  days?: number;
}

@Injectable()
@Tool({
  name: 'get_system_water_quality_stats',
  description:
    'Averages (temperature °C, DO mg/L, pH, NH3 mg/L, NO2 mg/L), critical/warning counts and the latest reading for ONE water system (a group of tanks) over the last N days (default 7, max 90). Tenant data.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['systemId'],
    properties: { systemId: UUID_SCHEMA, days: { type: 'integer', minimum: 1, maximum: 90 } },
  },
  requiresConfirmation: false,
})
export class GetSystemWaterQualityStatsTool extends FarmAiQueryTool<
  Input,
  Omit<SystemWaterQualityStatsRequest, 'tenantId'>,
  WaterQualityStatsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS;
  protected readonly isData = isWaterQualityStatsReply;

  protected toRequestFields(input: Input): Omit<SystemWaterQualityStatsRequest, 'tenantId'> {
    return { systemId: input.systemId, days: input.days ?? 7 };
  }
}
