import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { LowStockReply, isAiListOf, isLowStock } from './reply-guards';

type Input = { limit?: number };

/** Spare parts at or below their minimum stock. */
@Injectable()
@Tool({
  name: 'list_low_stock_spare_parts',
  description:
    'Spare parts at or below their minimum stock level: current quantity, minimum ' +
    'and reorder point, deficit to reorder level, unit and unit price. Use for ' +
    'purchase planning. Max 50 rows; narrow with limit when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { limit: LIST_LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListLowStockSparePartsTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<LowStockReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.MAINT_LOW_STOCK);
  }

  protected isData(value: unknown): value is AiQueryList<LowStockReply> {
    return isAiListOf(isLowStock)(value);
  }

  protected toRequestFields(input: Input) {
    return { limit: input.limit };
  }
}
