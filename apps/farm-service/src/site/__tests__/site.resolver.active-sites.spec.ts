import { Role } from '@aquaculture/backend-common/decorators';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommandBus, QueryBus } from '@platform/cqrs';

import { RestoreService } from '../../common/services/restore.service';
import {
  ACTIVE_SITE_COLLECTION_HARD_CAP,
  ActiveSiteCollectionLimitExceededError,
} from '../handlers/get-active-site-access-catalog.handler';
import { ListSitesQuery } from '../queries/list-sites.query';
import { Site } from '../entities/site.entity';
import { SiteResolver } from '../site.resolver';

describe('SiteResolver activeSites compatibility contract', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const caller: SiteScopeCaller = {
    sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    roles: [Role.MODULE_USER],
    assignedSiteIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
  };
  let moduleRef: TestingModule;
  let resolver: SiteResolver;
  let queryBus: { execute: jest.Mock };

  beforeEach(async () => {
    queryBus = { execute: jest.fn() };
    moduleRef = await Test.createTestingModule({
      providers: [
        SiteResolver,
        { provide: CommandBus, useValue: { execute: jest.fn() } },
        { provide: QueryBus, useValue: queryBus },
        { provide: getRepositoryToken(Site), useValue: {} },
        { provide: RestoreService, useValue: {} },
      ],
    }).compile();
    resolver = moduleRef.get(SiteResolver);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('retains the role-scoped operational API with a stable bounded query', async () => {
    const site = { id: caller.assignedSiteIds?.[0], name: 'Fjord Alpha' };
    queryBus.execute.mockResolvedValue({
      data: [site],
      pagination: {
        page: 1,
        limit: ACTIVE_SITE_COLLECTION_HARD_CAP + 1,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    await expect(resolver.activeSites(tenantId, caller)).resolves.toEqual([site]);

    const query = queryBus.execute.mock.calls[0]?.[0];
    expect(query).toBeInstanceOf(ListSitesQuery);
    expect(query).toMatchObject({
      tenantId,
      caller,
      filter: { isActive: true },
      pagination: {
        page: 1,
        limit: ACTIVE_SITE_COLLECTION_HARD_CAP + 1,
        sortBy: 'id',
        sortOrder: 'ASC',
      },
    });
  });

  it.each([
    {
      name: 'the collection exceeds the hard cap',
      dataLength: 1,
      total: ACTIVE_SITE_COLLECTION_HARD_CAP + 1,
    },
    { name: 'the data and count snapshots disagree', dataLength: 1, total: 2 },
  ])('fails closed when $name', async ({ dataLength, total }) => {
    queryBus.execute.mockResolvedValue({
      data: Array.from({ length: dataLength }, (_, index) => ({ id: String(index) })),
      pagination: {
        page: 1,
        limit: ACTIVE_SITE_COLLECTION_HARD_CAP + 1,
        total,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    await expect(resolver.activeSites(tenantId, caller)).rejects.toBeInstanceOf(
      ActiveSiteCollectionLimitExceededError,
    );
  });
});
