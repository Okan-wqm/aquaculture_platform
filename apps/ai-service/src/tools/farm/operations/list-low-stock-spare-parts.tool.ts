import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type BoundedListRequest,
  type LowStockSparePartsReply,
  clampListLimit,
  isLowStockSparePartsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_low_stock_spare_parts',
  description:
    'Spare parts at or below their minimum / reorder level: code, name, part number, unit, current quantity, minimum, reorder point, deficit, supplier lead time days. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class ListLowStockSparePartsTool extends FarmAiQueryTool<
  Input,
  Omit<BoundedListRequest, 'tenantId'>,
  LowStockSparePartsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.MAINT_LOW_STOCK;
  protected readonly isData = isLowStockSparePartsReply;

  protected toRequestFields(input: Input): Omit<BoundedListRequest, 'tenantId'> {
    return { limit: clampListLimit(input.limit) };
  }
}
