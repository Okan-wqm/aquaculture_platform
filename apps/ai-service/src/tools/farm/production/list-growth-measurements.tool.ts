import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type GrowthMeasurementsReply,
  type GrowthMeasurementsRequest,
  clampListLimit,
  isGrowthMeasurementsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  batchId: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_growth_measurements',
  description:
    'Growth measurement records of ONE batch, newest first (date, type, sample and population size, avg weight g, avg length cm, weight CV %, condition factor, estimated biomass kg, biomass gain, performance band, verified flag). Max 50 rows, total reported.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['batchId'],
    properties: { batchId: UUID_SCHEMA, limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class ListGrowthMeasurementsTool extends FarmAiQueryTool<
  Input,
  Omit<GrowthMeasurementsRequest, 'tenantId'>,
  GrowthMeasurementsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS;
  protected readonly isData = isGrowthMeasurementsReply;

  protected toRequestFields(input: Input): Omit<GrowthMeasurementsRequest, 'tenantId'> {
    return { batchId: input.batchId, limit: clampListLimit(input.limit) };
  }
}
