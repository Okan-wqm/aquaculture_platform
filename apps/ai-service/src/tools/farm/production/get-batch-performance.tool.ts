import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { BatchPerformanceReply, isBatchPerformance } from './reply-guards';

interface Input {
  batchId: string;
}

/** Production KPI snapshot for one batch. */
@Injectable()
@Tool({
  name: 'get_batch_performance',
  description:
    'Batch production KPIs: quantity/biomass, average weight gain, mortality and ' +
    'survival rates, FCR vs target, SGR, daily growth vs target, feed consumed, ' +
    'cost per kg/fish, a 0-100 performance index and projected harvest date.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { batchId: UUID_SCHEMA },
    required: ['batchId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetBatchPerformanceTool extends FarmAiQueryTool<
  Input,
  { batchId: string },
  BatchPerformanceReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE);
  }

  protected isData(value: unknown): value is BatchPerformanceReply {
    return isBatchPerformance(value);
  }

  protected toRequestFields(input: Input) {
    return { batchId: input.batchId };
  }
}
