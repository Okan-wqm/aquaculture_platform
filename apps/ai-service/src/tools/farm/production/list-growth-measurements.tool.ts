import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import {
  GrowthMeasurementReply,
  isAiListOf,
  isGrowthMeasurement,
} from './reply-guards';

interface Input {
  batchId: string;
  limit?: number;
}

/** Growth measurement history for one batch. */
@Injectable()
@Tool({
  name: 'list_growth_measurements',
  description:
    'Growth measurement history for a batch (newest first): measurement date and ' +
    'type, sample size, average weight/length, weight CV, condition factor and ' +
    'performance grade. Max 50 rows; narrow the window when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      batchId: UUID_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
    required: ['batchId'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListGrowthMeasurementsTool extends FarmAiQueryTool<
  Input,
  { batchId: string; limit?: number },
  AiQueryList<GrowthMeasurementReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS);
  }

  protected isData(value: unknown): value is AiQueryList<GrowthMeasurementReply> {
    return isAiListOf(isGrowthMeasurement)(value);
  }

  protected toRequestFields(input: Input) {
    return { batchId: input.batchId, limit: input.limit };
  }
}
