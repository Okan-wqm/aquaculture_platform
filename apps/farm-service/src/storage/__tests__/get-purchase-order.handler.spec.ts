import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetPurchaseOrderQuery } from '../queries/get-purchase-order.query';
import { GetPurchaseOrderHandler } from '../handlers/get-purchase-order.handler';

describe('GetPurchaseOrderHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const poId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the purchase order read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: poId, items: [] });

    const handler = new GetPurchaseOrderHandler(mockDataSource);
    const result = await handler.execute(new GetPurchaseOrderQuery(poId, tenantId));

    expect(result).toEqual({ id: poId, items: [] });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: poId, tenantId, isDeleted: false },
      relations: ['items'],
    });
  });

  it('throws NotFoundException when the purchase order does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetPurchaseOrderHandler(mockDataSource);

    await expect(
      handler.execute(new GetPurchaseOrderQuery(poId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
