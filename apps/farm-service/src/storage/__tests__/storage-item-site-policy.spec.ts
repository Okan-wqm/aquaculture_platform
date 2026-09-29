/**
 * Per-site stock policy CRUD (plan K8 tier 1, FARM-HIGH-336): handlers,
 * site-scoped listing and the manager gate on writes.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDataSource, stub } from '@aquaculture/testing';
import { Role, ROLES_KEY } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import type { Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { Site } from '../../site/entities/site.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { StorageItemSitePolicy } from '../entities/storage-item-site-policy.entity';
import { UpsertStorageItemSitePolicyHandler } from '../handlers/upsert-storage-item-site-policy.handler';
import { DeleteStorageItemSitePolicyHandler } from '../handlers/delete-storage-item-site-policy.handler';
import { ListStorageItemSitePoliciesHandler } from '../handlers/list-storage-item-site-policies.handler';
import { UpsertStorageItemSitePolicyCommand } from '../commands/upsert-storage-item-site-policy.command';
import { DeleteStorageItemSitePolicyCommand } from '../commands/delete-storage-item-site-policy.command';
import { ListStorageItemSitePoliciesQuery } from '../queries/list-storage-item-site-policies.query';
import { StorageItemSitePolicyResolver } from '../resolvers/storage-item-site-policy.resolver';
import { MUTATION_ROLES, QUERY_ROLES } from '../../common/authz/permission-matrix';
import { StockMutationLockAuthority } from '../services/stock-mutation-lock.authority';
import { UpsertStorageItemSitePolicyInput } from '../dto/storage-item-site-policy.input';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADMIN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_ADMIN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

interface Repos {
  site?: Partial<Site> | null;
  feed?: Partial<Feed> | null;
  policy?: StorageItemSitePolicy | null;
  policies?: StorageItemSitePolicy[];
}

function harness(repos: Repos): {
  dataSource: ReturnType<typeof createMockDataSource>['mockDataSource'];
  locks: StockMutationLockAuthority;
  acquire: jest.Mock;
  order: string[];
  policySave: jest.Mock;
  policyRemove: jest.Mock;
  policyFind: jest.Mock;
} {
  const { mockDataSource, mockManager } = createMockDataSource();
  // Call log shared by the lock double and the policy read: proves the order.
  const order: string[] = [];
  const acquire = jest.fn();
  acquire.mockImplementation(async () => {
    order.push('lock');
  });
  const policyFindOne = jest.fn();
  policyFindOne.mockImplementation(async () => {
    order.push('read');
    return repos.policy ?? null;
  });
  const policySave = jest.fn();
  policySave.mockImplementation(async (row: StorageItemSitePolicy) => row);
  const policyRemove = jest.fn().mockResolvedValue(undefined);
  const policyFind = jest.fn().mockResolvedValue(repos.policies ?? []);
  const policyCreate = jest.fn();
  policyCreate.mockImplementation((row: Partial<StorageItemSitePolicy>) =>
    stub<StorageItemSitePolicy>({ ...row }),
  );
  const byEntity = new Map<unknown, unknown>([
    [Site, stub<Repository<Site>>({ findOne: jest.fn().mockResolvedValue(repos.site ?? null) })],
    [Feed, stub<Repository<Feed>>({ findOne: jest.fn().mockResolvedValue(repos.feed ?? null) })],
    [
      StorageItemSitePolicy,
      stub<Repository<StorageItemSitePolicy>>({
        findOne: policyFindOne,
        find: policyFind,
        save: policySave,
        create: policyCreate,
        remove: policyRemove,
      }),
    ],
  ]);
  (mockManager.getRepository as jest.Mock).mockImplementation((entity: unknown): unknown => {
    const repo = byEntity.get(entity);
    if (!repo) throw new Error(`unexpected repository ${String(entity)}`);
    return repo;
  });
  return {
    dataSource: mockDataSource,
    locks: stub<StockMutationLockAuthority>({ acquire }),
    acquire,
    order,
    policySave,
    policyRemove,
    policyFind,
  };
}

const input = { siteId: SITE_A, itemType: StorageItemType.FEED, itemId: FEED, minStock: 250 };
const liveSite = { id: SITE_A, tenantId: TENANT, isDeleted: false };
const liveFeed = { id: FEED, tenantId: TENANT, name: 'Skretting 3mm', unit: 'kg', minStock: 0 };

describe('UpsertStorageItemSitePolicyHandler', () => {
  it('creates a policy stamped with its author', async () => {
    // SCENARIO: no policy yet for (site A, feed). EXPECTS: insert with createdBy = updatedBy = caller,
    // after the item lock (so two concurrent first inserts cannot both read "none").
    const { dataSource, locks, acquire, order, policySave } = harness({
      site: liveSite,
      feed: liveFeed,
    });

    await new UpsertStorageItemSitePolicyHandler(dataSource, locks).execute(
      new UpsertStorageItemSitePolicyCommand(input, TENANT, ADMIN),
    );

    // The first-insert race is closed by the item lock, taken BEFORE the read.
    expect(acquire).toHaveBeenCalledWith(expect.anything(), TENANT, [
      { itemType: StorageItemType.FEED, itemId: FEED },
    ]);
    expect(order).toEqual(['lock', 'read']);

    expect(policySave).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        siteId: SITE_A,
        itemId: FEED,
        minStock: 250,
        createdBy: ADMIN,
        updatedBy: ADMIN,
      }),
    );
  });

  it('updates the existing (site, item) policy instead of duplicating it', async () => {
    // SCENARIO: a policy exists by another admin. EXPECTS: same row, new minimum, updatedBy changes, createdBy kept.
    const existing = stub<StorageItemSitePolicy>({
      id: 'p1',
      ...input,
      tenantId: TENANT,
      minStock: 100,
      createdBy: OTHER_ADMIN,
      updatedBy: OTHER_ADMIN,
    });
    const { dataSource, locks, policySave } = harness({
      site: liveSite,
      feed: liveFeed,
      policy: existing,
    });

    await new UpsertStorageItemSitePolicyHandler(dataSource, locks).execute(
      new UpsertStorageItemSitePolicyCommand(input, TENANT, ADMIN),
    );

    expect(policySave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'p1',
        minStock: 250,
        createdBy: OTHER_ADMIN,
        updatedBy: ADMIN,
      }),
    );
  });

  it('rejects a deleted site and an unknown item', async () => {
    // SCENARIO: soft-deleted site; then a live site with no such feed. EXPECTS: 400, then 404; nothing saved.
    const deleted = harness({ site: { ...liveSite, isDeleted: true }, feed: liveFeed });
    await expect(
      new UpsertStorageItemSitePolicyHandler(deleted.dataSource, deleted.locks).execute(
        new UpsertStorageItemSitePolicyCommand(input, TENANT, ADMIN),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deleted.policySave).not.toHaveBeenCalled();

    const missingItem = harness({ site: liveSite, feed: null });
    await expect(
      new UpsertStorageItemSitePolicyHandler(missingItem.dataSource, missingItem.locks).execute(
        new UpsertStorageItemSitePolicyCommand(input, TENANT, ADMIN),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DeleteStorageItemSitePolicyHandler', () => {
  it('removes the policy, and 404s an unknown id', async () => {
    // SCENARIO: delete existing, then missing. EXPECTS: remove called once; then NotFound.
    const existing = stub<StorageItemSitePolicy>({ id: 'p1', tenantId: TENANT });
    const found = harness({ policy: existing });
    await expect(
      new DeleteStorageItemSitePolicyHandler(found.dataSource).execute(
        new DeleteStorageItemSitePolicyCommand('p1', TENANT),
      ),
    ).resolves.toBe(true);
    expect(found.policyRemove).toHaveBeenCalledWith(existing);

    const missing = harness({ policy: null });
    await expect(
      new DeleteStorageItemSitePolicyHandler(missing.dataSource).execute(
        new DeleteStorageItemSitePolicyCommand('nope', TENANT),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ListStorageItemSitePoliciesHandler (site-scoped reads)', () => {
  const siteAuth = new SiteAuthorizationService();

  it('scopes a MODULE_USER to their assigned sites', async () => {
    // SCENARIO: worker assigned to A. EXPECTS: query restricted to site A.
    const { dataSource, policyFind } = harness({});
    await new ListStorageItemSitePoliciesHandler(dataSource, siteAuth).execute(
      new ListStorageItemSitePoliciesQuery(
        TENANT,
        { sub: 'w', roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] },
        {},
      ),
    );
    const where = policyFind.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
    expect(where.siteId.value).toEqual([SITE_A]);
  });

  it('returns nothing for a site outside the assignment, without querying', async () => {
    // SCENARIO: worker assigned to A asks for B. EXPECTS: [] and no read (fail-closed).
    const { dataSource, policyFind } = harness({});
    const rows = await new ListStorageItemSitePoliciesHandler(dataSource, siteAuth).execute(
      new ListStorageItemSitePoliciesQuery(
        TENANT,
        { sub: 'w', roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] },
        { siteId: SITE_B },
      ),
    );
    expect(rows).toEqual([]);
    expect(policyFind).not.toHaveBeenCalled();
  });

  it('lets a manager filter any site', async () => {
    // SCENARIO: MODULE_MANAGER filters site B + item. EXPECTS: exact filter, no assignment restriction.
    const { dataSource, policyFind } = harness({});
    await new ListStorageItemSitePoliciesHandler(dataSource, siteAuth).execute(
      new ListStorageItemSitePoliciesQuery(
        TENANT,
        { sub: 'm', roles: [Role.MODULE_MANAGER] },
        { siteId: SITE_B, itemId: FEED },
      ),
    );
    expect(policyFind.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      siteId: SITE_B,
      itemId: FEED,
    });
  });

  it('finds a consumable policy when filtered by its HEALTHCARE spelling', async () => {
    // SCENARIO: the upsert stores a HEALTHCARE policy under the canonical
    // CONSUMABLE type; a list filtered by HEALTHCARE. EXPECTS: the query asks
    // for CONSUMABLE, so the stored policy is found instead of silently missed.
    const { dataSource, policyFind } = harness({});
    await new ListStorageItemSitePoliciesHandler(dataSource, siteAuth).execute(
      new ListStorageItemSitePoliciesQuery(
        TENANT,
        { sub: 'm', roles: [Role.MODULE_MANAGER] },
        { itemType: StorageItemType.HEALTHCARE },
      ),
    );
    expect(policyFind.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      itemType: StorageItemType.CONSUMABLE,
    });
  });
});

describe('StorageItemSitePolicyResolver authorization', () => {
  const rolesOf = (method: keyof StorageItemSitePolicyResolver): Role[] =>
    Reflect.getMetadata(ROLES_KEY, StorageItemSitePolicyResolver.prototype[method]);

  it('gates writes to TENANT_ADMIN and MODULE_MANAGER, matching the permission matrix', () => {
    // SCENARIO: role metadata on the mutations. EXPECTS: managers only; MODULE_USER cannot write.
    for (const mutation of [
      'upsertStorageItemSitePolicy',
      'deleteStorageItemSitePolicy',
    ] as const) {
      expect([...rolesOf(mutation)].sort()).toEqual(
        [Role.MODULE_MANAGER, Role.TENANT_ADMIN].sort(),
      );
      expect(MUTATION_ROLES[mutation]).toEqual([Role.MODULE_MANAGER, Role.TENANT_ADMIN]);
      expect(rolesOf(mutation)).not.toContain(Role.MODULE_USER);
    }
  });

  it('opens reads to MODULE_USER (site-scoped in the handler), matching the query matrix', () => {
    // SCENARIO: role metadata on the query. EXPECTS: includes MODULE_USER, equals QUERY_ROLES.
    expect(rolesOf('storageItemSitePolicies')).toContain(Role.MODULE_USER);
    expect(QUERY_ROLES['storageItemSitePolicies']).toEqual([
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
      Role.TENANT_ADMIN,
    ]);
    expect([...rolesOf('storageItemSitePolicies')].sort()).toEqual(
      [Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN].sort(),
    );
  });
});

describe('UpsertStorageItemSitePolicyInput validation', () => {
  async function errorsFor(minStock: number): Promise<string[]> {
    const dto = plainToInstance(UpsertStorageItemSitePolicyInput, { ...input, minStock });
    return (await validate(dto)).map((error) => error.property);
  }

  it('admits only minimums numeric(15,2) stores as positive', async () => {
    // SCENARIO: 0.001 rounds to 0.00 in the column; 0 and -1 are "no policy".
    // EXPECTS: all three rejected at the input (not a raw CHECK 23514); 0.01
    // and 250.5 accepted.
    expect(await errorsFor(0.001)).toEqual(['minStock']);
    expect(await errorsFor(0)).toEqual(['minStock']);
    expect(await errorsFor(-1)).toEqual(['minStock']);
    expect(await errorsFor(0.01)).toEqual([]);
    expect(await errorsFor(250.5)).toEqual([]);
  });
});
