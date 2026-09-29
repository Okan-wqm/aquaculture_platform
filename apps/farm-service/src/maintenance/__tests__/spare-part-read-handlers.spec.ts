/**
 * Spare-part read query handlers — fail-closed tenant boundary (FARM-HIGH-060).
 * Tenant scoping + fail-closed NotFound + empty aggregates.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource, stub } from '@aquaculture/testing';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import { SparePartStockReader } from '../services/spare-part-stock.reader';

import { GetSparePartHandler } from '../handlers/get-spare-part.handler';
import { GetSparePartQuery } from '../queries/get-spare-part.query';
import { GetSparePartByCodeHandler } from '../handlers/get-spare-part-by-code.handler';
import { GetSparePartByCodeQuery } from '../queries/get-spare-part-by-code.query';
import { ListLowStockAlertsHandler } from '../handlers/list-low-stock-alerts.handler';
import { ListLowStockAlertsQuery } from '../queries/list-low-stock-alerts.query';
import { GetStockSummaryHandler } from '../handlers/get-stock-summary.handler';
import { GetStockSummaryQuery } from '../queries/get-stock-summary.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Spare-part read handlers (fail-closed tenant boundary)', () => {
  it('GetSparePartHandler reads by id scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'sp-1' });

    const result = await new GetSparePartHandler(mockDataSource).execute(
      new GetSparePartQuery(tenantId, 'sp-1'),
    );

    expect(result).toEqual({ id: 'sp-1' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'sp-1', tenantId },
    });
  });

  it('GetSparePartByCodeHandler throws NotFoundException when absent', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      new GetSparePartByCodeHandler(mockDataSource).execute(
        new GetSparePartByCodeQuery(tenantId, 'SP-X'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ListLowStockAlertsHandler lists parts whose ledger position reached the reorder point', async () => {
    // SCENARIO: three active parts; the ledger says sp-2 is at 1 (reorder 8),
    // sp-3 has 1 on hand but 10 on order (covered), sp-4 is plentiful.
    // EXPECTS: only sp-2, deficit = reorderPoint − (onHand + onOrder) (FARM-HIGH-338 / FARM-4).
    const { mockDataSource, mockManager } = createMockDataSource();
    const parts = [
      stub<SparePart>({ id: 'sp-2', isActive: true, minStock: 5, reorderPoint: 8 }),
      stub<SparePart>({ id: 'sp-3', isActive: true, minStock: 5, reorderPoint: 8 }),
      stub<SparePart>({ id: 'sp-4', isActive: true, minStock: 5, reorderPoint: 8 }),
    ];
    (mockManager.find as jest.Mock).mockResolvedValueOnce(parts);
    const read = jest.fn().mockResolvedValue(
      new Map([
        ['sp-2', { onHand: 1, onOrder: 0, status: SparePartStatus.LOW_STOCK }],
        ['sp-3', { onHand: 1, onOrder: 10, status: SparePartStatus.ON_ORDER }],
        ['sp-4', { onHand: 50, onOrder: 0, status: SparePartStatus.IN_STOCK }],
      ]),
    );

    const result = await new ListLowStockAlertsHandler(
      mockDataSource,
      stub<SparePartStockReader>({ read }),
    ).execute(new ListLowStockAlertsQuery(tenantId));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ currentQuantity: 1, minStock: 5, reorderPoint: 8, deficit: 7 });
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, isActive: true },
    });
    expect(read).toHaveBeenCalledWith(mockManager, tenantId, parts);
  });

  it('GetStockSummaryHandler aggregates ledger-derived value and status counts', async () => {
    // SCENARIO: one part priced 2.5 with 4 on hand (LOW), one out of stock.
    // EXPECTS: value from ledger on-hand, counts from the derived status.
    const { mockDataSource, mockManager } = createMockDataSource();
    const parts = [
      stub<SparePart>({ id: 'sp-1', isActive: true, minStock: 5, unitPrice: 2.5 }),
      stub<SparePart>({ id: 'sp-2', isActive: true, minStock: 5 }),
    ];
    (mockManager.find as jest.Mock).mockResolvedValueOnce(parts);
    const read = jest.fn().mockResolvedValue(
      new Map([
        ['sp-1', { onHand: 4, onOrder: 0, status: SparePartStatus.LOW_STOCK }],
        ['sp-2', { onHand: 0, onOrder: 0, status: SparePartStatus.OUT_OF_STOCK }],
      ]),
    );

    const result = await new GetStockSummaryHandler(
      mockDataSource,
      stub<SparePartStockReader>({ read }),
    ).execute(new GetStockSummaryQuery(tenantId));

    expect(result.totalParts).toBe(2);
    expect(result.totalValue).toBe(10);
    expect(result.lowStockCount).toBe(1);
    expect(result.outOfStockCount).toBe(1);
    expect(result.byStatus[SparePartStatus.LOW_STOCK]).toBe(1);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, isActive: true },
    });
  });
});
