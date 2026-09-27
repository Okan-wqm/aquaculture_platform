import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isWaterQualityHistoryReply,
  type WaterQualityHistoryReply,
  type WaterQualityHistoryRequest,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import {
  ALL_TIERS,
  ISO_DATE_SCHEMA,
  LIST_LIMIT_SCHEMA,
  UUID_SCHEMA,
} from '../farm-ai-query.schema';

interface Input {
  tankId: string;
  fromDate: string;
  toDate: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'get_water_quality_history',
  description:
    'Water-quality readings for ONE tank between two dates (YYYY-MM-DD, span at most 90 days), newest first, max 50 rows. Use for trends; use get_tank_water_quality_stats for a summary. Tenant data.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['tankId', 'fromDate', 'toDate'],
    properties: {
      tankId: UUID_SCHEMA,
      fromDate: ISO_DATE_SCHEMA,
      toDate: ISO_DATE_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class GetWaterQualityHistoryTool extends FarmAiQueryTool<
  Input,
  Omit<WaterQualityHistoryRequest, 'tenantId'>,
  WaterQualityHistoryReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.WQ_HISTORY;
  protected readonly isData = isWaterQualityHistoryReply;

  protected toRequestFields(input: Input): Omit<WaterQualityHistoryRequest, 'tenantId'> {
    return {
      tankId: input.tankId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      limit: clampListLimit(input.limit),
    };
  }
}
