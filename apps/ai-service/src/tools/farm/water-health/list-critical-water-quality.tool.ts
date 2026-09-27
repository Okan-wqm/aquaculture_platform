import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isCriticalWaterQualityReply,
  type CriticalWaterQualityReply,
  type CriticalWaterQualityRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_critical_water_quality',
  description:
    "The tenant's current readings in critical or warning state, with the offending parameters and their critical limits. Call this FIRST when asked how the farm's water is doing. Max 50 rows.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class ListCriticalWaterQualityTool extends FarmAiQueryTool<
  Input,
  Omit<CriticalWaterQualityRequest, 'tenantId'>,
  CriticalWaterQualityReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL;
  protected readonly isData = isCriticalWaterQualityReply;

  protected toRequestFields(input: Input): Omit<CriticalWaterQualityRequest, 'tenantId'> {
    return { limit: clampListLimit(input.limit) };
  }
}
