import { createMockDataSource } from '@aquaculture/testing';

import { GetHarvestQuery } from '../../queries/get-harvest.query';
import { GetHarvestHandler } from '../../handlers/get-harvest.handler';

describe('GetHarvestHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const harvestRecordId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the harvest record read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: harvestRecordId, tenantId });

    const handler = new GetHarvestHandler(mockDataSource);
    const result = await handler.execute(new GetHarvestQuery(tenantId, harvestRecordId));

    expect(result).toEqual({ id: harvestRecordId, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: harvestRecordId, tenantId },
    });
  });

  it('returns null when no harvest record matches', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetHarvestHandler(mockDataSource);
    const result = await handler.execute(new GetHarvestQuery(tenantId, harvestRecordId));

    expect(result).toBeNull();
  });
});
