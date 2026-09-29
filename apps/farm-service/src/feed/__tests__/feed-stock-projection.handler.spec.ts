/**
 * Create/UpdateFeedHandler — the catalog stock projection (FARM-HIGH-337).
 *
 * WHY: the handlers were a second writer of `feeds.quantity` / stock status,
 * and a minStock edit left the derived band stale. WHAT this pins:
 *   - neither handler writes `quantity` itself;
 *   - create calls CatalogStockProjector.project(manager, tenant, FEED, id)
 *     AFTER its own save; update saves inside StockTierWatch (V-B1-5), which
 *     re-projects after the save — both inside the same transaction;
 *   - the returned row is the projected one.
 */
import { collaborator, createMockDataSource, stub, stubMember } from '@aquaculture/testing';
import type { Repository } from 'typeorm';

import { CreateFeedCommand } from '../commands/create-feed.command';
import { UpdateFeedCommand } from '../commands/update-feed.command';
import { Feed, FeedStatus, FeedType } from '../entities/feed.entity';
import { FeedSite } from '../entities/feed-site.entity';
import { CreateFeedHandler } from '../handlers/create-feed.handler';
import { UpdateFeedHandler } from '../handlers/update-feed.handler';
import { Site } from '../../site/entities/site.entity';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import { CatalogStockProjector } from '../../storage/services/catalog-stock-projector.service';
import { StockTierWatch } from '../../storage/services/low-stock/stock-tier-watch.service';
import type { TierWatchScope } from '../../storage/services/low-stock/stock-tier-watch.service';
import { StorageItemType } from '../../storage/entities/storage-inventory.entity';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEED_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SITE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** An in-memory table: `findOne` by `where.id`, `save` stores a copy. */
function tableDouble<T extends { id: string }>(rows: T[], newId: string) {
  const store = new Map<string, T>(rows.map((row) => [row.id, row]));
  const save = jest.fn(async (entity: T) => {
    const row = { ...entity, id: entity.id ?? newId };
    store.set(row.id, row);
    return row;
  });
  const findOne = jest.fn(async (options: { where: { id?: unknown } }) =>
    typeof options.where.id === 'string' ? (store.get(options.where.id) ?? null) : null,
  );
  const repo = stub<Repository<T>>({
    findOne: stubMember<Repository<T>['findOne']>(findOne),
    create: stubMember<Repository<T>['create']>(jest.fn((entity: T) => entity)),
    save: stubMember<Repository<T>['save']>(save),
  });
  return { repo, save, store };
}

function harness(feeds: Feed[]) {
  const { mockDataSource, mockManager, mockQueryRunner } = createMockDataSource();
  const feedTable = tableDouble<Feed>(feeds, FEED_ID);
  const feedSiteTable = tableDouble<FeedSite>([], 'feed-site-1');
  const siteTable = tableDouble<Site>(
    [stub<Site>({ id: SITE_ID, tenantId: TENANT, isDeleted: false })],
    SITE_ID,
  );
  const repos = new Map<unknown, unknown>([
    [Feed, feedTable.repo],
    [FeedSite, feedSiteTable.repo],
    [Site, siteTable.repo],
  ]);
  mockManager.getRepository.mockImplementation(
    stubMember<typeof mockManager.getRepository>(
      (target: unknown) =>
        repos.get(target) ?? collaborator<Repository<Feed>>({}, `Repository<${String(target)}>`),
    ),
  );
  // The projection double stands in for the ledger: it rewrites the stored
  // row's quantity + band the way CatalogStockProjector would.
  const project = jest.fn(async (_m: unknown, _t: string, _type: StorageItemType, id: string) => {
    const row = feedTable.store.get(id);
    if (!row) return;
    row.quantity = 40;
    row.status = FeedStatus.LOW_STOCK;
  });
  const projector = collaborator<CatalogStockProjector>({ project }, 'CatalogStockProjector');
  // The tier-watch double runs the command, then re-projects every watched
  // item the way StockTierWatch does (its crossings are pinned in
  // storage/__tests__/stock-tier-watch.service.spec.ts).
  const around = jest.fn();
  around.mockImplementation(
    async (
      manager: unknown,
      tenantId: string,
      scope: TierWatchScope<unknown>,
      command: () => Promise<unknown>,
    ): Promise<unknown> => {
      const result = await command();
      for (const item of scope.items) await project(manager, tenantId, item.itemType, item.itemId);
      return result;
    },
  );
  const tierWatch = collaborator<StockTierWatch>({ around }, 'StockTierWatch');
  const finance = collaborator<FinanceSettingsService>(
    { getDefaultCurrency: jest.fn().mockResolvedValue('NOK') },
    'FinanceSettingsService',
  );
  return {
    create: new CreateFeedHandler(mockDataSource, finance, projector),
    update: new UpdateFeedHandler(mockDataSource, tierWatch),
    mockManager,
    mockQueryRunner,
    feedTable,
    feedSiteTable,
    project,
    around,
  };
}

const EXISTING = stub<Feed>({
  id: FEED_ID,
  tenantId: TENANT,
  name: 'Starter Pellet',
  code: 'ST-01',
  quantity: 40,
  minStock: 10,
  status: FeedStatus.AVAILABLE,
});

describe('Feed handlers — catalog stock projection (FARM-HIGH-337)', () => {
  it('update: re-projects FEED after a minStock change and never writes quantity', async () => {
    // SCENARIO: minStock rises from 10 to 50 over 40 kg on hand.
    // EXPECTS: saved row keeps quantity 40, project(FEED) runs after the save,
    // and the returned row is the projected (LOW_STOCK) one.
    const h = harness([EXISTING]);

    const result = await h.update.execute(
      new UpdateFeedCommand(FEED_ID, { id: FEED_ID, minStock: 50 }, TENANT, USER),
    );

    const saved = h.feedTable.save.mock.calls[0]![0];
    expect(saved.minStock).toBe(50);
    expect(saved.quantity).toBe(40);
    expect(h.project).toHaveBeenCalledWith(h.mockManager, TENANT, StorageItemType.FEED, FEED_ID);
    // V-B1-5: the save runs inside StockTierWatch, scoped to this item and
    // caused by it, so a raised minStock signals its pool crossing.
    expect(h.around).toHaveBeenCalledWith(
      h.mockManager,
      TENANT,
      expect.objectContaining({ items: [{ itemType: StorageItemType.FEED, itemId: FEED_ID }] }),
      expect.any(Function),
    );
    expect(h.around.mock.calls[0]![2].causationId(undefined)).toBe(FEED_ID);
    expect(h.feedTable.save.mock.invocationCallOrder[0]).toBeLessThan(
      h.project.mock.invocationCallOrder[0]!,
    );
    expect(result.status).toBe(FeedStatus.LOW_STOCK);
  });

  it('update: persists a lifecycle status before projecting', async () => {
    // SCENARIO: operator discontinues the feed. EXPECTS: DISCONTINUED saved, projected once.
    const h = harness([EXISTING]);

    await h.update.execute(
      new UpdateFeedCommand(
        FEED_ID,
        { id: FEED_ID, status: FeedStatus.DISCONTINUED },
        TENANT,
        USER,
      ),
    );

    expect(h.feedTable.save.mock.calls[0]![0].status).toBe(FeedStatus.DISCONTINUED);
    expect(h.project).toHaveBeenCalledTimes(1);
  });

  it('update: a projector failure rolls the edit back', async () => {
    // SCENARIO: the projection throws. EXPECTS: rollback, no commit — same transaction.
    const h = harness([EXISTING]);
    h.project.mockRejectedValueOnce(new Error('ledger read failed'));

    await expect(
      h.update.execute(new UpdateFeedCommand(FEED_ID, { id: FEED_ID, minStock: 5 }, TENANT, USER)),
    ).rejects.toThrow('ledger read failed');
    expect(h.mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(h.mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('create: writes no quantity and projects FEED after the catalog rows', async () => {
    // SCENARIO: a new feed. EXPECTS: no `quantity` in the insert (column default),
    // project(FEED, newId) after the feed + feed-site saves, projected row returned.
    const h = harness([]);

    const result = await h.create.execute(
      new CreateFeedCommand(
        { name: 'Grower', code: 'gr-02', type: FeedType.GROWER, siteId: SITE_ID, minStock: 25 },
        TENANT,
        USER,
      ),
    );

    expect(h.feedTable.save.mock.calls[0]![0]).not.toHaveProperty('quantity');
    expect(h.project).toHaveBeenCalledWith(h.mockManager, TENANT, StorageItemType.FEED, FEED_ID);
    expect(h.feedSiteTable.save.mock.invocationCallOrder[0]).toBeLessThan(
      h.project.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ id: FEED_ID, status: FeedStatus.LOW_STOCK });
  });
});
