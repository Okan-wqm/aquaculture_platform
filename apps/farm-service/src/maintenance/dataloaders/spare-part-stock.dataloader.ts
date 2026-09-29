/**
 * SparePartStockDataLoader — batches the ledger read behind the GraphQL
 * `SparePart.quantity` / `status` / `onOrderQuantity` fields (FARM-HIGH-338).
 *
 * WHY: the fields are derived from the storage ledger now; resolving them per
 * part would be N+1 on every list. WHAT: every part id resolved in one GraphQL
 * tick is read with one catalog query and two ledger queries through
 * SparePartStockReader, inside the tenant read boundary.
 *
 * Scope: REQUEST — each GraphQL request gets its own loader, so a cached view
 * never crosses requests or tenants.
 */
import { Injectable, Scope } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import DataLoader from 'dataloader';
import { DataSource, In } from 'typeorm';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';

import { SparePart } from '../entities/spare-part.entity';
import { SparePartStockReader, SparePartStockView } from '../services/spare-part-stock.reader';

@Injectable({ scope: Scope.REQUEST })
export class SparePartStockDataLoader {
  private readonly loader: DataLoader<string, SparePartStockView>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reader: SparePartStockReader,
  ) {
    this.loader = createTenantScopedDataLoader<string, SparePartStockView>(
      async (tenantId: string, partIds: readonly string[]) => {
        const views = await runInTenantRead(
          this.dataSource,
          'farm',
          tenantId,
          async (queryRunner) => {
            const parts = await tenantManagerRepo(queryRunner.manager, SparePart, tenantId).find({
              where: { tenantId, id: In([...partIds]) },
              select: ['id', 'isActive', 'minStock'],
            });
            return this.reader.read(queryRunner.manager, tenantId, parts);
          },
        );
        return partIds.map(
          (id) => views.get(id) ?? new Error(`Spare part ${id} not found in this tenant`),
        );
      },
      {
        batchFnName: 'SparePartStockDataLoader',
        dataLoaderOptions: {
          cache: true,
          batchScheduleFn: (cb: () => void): ReturnType<typeof setTimeout> => setTimeout(cb, 0),
        },
      },
    );
  }

  /** The derived stock of one part (batched within the tick). */
  async load(partId: string): Promise<SparePartStockView> {
    return this.loader.load(partId);
  }
}
