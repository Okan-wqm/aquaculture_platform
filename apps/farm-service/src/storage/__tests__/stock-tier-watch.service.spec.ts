/**
 * StockTierWatch — the low-stock edge trigger for commands that move a tier
 * WITHOUT moving stock (V-B1-5 of the B1a-1 verifier round).
 *
 * London School: the evaluator, the lock authority, the projector and the
 * outbox are doubled; the reads behind the evaluator are proven against real
 * Postgres in __tests__/e2e/low-stock-ledger.postgres.spec.ts, which also
 * drives the real watch through the real command handlers.
 */
import { stub } from '@aquaculture/testing';
import type { OutboxPublisher } from '@platform/outbox';
import { EntityManager, ObjectLiteral, Repository } from 'typeorm';

import { Feed } from '../../feed/entities/feed.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { CatalogStockProjector } from '../services/catalog-stock-projector.service';
import { LowStockEvaluator } from '../services/low-stock/low-stock-evaluator.service';
import type {
  ItemStockEvaluation,
  PoolStockReading,
  SiteStockReading,
} from '../services/low-stock/low-stock.types';
import { StockTierWatch, worsenedTiers } from '../services/low-stock/stock-tier-watch.service';
import { StockMutationLockAuthority } from '../services/stock-mutation-lock.authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const POLICY = '44444444-4444-4444-8444-444444444444';
const feedKey = { itemType: StorageItemType.FEED, itemId: FEED };

function pool(band: PoolStockReading['band'], onHand: number, threshold = 100): PoolStockReading {
  return { level: 'pool', ...feedKey, onHand, onOrder: 0, threshold, band };
}

function site(band: SiteStockReading['band'], onHand: number, threshold = 50): SiteStockReading {
  return { level: 'site', ...feedKey, siteId: SITE_A, onHand, threshold, band };
}

function tenantMetadata<T extends ObjectLiteral>(): Repository<T>['metadata'] {
  const tenantColumn = stub<
    NonNullable<ReturnType<Repository<T>['metadata']['findColumnWithPropertyName']>>
  >({ databaseName: 'tenant_id' });
  return stub<Repository<T>['metadata']>({
    findColumnWithPropertyName: jest.fn((name: string) =>
      name === 'tenantId' ? tenantColumn : undefined,
    ),
  });
}

function harness(
  evaluations: ItemStockEvaluation[],
  feed: Partial<Feed> | null = {},
): {
  watch: StockTierWatch;
  manager: EntityManager;
  order: string[];
  enqueue: jest.Mock;
  project: jest.Mock;
  acquire: jest.Mock;
} {
  const order: string[] = [];
  const evaluateItem = jest.fn();
  for (const evaluation of evaluations) {
    evaluateItem.mockImplementationOnce(async () => {
      order.push('snapshot');
      return evaluation;
    });
  }
  const acquire = jest.fn();
  acquire.mockImplementation(async () => {
    order.push('lock');
  });
  const project = jest.fn();
  project.mockImplementation(async () => {
    order.push('project');
  });
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const feedRow =
    feed === null
      ? null
      : { id: FEED, tenantId: TENANT, name: 'Grower 4mm', unit: 'kg', minStock: 100, ...feed };
  const getRepository = jest.fn();
  getRepository.mockImplementation((): unknown =>
    stub<Repository<Feed>>({
      metadata: tenantMetadata<Feed>(),
      findOne: jest.fn().mockResolvedValue(feedRow),
    }),
  );
  const watch = new StockTierWatch(
    stub<LowStockEvaluator>({ evaluateItem }),
    stub<StockMutationLockAuthority>({ acquire }),
    stub<CatalogStockProjector>({ project }),
    stub<OutboxPublisher>({ enqueue }),
  );
  return {
    watch,
    manager: stub<EntityManager>({ getRepository }),
    order,
    enqueue,
    project,
    acquire,
  };
}

describe('worsenedTiers', () => {
  it('reports only the tiers whose band got worse, a missing tier counting as ok', () => {
    // SCENARIO: pool ok → low; site absent (dormant or new policy) → out; a
    // second pass where the site disappears. EXPECTS: pool and site crossings;
    // a vanished tier emits nothing.
    const before = new Map([['pool', pool('ok', 150)]]);
    const after = new Map<string, PoolStockReading | SiteStockReading>([
      ['pool', pool('low_stock', 150, 200)],
      [`site:${SITE_A}`, site('out_of_stock', 0)],
    ]);

    expect(worsenedTiers(before, after)).toEqual([
      { before: 'ok', severity: 'low_stock', reading: after.get('pool') },
      { before: 'ok', severity: 'out_of_stock', reading: after.get(`site:${SITE_A}`) },
    ]);
    expect(worsenedTiers(after, new Map([['pool', pool('low_stock', 150, 200)]]))).toEqual([]);
  });
});

describe('StockTierWatch.around', () => {
  it('locks, snapshots, runs the command, then emits each worsened tier once and re-projects', async () => {
    // SCENARIO: a site minimum is raised from 50 to 150 over 120 kg at site A.
    // EXPECTS: order lock → snapshot → command → snapshot → project; exactly one
    // LowStockDetected (site, low_stock) caused by the policy row.
    const { watch, manager, order, enqueue, acquire, project } = harness([
      { pool: pool('ok', 500), sites: [site('ok', 120, 50)] },
      { pool: pool('ok', 500), sites: [site('low_stock', 120, 150)] },
    ]);

    const result = await watch.around(
      manager,
      TENANT,
      { items: [feedKey], causationId: (saved: { id: string }) => saved.id },
      async () => {
        order.push('command');
        return { id: POLICY };
      },
    );

    expect(result).toEqual({ id: POLICY });
    expect(acquire).toHaveBeenCalledWith(manager, TENANT, [feedKey]);
    expect(order).toEqual(['lock', 'snapshot', 'command', 'snapshot', 'project']);
    expect(project).toHaveBeenCalledWith(manager, TENANT, StorageItemType.FEED, FEED);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      eventType: 'LowStockDetected',
      level: 'site',
      siteId: SITE_A,
      itemId: FEED,
      itemName: 'Grower 4mm',
      severity: 'low_stock',
      currentQuantity: 120,
      minimumThreshold: 150,
      causationId: POLICY,
    });
    expect(enqueue.mock.calls[0][1]).toBe(manager);
  });

  it('emits nothing when the command leaves every band where it was', async () => {
    // SCENARIO: an already-low pool stays low after a minStock edit. EXPECTS: no event, re-projected.
    const { watch, manager, enqueue, project } = harness([
      { pool: pool('low_stock', 80), sites: [] },
      { pool: pool('low_stock', 80, 120), sites: [] },
    ]);

    await watch.around(
      manager,
      TENANT,
      { items: [feedKey], causationId: () => FEED },
      async () => 1,
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('keys HEALTHCARE and CONSUMABLE of one row as one item (one lock, one snapshot pair)', async () => {
    // SCENARIO: a purchase order lists the same consumable twice, once under each ledger type.
    // EXPECTS: one canonical CONSUMABLE key locked and evaluated once before and once after.
    const { watch, manager, acquire } = harness([
      { pool: pool('ok', 10), sites: [] },
      { pool: pool('ok', 10), sites: [] },
    ]);
    const consumableKey = { itemType: StorageItemType.CONSUMABLE, itemId: FEED };

    await watch.around(
      manager,
      TENANT,
      {
        items: [consumableKey, { itemType: StorageItemType.HEALTHCARE, itemId: FEED }],
        causationId: () => FEED,
      },
      async () => 1,
    );

    expect(acquire).toHaveBeenCalledWith(manager, TENANT, [consumableKey]);
  });
});
