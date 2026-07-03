/**
 * Spare-part read query handlers — fail-closed tenant boundary (FARM-HIGH-060).
 * Tenant scoping + fail-closed NotFound + empty aggregates.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

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

  it('ListLowStockAlertsHandler maps tenant-scoped low/out-of-stock parts', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([
      { id: 'sp-2', quantity: 1, minStock: 5, reorderPoint: 8 },
    ]);

    const result = await new ListLowStockAlertsHandler(mockDataSource).execute(
      new ListLowStockAlertsQuery(tenantId),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ currentQuantity: 1, minStock: 5, reorderPoint: 8, deficit: 7 });
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where[0]).toMatchObject({ tenantId, isActive: true });
  });

  it('GetStockSummaryHandler aggregates tenant-scoped active parts', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]); // none → zeroed summary

    const result = await new GetStockSummaryHandler(mockDataSource).execute(
      new GetStockSummaryQuery(tenantId),
    );

    expect(result.totalParts).toBe(0);
    expect(result.totalValue).toBe(0);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, isActive: true },
    });
  });
});
