import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type SpareStockSummaryReply,
  type SpareStockSummaryRequest,
  isSpareStockSummaryReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';

type Input = Record<string, never>;

@Injectable()
@Tool({
  name: 'get_spare_stock_summary',
  description:
    'Spare-part stock overview: number of parts, total stock value, low-stock and out-of-stock counts, parts by status.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  requiresConfirmation: false,
})
export class GetSpareStockSummaryTool extends FarmAiQueryTool<
  Input,
  Omit<SpareStockSummaryRequest, 'tenantId'>,
  SpareStockSummaryReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.MAINT_STOCK_SUMMARY;
  protected readonly isData = isSpareStockSummaryReply;

  protected toRequestFields(_input: Input): Omit<SpareStockSummaryRequest, 'tenantId'> {
    return {};
  }
}
