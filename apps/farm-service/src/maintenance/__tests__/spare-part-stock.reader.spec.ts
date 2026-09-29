/**
 * SparePartStockReader — spare-part quantity/status derived from the storage
 * ledger (FARM-HIGH-338).
 */
import { stub } from '@aquaculture/testing';
import { EntityManager } from 'typeorm';

import { StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StockLedgerReader } from '../../storage/services/low-stock/stock-ledger.reader';
import { poolStockBand } from '../../storage/services/low-stock/stock-band';
import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import {
  deriveSparePartStatus,
  requireStockView,
  SparePartStockReader,
} from '../services/spare-part-stock.reader';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('deriveSparePartStatus — the ONE spare-part rule (reorderPoint vs inventory position)', () => {
  const active = { isActive: true, reorderPoint: 5 };
  it.each([
    // SCENARIO: the status ladder against reorderPoint 5 and the inventory
    // position (on-hand + on-order). EXPECTS: inactive > out > low > on order > in stock.
    [{ isActive: false, reorderPoint: 5 }, 10, 0, SparePartStatus.DISCONTINUED],
    // Physically empty: out even with an order open (a pump cannot run on an order).
    [active, 0, 20, SparePartStatus.OUT_OF_STOCK],
    // An order that lifts the position above the reorder point suppresses LOW.
    [active, 3, 20, SparePartStatus.ON_ORDER],
    // An order too small to cover the shortfall leaves the part LOW (FARM-3).
    [active, 3, 2, SparePartStatus.LOW_STOCK],
    [active, 5, 0, SparePartStatus.LOW_STOCK],
    [active, 6, 0, SparePartStatus.IN_STOCK],
    // reorderPoint 0: not reorder-controlled — only a physical stock-out counts.
    [{ isActive: true, reorderPoint: 0 }, 1, 0, SparePartStatus.IN_STOCK],
  ] as const)('%p on-hand %p on-order %p → %p', (part, onHand, onOrder, status) => {
    expect(deriveSparePartStatus(part, onHand, onOrder)).toBe(status);
  });

  it('agrees with the pool tier the ledger event uses for the same part', () => {
    // SCENARIO: every (on-hand, on-order) pair around reorderPoint 5.
    // EXPECTS: status LOW/OUT exactly when poolStockBand says low/out — the
    // status, the low-stock list and LowStockDetected cannot disagree.
    for (let onHand = 0; onHand <= 8; onHand += 1) {
      for (let onOrder = 0; onOrder <= 4; onOrder += 1) {
        const status = deriveSparePartStatus(active, onHand, onOrder);
        const band = poolStockBand(onHand, onOrder, active.reorderPoint);
        expect(status === SparePartStatus.OUT_OF_STOCK).toBe(band === 'out_of_stock');
        expect(status === SparePartStatus.LOW_STOCK).toBe(band === 'low_stock');
      }
    }
  });
});

describe('SparePartStockReader.read', () => {
  it('reads the ledger once for the whole set and folds every site', async () => {
    // SCENARIO: part-1 split over two sites + an order; part-2 has no ledger rows.
    // EXPECTS: part-1 on-hand 7, on-order 4; part-2 zero and OUT_OF_STOCK; one scope for both.
    const onHandBySite = jest.fn().mockResolvedValue([
      { itemType: StorageItemType.SPARE_PART, itemId: 'part-1', siteId: 's1', onHand: 3 },
      { itemType: StorageItemType.SPARE_PART, itemId: 'part-1', siteId: 's2', onHand: 4 },
    ]);
    const onOrder = jest
      .fn()
      .mockResolvedValue([{ itemType: StorageItemType.SPARE_PART, itemId: 'part-1', onOrder: 4 }]);
    const reader = new SparePartStockReader(stub<StockLedgerReader>({ onHandBySite, onOrder }));
    const manager = stub<EntityManager>({});
    const parts = [
      stub<SparePart>({ id: 'part-1', isActive: true, reorderPoint: 2 }),
      stub<SparePart>({ id: 'part-2', isActive: true, reorderPoint: 2 }),
    ];

    const views = await reader.read(manager, TENANT, parts);

    const scope = {
      kind: 'items',
      itemType: StorageItemType.SPARE_PART,
      itemIds: ['part-1', 'part-2'],
    };
    expect(onHandBySite).toHaveBeenCalledWith(manager, TENANT, scope);
    expect(onOrder).toHaveBeenCalledWith(manager, TENANT, scope);
    expect(requireStockView(views, 'part-1')).toEqual({
      onHand: 7,
      onOrder: 4,
      status: SparePartStatus.ON_ORDER,
    });
    expect(requireStockView(views, 'part-2')).toEqual({
      onHand: 0,
      onOrder: 0,
      status: SparePartStatus.OUT_OF_STOCK,
    });
    expect(() => requireStockView(views, 'ghost')).toThrow('Stock view missing');
  });
});
