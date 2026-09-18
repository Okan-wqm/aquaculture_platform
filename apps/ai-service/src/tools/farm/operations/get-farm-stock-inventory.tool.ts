import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA, OPTIONAL_UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { StockContainerReply, isAiListOf, isStockContainer } from './reply-guards';

interface Input {
  siteId?: string;
  status?: string;
  hasActiveBatch?: boolean;
  limit?: number;
}

/** Live farm-stock inventory (container snapshots). */
@Injectable()
@Tool({
  name: 'get_farm_stock_inventory',
  description:
    'Live farm-stock inventory: containers (tanks/pens/ponds) with current quantity, ' +
    'biomass, capacity use and over-capacity flag, plus the batches living in each ' +
    '(primary batch first, with species and density). Optional siteId, status and ' +
    'hasActiveBatch filters. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      siteId: OPTIONAL_UUID_SCHEMA,
      status: { type: 'string', description: 'Container status filter' },
      hasActiveBatch: { type: 'boolean', description: 'Only containers with an active batch' },
      limit: LIST_LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetFarmStockInventoryTool extends FarmAiQueryTool<
  Input,
  { siteId?: string; status?: string; hasActiveBatch?: boolean; limit?: number },
  AiQueryList<StockContainerReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FARM_STOCK_INVENTORY);
  }

  protected isData(value: unknown): value is AiQueryList<StockContainerReply> {
    return isAiListOf(isStockContainer)(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      status: input.status,
      hasActiveBatch: input.hasActiveBatch,
      limit: input.limit,
    };
  }
}
