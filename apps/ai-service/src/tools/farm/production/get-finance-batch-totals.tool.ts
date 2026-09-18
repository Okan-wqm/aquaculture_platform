import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { ISO_DATE_SCHEMA, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { FinanceBatchTotalReply, isAiListOf, isFinanceBatchTotal } from './reply-guards';

interface Input {
  fromDate: string;
  toDate: string;
  limit?: number;
}

/**
 * Per-batch finance totals. Manager-tier only — financial aggregates are
 * deliberately out of the operator persona's reach.
 */
@Injectable()
@Tool({
  name: 'get_finance_batch_totals',
  description:
    'Per-batch finance totals (total expense and revenue per batch) for an ' +
    'inclusive period (max 366 days). The server returns its top batches with ' +
    'the remainder rolled into an Other row. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      fromDate: { ...ISO_DATE_SCHEMA, description: 'Inclusive window start' },
      toDate: { ...ISO_DATE_SCHEMA, description: 'Inclusive window end' },
      limit: LIST_LIMIT_SCHEMA,
    },
    required: ['fromDate', 'toDate'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetFinanceBatchTotalsTool extends FarmAiQueryTool<
  Input,
  { fromDate: string; toDate: string; limit?: number },
  AiQueryList<FinanceBatchTotalReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS);
  }

  protected isData(value: unknown): value is AiQueryList<FinanceBatchTotalReply> {
    return isAiListOf(isFinanceBatchTotal)(value);
  }

  protected toRequestFields(input: Input) {
    return { fromDate: input.fromDate, toDate: input.toDate, limit: input.limit };
  }
}
