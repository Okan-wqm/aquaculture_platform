import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type FinanceBatchTotalsReply,
  type FinanceBatchTotalsRequest,
  clampListLimit,
  isFinanceBatchTotalsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ISO_DATE_SCHEMA, LIST_LIMIT_SCHEMA, MANAGER_UP } from '../farm-ai-query.schema';

interface Input {
  fromDate: string;
  toDate: string;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'get_finance_batch_totals',
  description:
    'Expense, revenue and net result per batch between two dates (YYYY-MM-DD, at most 366 days). Combine with get_batch_performance for cost per kg. Manager tier and above. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: MANAGER_UP,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['fromDate', 'toDate'],
    properties: { fromDate: ISO_DATE_SCHEMA, toDate: ISO_DATE_SCHEMA, limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class GetFinanceBatchTotalsTool extends FarmAiQueryTool<
  Input,
  Omit<FinanceBatchTotalsRequest, 'tenantId'>,
  FinanceBatchTotalsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS;
  protected readonly isData = isFinanceBatchTotalsReply;

  protected toRequestFields(input: Input): Omit<FinanceBatchTotalsRequest, 'tenantId'> {
    return { fromDate: input.fromDate, toDate: input.toDate, limit: clampListLimit(input.limit) };
  }
}
