import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  FINANCE_GRANULARITIES,
  type FinanceGranularityCode,
  type FinanceSummaryReply,
  type FinanceSummaryRequest,
  isFinanceSummaryReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool, FARM_AI_QUERY_HEAVY_TIMEOUT_MS } from '../farm-ai-query.tool';
import { ISO_DATE_SCHEMA, MANAGER_UP } from '../farm-ai-query.schema';

interface Input {
  fromDate: string;
  toDate: string;
  granularity?: FinanceGranularityCode;
}

@Injectable()
@Tool({
  name: 'get_finance_summary',
  description:
    'Farm finance between two dates (YYYY-MM-DD, at most 366 days) at DAY/WEEK/MONTH/YEAR granularity: currency, total expense, revenue, net result, totals by category and a time series (capped at 53 buckets). Manager tier and above.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: MANAGER_UP,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['fromDate', 'toDate'],
    properties: {
      fromDate: ISO_DATE_SCHEMA,
      toDate: ISO_DATE_SCHEMA,
      granularity: { type: 'string', enum: [...FINANCE_GRANULARITIES] },
    },
  },
  requiresConfirmation: false,
})
export class GetFinanceSummaryTool extends FarmAiQueryTool<
  Input,
  Omit<FinanceSummaryRequest, 'tenantId'>,
  FinanceSummaryReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY;
  protected readonly isData = isFinanceSummaryReply;
  protected override readonly timeoutMs = FARM_AI_QUERY_HEAVY_TIMEOUT_MS;

  protected toRequestFields(input: Input): Omit<FinanceSummaryRequest, 'tenantId'> {
    return {
      fromDate: input.fromDate,
      toDate: input.toDate,
      granularity: input.granularity ?? 'MONTH',
    };
  }
}
