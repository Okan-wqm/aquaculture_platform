/**
 * Get Spare-Part Stock Summary Query Handler — fail-closed tenant boundary.
 *
 * WHY ledger-derived (FARM-HIGH-338): value and status counts come from the
 * storage ledger through SparePartStockReader, not from the legacy counter
 * and status columns that no movement ever backed.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import { StockSummary } from '../services/spare-part.service';
import { requireStockView, SparePartStockReader } from '../services/spare-part-stock.reader';
import { GetStockSummaryQuery } from '../queries/get-stock-summary.query';

@QueryHandler(GetStockSummaryQuery)
export class GetStockSummaryHandler implements IQueryHandler<GetStockSummaryQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockReader: SparePartStockReader,
  ) {}

  async execute(query: GetStockSummaryQuery): Promise<StockSummary> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const parts = await queryRunner.manager.find(SparePart, {
        where: { tenantId, isActive: true },
      });
      const stock = await this.stockReader.read(queryRunner.manager, tenantId, parts);

      // Exhaustive by type: a new status is a compile error here.
      const byStatus: Record<SparePartStatus, number> = {
        [SparePartStatus.IN_STOCK]: 0,
        [SparePartStatus.LOW_STOCK]: 0,
        [SparePartStatus.OUT_OF_STOCK]: 0,
        [SparePartStatus.ON_ORDER]: 0,
        [SparePartStatus.DISCONTINUED]: 0,
      };
      const summary: StockSummary = {
        totalParts: parts.length,
        totalValue: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
        byStatus,
      };

      for (const part of parts) {
        const view = requireStockView(stock, part.id);
        if (part.unitPrice) summary.totalValue += Number(part.unitPrice) * view.onHand;
        summary.byStatus[view.status] += 1;
        if (view.status === SparePartStatus.LOW_STOCK) summary.lowStockCount += 1;
        if (view.status === SparePartStatus.OUT_OF_STOCK) summary.outOfStockCount += 1;
      }
      return summary;
    });
  }
}
