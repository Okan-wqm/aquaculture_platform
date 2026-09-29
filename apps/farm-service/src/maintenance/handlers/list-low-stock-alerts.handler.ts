/**
 * List Low-Stock Alerts Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import { LowStockAlert } from '../services/spare-part.service';
import { ListLowStockAlertsQuery } from '../queries/list-low-stock-alerts.query';

@QueryHandler(ListLowStockAlertsQuery)
export class ListLowStockAlertsHandler implements IQueryHandler<ListLowStockAlertsQuery> {
  async execute(query: ListLowStockAlertsQuery): Promise<LowStockAlert[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    const parts = await scope.manager.find(SparePart, {
      where: [
        { tenantId, isActive: true, status: SparePartStatus.LOW_STOCK },
        { tenantId, isActive: true, status: SparePartStatus.OUT_OF_STOCK },
      ],
      order: { quantity: 'ASC' },
    });

    return parts.map((part) => ({
      sparePart: part,
      currentQuantity: part.quantity,
      minStock: part.minStock,
      reorderPoint: part.reorderPoint,
      deficit: Math.max(0, part.reorderPoint - part.quantity),
    }));
  }
}
