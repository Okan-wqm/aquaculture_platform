import { createMockDataSource } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { ListSitesHandler } from '../handlers/list-sites.handler';
import { ListSitesQuery } from '../queries/list-sites.query';

describe('ListSitesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const manager = {
    sub: 'manager-1',
    roles: [Role.MODULE_MANAGER],
  };

  const makeQb = (result: [unknown[], number]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue(result),
  });

  it('returns paginated sites read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const sites = [
      { id: 'site-1', tenantId },
      { id: 'site-2', tenantId },
    ];
    const qb = makeQb([sites, 2]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSitesHandler(mockDataSource, new SiteAuthorizationService());
    const result = await handler.execute(
      new ListSitesQuery(tenantId, manager, undefined, { page: 1, limit: 20 }),
    );

    expect(result.data).toHaveLength(2);
    expect(result.pagination.total).toBe(2);
    expect(qb.where).toHaveBeenCalledWith('site.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('site.isDeleted = :isDeleted', {
      isDeleted: false,
    });
  });

  it('falls back to a safe sort column for an unknown sortBy (SQL-injection guard)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([[], 0]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSitesHandler(mockDataSource, new SiteAuthorizationService());
    await handler.execute(
      new ListSitesQuery(tenantId, manager, undefined, {
        sortBy: 'evil; DROP TABLE',
        sortOrder: 'ASC',
      }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('site.createdAt', 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('site.id', 'ASC');
  });

  it('supports stable id ordering for exhaustive catalog pagination', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([[], 0]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSitesHandler(mockDataSource, new SiteAuthorizationService());
    await handler.execute(
      new ListSitesQuery(
        tenantId,
        manager,
        { isActive: true },
        {
          page: 2,
          limit: 100,
          sortBy: 'id',
          sortOrder: 'ASC',
        },
      ),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('site.id', 'ASC');
    expect(qb.addOrderBy).not.toHaveBeenCalled();
    expect(qb.skip).toHaveBeenCalledWith(100);
    expect(qb.take).toHaveBeenCalledWith(100);
  });

  it('applies assignedSiteIds in the database query for MODULE_USER', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([[{ id: 'site-2', tenantId }], 1]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSitesHandler(mockDataSource, new SiteAuthorizationService());
    await handler.execute(
      new ListSitesQuery(
        tenantId,
        {
          sub: 'user-1',
          roles: [Role.MODULE_USER],
          assignedSiteIds: ['site-2', 'site-3'],
        },
        undefined,
        { page: 1, limit: 20 },
      ),
    );

    expect(qb.andWhere).toHaveBeenCalledWith('site.id IN (:...authorizedSiteIds)', {
      authorizedSiteIds: ['site-2', 'site-3'],
    });
  });

  it('applies the region filter declared by SiteFilterInput', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([[], 0]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListSitesHandler(mockDataSource, new SiteAuthorizationService());
    await handler.execute(
      new ListSitesQuery(tenantId, manager, { region: 'Vestland' }, { page: 1, limit: 20 }),
    );

    expect(qb.andWhere).toHaveBeenCalledWith('site.region = :region', {
      region: 'Vestland',
    });
  });

  it.each([
    ['absent', undefined],
    ['empty', []],
  ])(
    'fails closed in the database query when assignedSiteIds is %s',
    async (_label, assignedSiteIds) => {
      const { mockDataSource, mockManager } = createMockDataSource();
      const qb = makeQb([[], 0]);
      mockManager.createQueryBuilder = jest
        .fn()
        .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

      const handler = new ListSitesHandler(mockDataSource, new SiteAuthorizationService());
      await handler.execute(
        new ListSitesQuery(tenantId, {
          sub: 'user-1',
          roles: [Role.MODULE_USER],
          assignedSiteIds,
        }),
      );

      expect(qb.andWhere).toHaveBeenCalledWith('1 = 0');
    },
  );
});
