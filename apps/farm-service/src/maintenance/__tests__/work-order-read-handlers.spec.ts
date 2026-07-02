/**
 * Work-order read query handlers — fail-closed tenant boundary (FARM-HIGH-060).
 * Proves tenant scoping + fail-closed NotFound for the find/findOne handlers.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetWorkOrderHandler } from '../handlers/get-work-order.handler';
import { GetWorkOrderQuery } from '../queries/get-work-order.query';
import { GetWorkOrderByCodeHandler } from '../handlers/get-work-order-by-code.handler';
import { GetWorkOrderByCodeQuery } from '../queries/get-work-order-by-code.query';
import { ListOverdueWorkOrdersHandler } from '../handlers/list-overdue-work-orders.handler';
import { ListOverdueWorkOrdersQuery } from '../queries/list-overdue-work-orders.query';
import { ListMyWorkOrdersHandler } from '../handlers/list-my-work-orders.handler';
import { ListMyWorkOrdersQuery } from '../queries/list-my-work-orders.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Work-order read handlers (fail-closed tenant boundary)', () => {
  it('GetWorkOrderHandler reads by id scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'wo-1' });

    const result = await new GetWorkOrderHandler(mockDataSource).execute(
      new GetWorkOrderQuery(tenantId, 'wo-1'),
    );

    expect(result).toEqual({ id: 'wo-1' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'wo-1', tenantId },
    });
  });

  it('GetWorkOrderHandler throws NotFoundException when absent (no silent null)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      new GetWorkOrderHandler(mockDataSource).execute(new GetWorkOrderQuery(tenantId, 'missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GetWorkOrderByCodeHandler throws NotFoundException when absent', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      new GetWorkOrderByCodeHandler(mockDataSource).execute(
        new GetWorkOrderByCodeQuery(tenantId, 'WO-X'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ListOverdueWorkOrdersHandler lists tenant-scoped overdue orders', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'wo-2' }]);

    const result = await new ListOverdueWorkOrdersHandler(mockDataSource).execute(
      new ListOverdueWorkOrdersQuery(tenantId),
    );

    expect(result).toHaveLength(1);
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId });
  });

  it('ListMyWorkOrdersHandler scopes to tenant + assignee', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    await new ListMyWorkOrdersHandler(mockDataSource).execute(
      new ListMyWorkOrdersQuery(tenantId, 'user-1', true),
    );

    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId, assignedTo: 'user-1' });
  });
});
