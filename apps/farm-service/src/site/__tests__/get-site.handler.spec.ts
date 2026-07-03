import { createMockDataSource } from '@aquaculture/testing';

import { GetSiteHandler } from '../handlers/get-site.handler';
import { GetSiteQuery } from '../queries/get-site.query';

describe('GetSiteHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('reads the site through the tenant boundary and returns it', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const site = { id: 'site-1', tenantId, name: 'Alpha' };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(site);

    const handler = new GetSiteHandler(mockDataSource);
    const result = await handler.execute(new GetSiteQuery('site-1', tenantId));

    expect(result).toBe(site);
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'site-1', tenantId },
    });
  });

  it('returns null when the site genuinely does not exist (not a masked context failure)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetSiteHandler(mockDataSource);
    const result = await handler.execute(new GetSiteQuery('missing', tenantId));

    expect(result).toBeNull();
  });
});
