import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type FarmStockInventoryReply,
  type FarmStockInventoryRequest,
  clampListLimit,
  isFarmStockInventoryReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA, UUID_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  siteId?: string;
  hasActiveBatch?: boolean;
  limit?: number;
}

@Injectable()
@Tool({
  name: 'get_farm_stock_inventory',
  description:
    'Live fish stock per container (tank/pond/cage): volume, max biomass, current quantity/biomass, capacity used %, over-capacity flag, and the batches inside (number, species, quantity, biomass kg, avg weight g, density). Filter by siteId or hasActiveBatch. Max 50 containers.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      siteId: UUID_SCHEMA,
      hasActiveBatch: { type: 'boolean' },
      limit: LIST_LIMIT_SCHEMA,
    },
  },
  requiresConfirmation: false,
})
export class GetFarmStockInventoryTool extends FarmAiQueryTool<
  Input,
  Omit<FarmStockInventoryRequest, 'tenantId'>,
  FarmStockInventoryReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FARM_STOCK_INVENTORY;
  protected readonly isData = isFarmStockInventoryReply;

  protected toRequestFields(input: Input): Omit<FarmStockInventoryRequest, 'tenantId'> {
    return {
      ...(input.siteId ? { siteId: input.siteId } : {}),
      ...(input.hasActiveBatch !== undefined ? { hasActiveBatch: input.hasActiveBatch } : {}),
      limit: clampListLimit(input.limit),
    };
  }
}
