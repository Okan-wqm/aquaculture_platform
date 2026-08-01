import { createMockDataSource } from '@aquaculture/testing';

import {
  ACTIVE_SITE_COLLECTION_HARD_CAP,
  ActiveSiteCollectionLimitExceededError,
  GetActiveSiteAccessCatalogHandler,
} from '../handlers/get-active-site-access-catalog.handler';
import { GetActiveSiteAccessCatalogQuery } from '../queries/get-active-site-access-catalog.query';

describe('GetActiveSiteAccessCatalogHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function makeQueryBuilder(rows: unknown[]) {
    return {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
  }

  it('returns the minimal active/non-deleted catalog from one stable tenant query', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const queryBuilder = makeQueryBuilder([
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Fjord Alpha',
        code: 'A-1',
        tenantId,
        description: 'must not escape the minimal projection',
      },
    ]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(queryBuilder) as typeof mockManager.createQueryBuilder;

    const handler = new GetActiveSiteAccessCatalogHandler(mockDataSource);

    await expect(handler.execute(new GetActiveSiteAccessCatalogQuery(tenantId))).resolves.toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Fjord Alpha',
        code: 'A-1',
      },
    ]);
    expect(mockManager.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(queryBuilder.select).toHaveBeenCalledWith(['site.id', 'site.name', 'site.code']);
    expect(queryBuilder.where).toHaveBeenCalledWith('site.tenantId = :tenantId', { tenantId });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('site.isActive = :isActive', {
      isActive: true,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('site.isDeleted = :isDeleted', {
      isDeleted: false,
    });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('site.id', 'ASC');
    expect(queryBuilder.take).toHaveBeenCalledWith(ACTIVE_SITE_COLLECTION_HARD_CAP + 1);
    expect(queryBuilder.getMany).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the bounded catalog would be truncated', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const queryBuilder = makeQueryBuilder(
      Array.from({ length: ACTIVE_SITE_COLLECTION_HARD_CAP + 1 }, (_, index) => ({
        id: String(index),
        name: `Site ${index}`,
        code: `S-${index}`,
      })),
    );
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(queryBuilder) as typeof mockManager.createQueryBuilder;

    const handler = new GetActiveSiteAccessCatalogHandler(mockDataSource);

    await expect(
      handler.execute(new GetActiveSiteAccessCatalogQuery(tenantId)),
    ).rejects.toBeInstanceOf(ActiveSiteCollectionLimitExceededError);
  });
});
