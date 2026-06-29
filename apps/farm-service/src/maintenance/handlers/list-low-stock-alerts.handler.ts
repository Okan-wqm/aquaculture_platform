/**
 * List Low-Stock Alerts Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import { LowStockAlert } from '../services/spare-part.service';
import { ListLowStockAlertsQuery } from '../queries/list-low-stock-alerts.query';

@QueryHandler(ListLowStockAlertsQuery)
export class ListLowStockAlertsHandler implements IQueryHandler<ListLowStockAlertsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListLowStockAlertsQuery): Promise<LowStockAlert[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const parts = await queryRunner.manager.find(SparePart, {
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
    });
  }
}
