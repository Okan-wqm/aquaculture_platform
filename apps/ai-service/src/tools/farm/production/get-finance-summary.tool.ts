import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { ISO_DATE_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { FinanceSummaryReply, isFinanceSummary } from './reply-guards';

interface Input {
  fromDate: string;
  toDate: string;
  granularity: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
}

/**
 * Ledger summary for a period. Manager-tier only — financial aggregates are
 * deliberately out of the operator persona's reach.
 */
@Injectable()
@Tool({
  name: 'get_finance_summary',
  description:
    'Finance ledger summary for an inclusive period (max 366 days): currency, ' +
    'total expense/revenue/net result, per-category totals and a time series at ' +
    'the requested granularity (DAY/WEEK/MONTH/YEAR — the server auto-coarsens ' +
    'very wide ranges).',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      fromDate: { ...ISO_DATE_SCHEMA, description: 'Inclusive window start' },
      toDate: { ...ISO_DATE_SCHEMA, description: 'Inclusive window end' },
      granularity: {
        type: 'string',
        enum: ['DAY', 'WEEK', 'MONTH', 'YEAR'],
        description: 'Time-series bucket size',
      },
    },
    required: ['fromDate', 'toDate', 'granularity'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetFinanceSummaryTool extends FarmAiQueryTool<
  Input,
  { fromDate: string; toDate: string; granularity: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' },
  FinanceSummaryReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY);
  }

  protected isData(value: unknown): value is FinanceSummaryReply {
    return isFinanceSummary(value);
  }

  protected toRequestFields(input: Input) {
    return {
      fromDate: input.fromDate,
      toDate: input.toDate,
      granularity: input.granularity,
    };
  }
}
