import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type BatchPerformanceRequest,
  type GrowthAnalysisReply,
  isGrowthAnalysisReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool, FARM_AI_QUERY_HEAVY_TIMEOUT_MS } from '../farm-ai-query.tool';
import { ALL_TIERS, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  batchId: string;
}

@Injectable()
@Tool({
  name: 'get_growth_analysis',
  description:
    'Growth analysis of ONE batch: average weight vs target, daily growth, SGR, cumulative FCR vs target and trend, weight CV and grading need, overall performance, the last 30 trend points, harvest projection and ranked recommendations. Tenant data.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['batchId'],
    properties: { batchId: UUID_SCHEMA },
  },
  requiresConfirmation: false,
})
export class GetGrowthAnalysisTool extends FarmAiQueryTool<
  Input,
  Omit<BatchPerformanceRequest, 'tenantId'>,
  GrowthAnalysisReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS;
  protected readonly isData = isGrowthAnalysisReply;
  protected override readonly timeoutMs = FARM_AI_QUERY_HEAVY_TIMEOUT_MS;

  protected toRequestFields(input: Input): Omit<BatchPerformanceRequest, 'tenantId'> {
    return { batchId: input.batchId };
  }
}
