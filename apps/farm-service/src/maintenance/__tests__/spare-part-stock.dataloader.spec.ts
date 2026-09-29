/**
 * SparePartStockDataLoader — the GraphQL `SparePart.status` path loads every
 * catalog column the ONE spare-part rule reads (FARM-HIGH-338 / FARM-4).
 *
 * The loader reads the parts with a PARTIAL select before handing them to
 * SparePartStockReader. A column missing from that select arrives as
 * `undefined`; for `reorderPoint` that made the threshold NaN, so the field
 * never read LOW_STOCK while the low-stock list (a full load) did.
 */
import { createMockDataSource, stub } from '@aquaculture/testing';
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import type { FindManyOptions, Repository } from 'typeorm';

import { StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StockLedgerReader } from '../../storage/services/low-stock/stock-ledger.reader';
import { SparePartStockDataLoader } from '../dataloaders/spare-part-stock.dataloader';
import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import {
  SPARE_PART_STOCK_FACT_COLUMNS,
  SparePartStockReader,
} from '../services/spare-part-stock.reader';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PART = '22222222-2222-4222-8222-222222222222';

/** The stored row: 3 on hand, reorder point 5, safety stock 1. */
const STORED: Record<string, unknown> = {
  id: PART,
  tenantId: TENANT,
  isActive: true,
  reorderPoint: 5,
  minStock: 1,
};

function harness(): { loader: SparePartStockDataLoader; find: jest.Mock } {
  const { mockDataSource, mockManager } = createMockDataSource();
  // Honours `select` like TypeORM: an unselected column is absent on the row.
  const find = jest.fn();
  find.mockImplementation(async (options: FindManyOptions<SparePart>) => {
    const columns = Array.isArray(options.select) ? options.select.map(String) : [];
    return [Object.fromEntries(columns.map((column) => [column, STORED[column]]))];
  });
  (mockManager.getRepository as jest.Mock).mockImplementation((entity: unknown): unknown => {
    if (entity !== SparePart) throw new Error(`unexpected repository ${String(entity)}`);
    return stub<Repository<SparePart>>({ find });
  });
  const ledger = stub<StockLedgerReader>({
    onHandBySite: jest
      .fn()
      .mockResolvedValue([
        { itemType: StorageItemType.SPARE_PART, itemId: PART, siteId: 'site-1', onHand: 3 },
      ]),
    onOrder: jest.fn().mockResolvedValue([]),
  });
  const loader = new SparePartStockDataLoader(mockDataSource, new SparePartStockReader(ledger));
  return { loader, find };
}

describe('SparePartStockDataLoader', () => {
  it('selects the reader column list, so the field status matches the reorder rule', async () => {
    // SCENARIO: 3 on hand, nothing on order, reorderPoint 5 (minStock 1).
    // EXPECTS: the partial load selects exactly SPARE_PART_STOCK_FACT_COLUMNS
    // (reorderPoint included) and the status is LOW_STOCK — with the old
    // ['id','isActive','minStock'] select it read IN_STOCK.
    const { loader, find } = harness();

    const view = await requestContextStorage.run({ tenantId: TENANT }, async () =>
      loader.load(PART),
    );

    expect(find.mock.calls[0][0].select).toEqual([...SPARE_PART_STOCK_FACT_COLUMNS]);
    expect(view).toEqual({ onHand: 3, onOrder: 0, status: SparePartStatus.LOW_STOCK });
  });
});
