/**
 * LowStockEvaluator — the ONE low-stock decision (plan K8, FARM-HIGH-335/336).
 *
 * London School: the ledger reads are doubled (`StockLedgerReader`); the SQL
 * behind them is proven against real Postgres in
 * __tests__/e2e/low-stock-ledger.postgres.spec.ts. These cases pin the
 * decisions the evaluator makes from those facts.
 */
import { EntityManager } from 'typeorm';
import { stub } from '@aquaculture/testing';

import { StorageItemType } from '../entities/storage-inventory.entity';
import { LowStockEvaluator } from '../services/low-stock/low-stock-evaluator.service';
import {
  CatalogStockRow,
  OnOrderRow,
  SiteOnHandRow,
  SitePolicyRow,
  StockLedgerReader,
} from '../services/low-stock/stock-ledger.reader';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = 'feed-1';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const manager = stub<EntityManager>({});

interface Facts {
  onHand?: SiteOnHandRow[];
  onOrder?: OnOrderRow[];
  policies?: SitePolicyRow[];
  catalog?: CatalogStockRow[];
}

function build(facts: Facts): {
  evaluator: LowStockEvaluator;
  reader: jest.Mocked<StockLedgerReader>;
} {
  const reader = stub<jest.Mocked<StockLedgerReader>>({
    onHandBySite: jest.fn().mockResolvedValue(facts.onHand ?? []),
    onOrder: jest.fn().mockResolvedValue(facts.onOrder ?? []),
    sitePolicies: jest.fn().mockResolvedValue(facts.policies ?? []),
    catalog: jest.fn().mockResolvedValue(facts.catalog ?? []),
  });
  return { evaluator: new LowStockEvaluator(reader), reader };
}

const feedKey = { itemType: StorageItemType.FEED, itemId: FEED };
const onHand = (siteId: string, qty: number, itemId = FEED): SiteOnHandRow => ({
  itemType: StorageItemType.FEED,
  itemId,
  siteId,
  onHand: qty,
});
const policy = (siteId: string, minStock: number): SitePolicyRow => ({
  ...feedKey,
  siteId,
  minStock,
});

describe('LowStockEvaluator.evaluateItem', () => {
  it('sums every site into the pool and compares each site with its own policy', async () => {
    // SCENARIO: A holds 50 (policy 200), B holds 600 (policy 100); reorder at 500.
    // EXPECTS: pool 650 ok; site A low, site B ok — "A empty, B full" is visible.
    const { evaluator } = build({
      onHand: [onHand(SITE_A, 50), onHand(SITE_B, 600)],
      policies: [policy(SITE_A, 200), policy(SITE_B, 100)],
    });

    const result = await evaluator.evaluateItem(manager, TENANT, feedKey, 500);

    expect(result.pool).toMatchObject({ onHand: 650, onOrder: 0, threshold: 500, band: 'ok' });
    expect(result.sites).toEqual([
      expect.objectContaining({ siteId: SITE_A, onHand: 50, threshold: 200, band: 'low_stock' }),
      expect.objectContaining({ siteId: SITE_B, onHand: 600, threshold: 100, band: 'ok' }),
    ]);
  });

  it('counts open purchase-order remainder toward the pool position (FARM-3)', async () => {
    // SCENARIO: 300 on hand + 250 ordered vs reorder 500. EXPECTS: pool ok.
    const { evaluator } = build({
      onHand: [onHand(SITE_A, 300)],
      onOrder: [{ ...feedKey, onOrder: 250 }],
    });

    const result = await evaluator.evaluateItem(manager, TENANT, feedKey, 500);

    expect(result.pool).toMatchObject({ onHand: 300, onOrder: 250, band: 'ok' });
  });

  it('reports a site with a policy and no stock as out of stock', async () => {
    // SCENARIO: policy at B, ledger rows only at A. EXPECTS: B on-hand 0, out_of_stock.
    const { evaluator } = build({
      onHand: [onHand(SITE_A, 300)],
      policies: [policy(SITE_B, 50)],
    });

    const result = await evaluator.evaluateItem(manager, TENANT, feedKey, 0);

    expect(result.sites).toEqual([
      expect.objectContaining({ siteId: SITE_B, onHand: 0, band: 'out_of_stock' }),
    ]);
  });
});

describe('LowStockEvaluator.listBelowThreshold', () => {
  const catalog: CatalogStockRow[] = [
    { ...feedKey, name: 'Skretting 3mm', unit: 'kg', poolReorderThreshold: 500 },
    {
      itemType: StorageItemType.FEED,
      itemId: 'feed-2',
      name: 'Uncontrolled',
      unit: 'kg',
      poolReorderThreshold: 0,
    },
    {
      itemType: StorageItemType.CONSUMABLE,
      itemId: 'cons-1',
      name: 'Vaccine',
      unit: 'dose',
      poolReorderThreshold: 20,
    },
  ];

  it('lists the low pool and every short site, most urgent first, with catalog labels', async () => {
    // SCENARIO: feed-1 pool 350/500 (low), site A empty (policy 100), site B 350
    // (policy 100, ok). EXPECTS: site A (out) first, then the pool; site B absent.
    const { evaluator } = build({
      onHand: [onHand(SITE_B, 350)],
      policies: [policy(SITE_A, 100), policy(SITE_B, 100)],
      catalog,
    });

    const rows = await evaluator.listBelowThreshold(manager, TENANT);

    expect(
      rows.map((row) => [row.level, row.itemId, row.level === 'site' ? row.siteId : null]),
    ).toEqual([
      ['site', FEED, SITE_A],
      ['pool', 'cons-1', null],
      ['pool', FEED, null],
    ]);
    expect(rows[2]).toMatchObject({
      itemName: 'Skretting 3mm',
      unit: 'kg',
      onHand: 350,
      band: 'low_stock',
    });
  });

  it('never lists an item that is not reorder-controlled at the pool tier', async () => {
    // SCENARIO: feed-2 has threshold 0 and a little stock. EXPECTS: not listed.
    const { evaluator } = build({ onHand: [onHand(SITE_A, 1, 'feed-2')], catalog });

    const rows = await evaluator.listBelowThreshold(manager, TENANT);

    expect(rows.find((row) => row.itemId === 'feed-2')).toBeUndefined();
  });

  it('skips a site policy whose catalog item no longer exists', async () => {
    // SCENARIO: policy for a deleted catalog row. EXPECTS: nothing listed for it.
    const { evaluator } = build({
      policies: [
        { itemType: StorageItemType.CHEMICAL, itemId: 'gone', siteId: SITE_A, minStock: 5 },
      ],
      catalog: [],
    });

    await expect(evaluator.listBelowThreshold(manager, TENANT)).resolves.toEqual([]);
  });
});

describe('LowStockEvaluator.crossingsForMovement (edge trigger)', () => {
  const out = (quantity: number, fromSiteId: string | null, toSiteId: string | null = null) => ({
    ...feedKey,
    quantity,
    fromSiteId,
    toSiteId,
  });

  it('reports the pool and the site when one OUT crosses both', async () => {
    // SCENARIO: A had 220 (policy 200), pool 520 (reorder 500); OUT 50 from A.
    // EXPECTS: site A ok→low and pool ok→low.
    const { evaluator } = build({
      onHand: [onHand(SITE_A, 170), onHand(SITE_B, 300)],
      policies: [policy(SITE_A, 200)],
    });

    const crossings = await evaluator.crossingsForMovement(manager, TENANT, out(50, SITE_A), 500);

    expect(crossings).toEqual([
      expect.objectContaining({
        before: 'ok',
        severity: 'low_stock',
        reading: expect.objectContaining({ level: 'pool', onHand: 470 }),
      }),
      expect.objectContaining({
        before: 'ok',
        severity: 'low_stock',
        reading: expect.objectContaining({ level: 'site', siteId: SITE_A, onHand: 170 }),
      }),
    ]);
  });

  it('stays silent when the tiers were already low before the movement', async () => {
    // SCENARIO: A 150 → 100 (policy 200), pool 400 → 350 (reorder 500). EXPECTS: no crossing.
    const { evaluator } = build({
      onHand: [onHand(SITE_A, 100), onHand(SITE_B, 250)],
      policies: [policy(SITE_A, 200)],
    });

    await expect(
      evaluator.crossingsForMovement(manager, TENANT, out(50, SITE_A), 500),
    ).resolves.toEqual([]);
  });

  it('rebuilds the band before the movement in exact hundredths (no phantom crossing)', async () => {
    // SCENARIO: site A holds 0.1 after an OUT of 0.2 against a site minimum of 0.3, so A
    // held exactly 0.3 — already AT its minimum (low) — before the movement. In doubles
    // 0.1 + 0.2 = 0.30000000000000004 > 0.3 reads "ok before", a phantom ok → low edge.
    // EXPECTS: no crossing (low → low), and the pool reading sums exactly.
    const { evaluator } = build({
      onHand: [onHand(SITE_A, 0.1), onHand(SITE_B, 0.2)],
      policies: [policy(SITE_A, 0.3)],
    });

    await expect(
      evaluator.crossingsForMovement(manager, TENANT, out(0.2, SITE_A), 0.5),
    ).resolves.toEqual([]);
  });

  it('narrows the policy read to the sites the movement shrank', async () => {
    // SCENARIO: an OUT at site A. EXPECTS: sitePolicies is asked for site A only.
    const { evaluator, reader } = build({ onHand: [onHand(SITE_A, 10)] });

    await evaluator.crossingsForMovement(manager, TENANT, out(5, SITE_A), 0);

    expect(reader.sitePolicies).toHaveBeenCalledWith(
      manager,
      TENANT,
      { kind: 'item', key: feedKey },
      [SITE_A],
    );
  });

  it('escalates low → out as a new crossing', async () => {
    // SCENARIO: pool 30 (already low) drained to 0. EXPECTS: one pool out_of_stock crossing.
    const { evaluator } = build({ onHand: [] });

    const crossings = await evaluator.crossingsForMovement(manager, TENANT, out(30, SITE_A), 500);

    expect(crossings).toEqual([
      expect.objectContaining({
        before: 'low_stock',
        severity: 'out_of_stock',
        reading: expect.objectContaining({ level: 'pool', onHand: 0 }),
      }),
    ]);
  });

  it('does not let an open order hide a physical stock-out', async () => {
    // SCENARIO: 10 on hand drained to 0 while 900 are ordered. EXPECTS: pool out_of_stock.
    const { evaluator } = build({ onHand: [], onOrder: [{ ...feedKey, onOrder: 900 }] });

    const crossings = await evaluator.crossingsForMovement(manager, TENANT, out(10, SITE_A), 500);

    expect(crossings.map((crossing) => crossing.severity)).toEqual(['out_of_stock']);
  });

  it('suppresses the pool low crossing when an open order covers the position', async () => {
    // SCENARIO: 520 → 470 on hand with 100 ordered (position 570 > 500). EXPECTS: no crossing.
    const { evaluator } = build({
      onHand: [onHand(SITE_A, 470)],
      onOrder: [{ ...feedKey, onOrder: 100 }],
    });

    await expect(
      evaluator.crossingsForMovement(manager, TENANT, out(50, SITE_A), 500),
    ).resolves.toEqual([]);
  });

  it('moves no pool tier on a transfer between sites, only the source site', async () => {
    // SCENARIO: 60 moved A → B; A 210 → 150 (policy 200). EXPECTS: site A crossing only.
    const { evaluator, reader } = build({
      onHand: [onHand(SITE_A, 150), onHand(SITE_B, 460)],
      policies: [policy(SITE_A, 200), policy(SITE_B, 100)],
    });

    const crossings = await evaluator.crossingsForMovement(
      manager,
      TENANT,
      out(60, SITE_A, SITE_B),
      500,
    );

    expect(crossings).toEqual([
      expect.objectContaining({
        reading: expect.objectContaining({ level: 'site', siteId: SITE_A }),
      }),
    ]);
    expect(reader.onOrder).not.toHaveBeenCalled();
  });

  it('ignores a site without a policy', async () => {
    // SCENARIO: OUT at site B, which has no policy, pool stays above threshold. EXPECTS: nothing.
    const { evaluator } = build({ onHand: [onHand(SITE_B, 900)], policies: [] });

    await expect(
      evaluator.crossingsForMovement(manager, TENANT, out(10, SITE_B), 500),
    ).resolves.toEqual([]);
  });

  it('reads nothing for a receipt or an intra-site move', async () => {
    // SCENARIO: IN at A; A → A move. EXPECTS: no reads, no crossings.
    const { evaluator, reader } = build({});

    await expect(
      evaluator.crossingsForMovement(manager, TENANT, out(10, null, SITE_A), 500),
    ).resolves.toEqual([]);
    await expect(
      evaluator.crossingsForMovement(manager, TENANT, out(10, SITE_A, SITE_A), 500),
    ).resolves.toEqual([]);
    expect(reader.onHandBySite).not.toHaveBeenCalled();
  });
});
