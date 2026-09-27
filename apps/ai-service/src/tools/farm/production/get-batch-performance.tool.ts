import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type BatchPerformanceReply,
  type BatchPerformanceRequest,
  isBatchPerformanceReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool, FARM_AI_QUERY_HEAVY_TIMEOUT_MS } from '../farm-ai-query.tool';
import { ALL_TIERS, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  batchId: string;
}

@Injectable()
@Tool({
  name: 'get_batch_performance',
  description:
    'Full performance of ONE batch: quantities, biomass, weights, mortality/survival, FCR (target/actual/theoretical/variance/status), SGR, days in production, growth vs target, feed consumed and cost, cost per kg and per fish, projected harvest, performance index 0-100. Resolve batch ids with get_farm_batches first.',
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
export class GetBatchPerformanceTool extends FarmAiQueryTool<
  Input,
  Omit<BatchPerformanceRequest, 'tenantId'>,
  BatchPerformanceReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE;
  protected readonly isData = isBatchPerformanceReply;
  protected override readonly timeoutMs = FARM_AI_QUERY_HEAVY_TIMEOUT_MS;

  protected toRequestFields(input: Input): Omit<BatchPerformanceRequest, 'tenantId'> {
    return { batchId: input.batchId };
  }
}
