import { createMockDataSource } from '@aquaculture/testing';

import { GetPendingDeliveriesQuery } from '../queries/get-pending-deliveries.query';
import { GetPendingDeliveriesHandler } from '../handlers/get-pending-deliveries.handler';

describe('GetPendingDeliveriesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('returns pending deliveries read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'po1' }]);

    const handler = new GetPendingDeliveriesHandler(mockDataSource);
    const result = await handler.execute(new GetPendingDeliveriesQuery(tenantId));

    expect(result).toEqual([{ id: 'po1' }]);
    const [, options] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(options.where.tenantId).toBe(tenantId);
    expect(options.where.isDeleted).toBe(false);
    expect(options.relations).toEqual(['items']);
    expect(options.order).toEqual({ expectedDeliveryDate: 'ASC' });
  });
});
