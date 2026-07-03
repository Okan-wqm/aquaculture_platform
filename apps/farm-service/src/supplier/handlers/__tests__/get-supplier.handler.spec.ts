import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetSupplierQuery } from '../../queries/get-supplier.query';
import { GetSupplierHandler } from '../get-supplier.handler';

describe('GetSupplierHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const supplierId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the supplier read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const supplier = { id: supplierId, tenantId };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(supplier);

    const handler = new GetSupplierHandler(mockDataSource);
    const result = await handler.execute(new GetSupplierQuery(supplierId, tenantId));

    expect(result).toBe(supplier);
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: supplierId, tenantId },
    });
  });

  it('throws NotFoundException when no supplier matches the id', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetSupplierHandler(mockDataSource);

    await expect(
      handler.execute(new GetSupplierQuery(supplierId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
