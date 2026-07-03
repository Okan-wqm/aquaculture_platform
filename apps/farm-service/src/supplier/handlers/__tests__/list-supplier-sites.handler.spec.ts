import { createMockDataSource } from '@aquaculture/testing';

import { ListSupplierSitesQuery } from '../../queries/list-supplier-sites.query';
import { ListSupplierSitesHandler } from '../list-supplier-sites.handler';

describe('ListSupplierSitesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const supplierId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns supplier sites read through the tenant boundary, preferred first', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const sites = [
      { id: 'ssite-1', tenantId, supplierId, isPreferred: true },
      { id: 'ssite-2', tenantId, supplierId, isPreferred: false },
    ];
    (mockManager.find as jest.Mock).mockResolvedValueOnce(sites);

    const handler = new ListSupplierSitesHandler(mockDataSource);
    const result = await handler.execute(new ListSupplierSitesQuery(supplierId, tenantId));

    expect(result).toBe(sites);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, supplierId },
      order: {
        isPreferred: 'DESC',
        createdAt: 'ASC',
      },
    });
  });
});
