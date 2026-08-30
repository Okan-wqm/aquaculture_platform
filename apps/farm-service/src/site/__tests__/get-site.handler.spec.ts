import { ForbiddenException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { GetSiteHandler } from '../handlers/get-site.handler';
import { GetSiteQuery } from '../queries/get-site.query';

describe('GetSiteHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const caller = {
    sub: 'user-1',
    roles: [Role.MODULE_USER],
    assignedSiteIds: ['site-1'],
  };

  it('reads the site through the tenant boundary and returns it', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const site = { id: 'site-1', tenantId, name: 'Alpha' };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(site);

    const handler = new GetSiteHandler(mockDataSource, new SiteAuthorizationService());
    const result = await handler.execute(new GetSiteQuery('site-1', tenantId, caller));

    expect(result).toBe(site);
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'site-1', tenantId },
    });
  });

  it('returns null when the site genuinely does not exist (not a masked context failure)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetSiteHandler(mockDataSource, new SiteAuthorizationService());
    const result = await handler.execute(
      new GetSiteQuery('missing', tenantId, {
        ...caller,
        assignedSiteIds: ['missing'],
      }),
    );

    expect(result).toBeNull();
  });

  it('rejects an unassigned MODULE_USER before opening a database boundary', async () => {
    const { mockDataSource } = createMockDataSource();
    const handler = new GetSiteHandler(mockDataSource, new SiteAuthorizationService());

    await expect(
      handler.execute(
        new GetSiteQuery('site-2', tenantId, {
          ...caller,
          assignedSiteIds: ['site-1'],
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});
