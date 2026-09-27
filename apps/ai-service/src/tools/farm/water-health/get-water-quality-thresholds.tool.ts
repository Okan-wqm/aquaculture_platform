import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  isWaterQualityThresholdsReply,
  type WaterQualityThresholdsReply,
  type WaterQualityThresholdsRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';

interface Input {
  group?: string;
}

@Injectable()
@Tool({
  name: 'get_water_quality_thresholds',
  description:
    "The tenant's configured water-quality parameters with optimal / warning / critical limits and units. Use these thresholds when judging a reading, instead of general guidance; say when a parameter has no configured limit.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      group: { type: 'string', maxLength: 64, description: 'Optional parameter group filter' },
    },
  },
  requiresConfirmation: false,
})
export class GetWaterQualityThresholdsTool extends FarmAiQueryTool<
  Input,
  Omit<WaterQualityThresholdsRequest, 'tenantId'>,
  WaterQualityThresholdsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS;
  protected readonly isData = isWaterQualityThresholdsReply;

  protected toRequestFields(input: Input): Omit<WaterQualityThresholdsRequest, 'tenantId'> {
    return input.group ? { group: input.group } : {};
  }
}
