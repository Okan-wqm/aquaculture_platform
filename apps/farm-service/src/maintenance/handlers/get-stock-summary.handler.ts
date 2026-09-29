/**
 * Get Spare-Part Stock Summary Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import { StockSummary } from '../services/spare-part.service';
import { GetStockSummaryQuery } from '../queries/get-stock-summary.query';

@QueryHandler(GetStockSummaryQuery)
export class GetStockSummaryHandler implements IQueryHandler<GetStockSummaryQuery> {
  async execute(query: GetStockSummaryQuery): Promise<StockSummary> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    const parts = await scope.manager.find(SparePart, {
      where: { tenantId, isActive: true },
    });

    const summary: StockSummary = {
      totalParts: parts.length,
      totalValue: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      byStatus: {} as Record<SparePartStatus, number>,
    };

    Object.values(SparePartStatus).forEach((s) => (summary.byStatus[s] = 0));

    for (const part of parts) {
      if (part.unitPrice) {
        summary.totalValue += Number(part.unitPrice) * part.quantity;
      }
      summary.byStatus[part.status]++;
      if (part.status === SparePartStatus.LOW_STOCK) {
        summary.lowStockCount++;
      } else if (part.status === SparePartStatus.OUT_OF_STOCK) {
        summary.outOfStockCount++;
      }
    }

    return summary;
  }
}
