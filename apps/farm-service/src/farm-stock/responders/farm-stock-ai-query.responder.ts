import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isFarmStockInventoryRequest,
  type AiQueryReply,
  type FarmStockContainerDto,
  type FarmStockInventoryReply,
} from '@platform/event-contracts';
import { numberOrNull, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import {
  FarmStockInventoryFilterInput,
  type FarmStockInventoryConnection,
  type FarmStockInventoryItem,
} from '../dto/farm-stock-inventory.dto';
import { GetFarmStockInventoryQuery } from '../queries/get-farm-stock-inventory.query';

export function projectContainer(item: FarmStockInventoryItem): FarmStockContainerDto {
  const c = item.container;
  return {
    containerId: c.containerId,
    containerSource: c.containerSource,
    code: c.code,
    name: c.name,
    siteId: c.siteId ?? null,
    status: c.status ?? null,
    volumeM3: numberOrNull(c.volume),
    maxBiomassKg: numberOrNull(c.maxBiomassKg),
    currentQuantity: numberOrNull(c.currentQuantity),
    currentBiomassKg: numberOrNull(c.currentBiomassKg),
    capacityUsedPct: numberOrNull(c.capacityUsedPercent),
    isOverCapacity: c.isOverCapacity,
    hasActiveBatch: c.hasActiveBatch,
    batches: item.batches.map((b) => ({
      batchId: b.batchId,
      batchNumber: b.batchNumber ?? null,
      speciesName: b.speciesName ?? null,
      quantity: Number(b.quantity),
      biomassKg: Number(b.biomassKg),
      avgWeightG: Number(b.avgWeightG),
      densityKgM3: numberOrNull(b.densityKgM3),
      isPrimary: b.isPrimary,
    })),
  };
}

/** Farm stock (containers + batches) for the farm operations specialist (FARM-MEDIUM-328). */
@Controller()
export class FarmStockAiQueryResponder {
  private readonly logger = new Logger(FarmStockAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FARM_STOCK_INVENTORY)
  getInventory(@Payload() payload: unknown): Promise<AiQueryReply<FarmStockInventoryReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FARM_STOCK_INVENTORY,
      payload,
      isFarmStockInventoryRequest,
      async (req) => {
        const filter = new FarmStockInventoryFilterInput();
        filter.isActive = true;
        if (req.siteId) filter.siteId = req.siteId;
        if (req.hasActiveBatch !== undefined) filter.hasActiveBatch = req.hasActiveBatch;
        filter.page = 1;
        filter.limit = req.limit;
        const page = await this.queryBus.execute<
          GetFarmStockInventoryQuery,
          FarmStockInventoryConnection
        >(new GetFarmStockInventoryQuery(req.tenantId, filter));
        return toBoundedList(page.items, req.limit, projectContainer, page.total);
      },
    );
  }
}
