/**
 * List Low-Stock Alerts Query Handler — fail-closed tenant boundary.
 *
 * WHY ledger-derived (FARM-HIGH-338 / FARM-4): a spare part is due for
 * reordering when its INVENTORY POSITION (ledger on-hand + open purchase-order
 * remainder) reaches its reorder point, or when it is physically out. That is
 * the same pool rule every other stock item uses (`poolStockBand`, applied
 * once in `deriveSparePartStatus`), so an order already placed suppresses the
 * alert instead of the stale status column deciding.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import { LowStockAlert } from '../services/spare-part.service';
import { requireStockView, SparePartStockReader } from '../services/spare-part-stock.reader';
import { ListLowStockAlertsQuery } from '../queries/list-low-stock-alerts.query';

@QueryHandler(ListLowStockAlertsQuery)
export class ListLowStockAlertsHandler implements IQueryHandler<ListLowStockAlertsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockReader: SparePartStockReader,
  ) {}

  async execute(query: ListLowStockAlertsQuery): Promise<LowStockAlert[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const parts = await queryRunner.manager.find(SparePart, {
        where: { tenantId, isActive: true },
      });
      const stock = await this.stockReader.read(queryRunner.manager, tenantId, parts);

      const alerts: LowStockAlert[] = [];
      for (const part of parts) {
        const view = requireStockView(stock, part.id);
        // The ONE spare-part rule (deriveSparePartStatus): due when LOW or OUT.
        if (
          view.status !== SparePartStatus.LOW_STOCK &&
          view.status !== SparePartStatus.OUT_OF_STOCK
        ) {
          continue;
        }
        alerts.push({
          sparePart: part,
          currentQuantity: view.onHand,
          minStock: part.minStock,
          reorderPoint: part.reorderPoint,
          deficit: Math.max(0, part.reorderPoint - (view.onHand + view.onOrder)),
        });
      }
      return alerts.sort((a, b) => a.currentQuantity - b.currentQuantity);
    });
  }
}
