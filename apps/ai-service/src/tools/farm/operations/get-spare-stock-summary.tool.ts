import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { StockSummaryReply, isStockSummary } from './reply-guards';

/** No input — the summary is tenant-wide. */
type Input = Record<string, never>;

/** Spare-part stock summary. */
@Injectable()
@Tool({
  name: 'get_spare_stock_summary',
  description:
    'Spare-part stock summary for the tenant: total parts, total value, low-stock ' +
    'and out-of-stock counts, and counts by part status.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetSpareStockSummaryTool extends FarmAiQueryTool<
  Input,
  Record<string, never>,
  StockSummaryReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.MAINT_STOCK_SUMMARY);
  }

  protected isData(value: unknown): value is StockSummaryReply {
    return isStockSummary(value);
  }

  protected toRequestFields(): Record<string, never> {
    return {};
  }
}
