/**
 * Farm-stock farm-AI read-only NATS responder (PR-5, Operations specialist).
 * One `request.farm.ai.*` subject backed EXCLUSIVELY by the farm-stock
 * module's existing tenant-scoped CQRS query handler via QueryBus — no
 * direct DB access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isFarmStockInventoryRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { GetFarmStockInventoryQuery } from '../queries/get-farm-stock-inventory.query';
import {
  FarmStockInventoryConnection,
  FarmStockInventoryFilterInput,
} from '../dto/farm-stock-inventory.dto';
import { StockContainerDto, projectStockContainer } from './projections';

@Controller()
export class FarmStockAiQueryResponder {
  private readonly logger = new Logger(FarmStockAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FARM_STOCK_INVENTORY)
  async inventory(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<StockContainerDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isFarmStockInventoryRequest,
      async (req) => {
        const limit = clampListLimit(
          req.limit,
          FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT,
        );
        // ONLY filter fields the AI contract exposes are passed through —
        // the real filter input also carries free-text search, departmentId
        // and containerSources, which stay unreachable from the model.
        const filter: FarmStockInventoryFilterInput = { page: 1, limit };
        if (req.siteId !== undefined) filter.siteId = req.siteId;
        if (req.status !== undefined) filter.status = req.status;
        if (req.hasActiveBatch !== undefined) filter.hasActiveBatch = req.hasActiveBatch;

        const result = await this.queryBus.execute<
          GetFarmStockInventoryQuery,
          FarmStockInventoryConnection
        >(new GetFarmStockInventoryQuery(req.tenantId, filter));
        const rows = result.items ?? [];
        return toBoundedList(
          rows,
          limit,
          (row) => projectStockContainer(row.container, row.batches ?? []),
          result.total,
        );
      },
    );
  }
}
