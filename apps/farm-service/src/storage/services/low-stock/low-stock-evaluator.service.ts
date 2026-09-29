/**
 * LowStockEvaluator — the ONE place that decides whether stock is low
 * (plan K8, FARM-HIGH-335 / FARM-HIGH-336).
 *
 * WHY: low-stock decisions were split between the ledger sink (tenant-wide
 * SUM vs catalog minStock, no site) and the warehouse summary (the
 * denormalized catalog `quantity`, capped by a mobile LIMIT). Two readers, two
 * answers, and neither knew about sites or open orders.
 *
 * WHAT: two tiers from the ledger.
 *   - site (distribution): SUM(storage_inventory) over the site's locations vs
 *     `storage_item_site_policies.min_stock`;
 *   - pool (procurement): on-hand across every site + open purchase-order
 *     remainder vs the catalog reorder threshold.
 * Consumers: the ledger sink (edge-triggered LowStockDetected), the warehouse
 * and storage summaries (level lists), and the AutoRule reconciler (PR-B1a-2).
 * INVARIANT: nothing here reads the denormalized catalog `quantity`.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { poolStockBand, siteStockBand, stockUrgency, worsenedSeverity } from './stock-band';
import type {
  DescribedStockReading,
  ItemStockEvaluation,
  LowStockCrossing,
  PoolStockReading,
  SiteStockReading,
  StockMovementEffect,
  StorageItemKey,
} from './low-stock.types';
import {
  CatalogStockRow,
  itemKeyOf,
  OnOrderRow,
  SiteOnHandRow,
  SitePolicyRow,
  StockLedgerReader,
} from './stock-ledger.reader';
import { canonicalStockItemType } from './stock-identity';

@Injectable()
export class LowStockEvaluator {
  constructor(private readonly reader: StockLedgerReader) {}

  /**
   * Both tiers of one item, read inside the caller's transaction.
   * WHY: the reconciler and single-item surfaces need the full picture; WHAT:
   * pool reading + one site reading per site policy of the item.
   */
  async evaluateItem(
    manager: EntityManager,
    tenantId: string,
    key: StorageItemKey,
    poolReorderThreshold: number,
  ): Promise<ItemStockEvaluation> {
    const canonicalKey = { itemType: canonicalStockItemType(key.itemType), itemId: key.itemId };
    const scope = { kind: 'item' as const, key: canonicalKey };
    // Sequential: the caller's transactional connection runs one query at a time.
    const onHand = await this.reader.onHandBySite(manager, tenantId, scope);
    const onOrder = await this.reader.onOrder(manager, tenantId, scope);
    const policies = await this.reader.sitePolicies(manager, tenantId, scope);
    return {
      pool: poolReading(canonicalKey, sumOnHand(onHand), sumOnOrder(onOrder), poolReorderThreshold),
      sites: policies.map((policy) => siteReading(policy, siteOnHand(onHand, policy.siteId))),
    };
  }

  /**
   * Every tier of every item that is currently low or out, most urgent first.
   * WHY: the warehouse/storage summaries list level state; WHAT: set-based over
   * the tenant (four catalog reads + ledger + open orders + policies). A pool
   * reading is listed only for reorder-controlled items (threshold > 0), the
   * rule the old catalog query applied with `minStock > 0`.
   */
  async listBelowThreshold(
    manager: EntityManager,
    tenantId: string,
  ): Promise<DescribedStockReading[]> {
    const scope = { kind: 'tenant' as const };
    // Sequential: the caller's transactional connection runs one query at a time.
    const onHand = await this.reader.onHandBySite(manager, tenantId, scope);
    const onOrder = await this.reader.onOrder(manager, tenantId, scope);
    const policies = await this.reader.sitePolicies(manager, tenantId, scope);
    const catalog = await this.reader.catalog(manager, tenantId);

    // All reader rows carry the canonical item type (stock-identity.ts), so one
    // physical item is one key here — a HEALTHCARE-booked shelf and its
    // consumable catalog row are the same pool.
    const catalogByKey = new Map(catalog.map((row) => [itemKeyOf(row), row]));
    const onHandByItem = groupOnHand(onHand);
    const onOrderByItem = new Map(onOrder.map((row) => [itemKeyOf(row), row.onOrder]));

    const readings: DescribedStockReading[] = [];

    // Pool tier: every reorder-controlled catalog item, plus any ledger or
    // order key (already canonical) that has a catalog row.
    const poolKeys = new Map<string, StorageItemKey>();
    for (const row of catalog) {
      if (row.poolReorderThreshold > 0) poolKeys.set(itemKeyOf(row), row);
    }
    for (const row of [...onHand, ...onOrder]) poolKeys.set(itemKeyOf(row), row);
    for (const key of poolKeys.values()) {
      const described = catalogByKey.get(itemKeyOf(key));
      if (!described || described.poolReorderThreshold <= 0) continue;
      const reading = poolReading(
        key,
        sumOnHand(onHandByItem.get(itemKeyOf(key)) ?? []),
        onOrderByItem.get(itemKeyOf(key)) ?? 0,
        described.poolReorderThreshold,
      );
      if (reading.band !== 'ok') readings.push(describe(reading, described));
    }

    // Site tier: every policy.
    for (const policy of policies) {
      const described = catalogByKey.get(itemKeyOf(policy));
      if (!described) continue;
      const reading = siteReading(
        policy,
        siteOnHand(onHandByItem.get(itemKeyOf(policy)) ?? [], policy.siteId),
      );
      if (reading.band !== 'ok') readings.push(describe(reading, described));
    }

    // Most urgent first; on a tie a SITE row precedes the POOL row (a site
    // running dry is the operational emergency), then by name — deterministic.
    return readings.sort(
      (a, b) =>
        urgencyOf(a) - urgencyOf(b) ||
        levelRank(a) - levelRank(b) ||
        a.itemName.localeCompare(b.itemName),
    );
  }

  /**
   * The tiers a committed movement pushed into a worse band (edge trigger).
   * WHY: LowStockDetected must fire once per crossing, not on every movement
   * that leaves stock already low; WHAT: reads the post-movement state in the
   * caller's transaction, reconstructs the pre-movement state from the
   * movement's own delta (the item is serialised by StockMutationLockAuthority,
   * so nothing else moved it in between), and compares bands.
   */
  async crossingsForMovement(
    manager: EntityManager,
    tenantId: string,
    effect: StockMovementEffect,
    poolReorderThreshold: number,
  ): Promise<LowStockCrossing[]> {
    const siteDeltas = new Map<string, number>();
    if (effect.fromSiteId !== null) {
      siteDeltas.set(effect.fromSiteId, (siteDeltas.get(effect.fromSiteId) ?? 0) - effect.quantity);
    }
    if (effect.toSiteId !== null) {
      siteDeltas.set(effect.toSiteId, (siteDeltas.get(effect.toSiteId) ?? 0) + effect.quantity);
    }
    const poolDelta = [...siteDeltas.values()].reduce((sum, delta) => sum + delta, 0);
    const shrinkingSites = [...siteDeltas.entries()].filter(([, delta]) => delta < 0);
    // Only a decrease can worsen a band; receipts and intra-site moves skip the reads.
    if (poolDelta >= 0 && shrinkingSites.length === 0) return [];

    const canonicalKey = {
      itemType: canonicalStockItemType(effect.itemType),
      itemId: effect.itemId,
    };
    const scope = { kind: 'item' as const, key: canonicalKey };
    // Sequential: this runs inside the movement's transaction connection.
    const onHand = await this.reader.onHandBySite(manager, tenantId, scope);
    const onOrder = poolDelta < 0 ? await this.reader.onOrder(manager, tenantId, scope) : [];
    const policies =
      shrinkingSites.length > 0 ? await this.reader.sitePolicies(manager, tenantId, scope) : [];

    const crossings: LowStockCrossing[] = [];

    if (poolDelta < 0) {
      const after = poolReading(
        canonicalKey,
        sumOnHand(onHand),
        sumOnOrder(onOrder),
        poolReorderThreshold,
      );
      const before = poolStockBand(after.onHand - poolDelta, after.onOrder, poolReorderThreshold);
      const severity = worsenedSeverity(before, after.band);
      if (severity !== null) crossings.push({ before, severity, reading: after });
    }

    for (const [siteId, delta] of shrinkingSites) {
      const policy = policies.find((row) => row.siteId === siteId);
      if (!policy) continue;
      const after = siteReading(policy, siteOnHand(onHand, siteId));
      const before = siteStockBand(after.onHand - delta, policy.minStock);
      const severity = worsenedSeverity(before, after.band);
      if (severity !== null) crossings.push({ before, severity, reading: after });
    }

    return crossings;
  }
}

function poolReading(
  key: StorageItemKey,
  onHand: number,
  onOrder: number,
  threshold: number,
): PoolStockReading {
  return {
    level: 'pool',
    itemType: key.itemType,
    itemId: key.itemId,
    onHand,
    onOrder,
    threshold,
    band: poolStockBand(onHand, onOrder, threshold),
  };
}

function siteReading(policy: SitePolicyRow, onHand: number): SiteStockReading {
  return {
    level: 'site',
    itemType: policy.itemType,
    itemId: policy.itemId,
    siteId: policy.siteId,
    onHand,
    threshold: policy.minStock,
    band: siteStockBand(onHand, policy.minStock),
  };
}

function describe(
  reading: PoolStockReading | SiteStockReading,
  catalog: CatalogStockRow,
): DescribedStockReading {
  return { ...reading, itemName: catalog.name, unit: catalog.unit };
}

function urgencyOf(reading: DescribedStockReading): number {
  const compared = reading.level === 'pool' ? reading.onHand + reading.onOrder : reading.onHand;
  return reading.band === 'out_of_stock' ? 0 : stockUrgency(compared, reading.threshold);
}

function levelRank(reading: DescribedStockReading): number {
  return reading.level === 'site' ? 0 : 1;
}

function sumOnHand(rows: SiteOnHandRow[]): number {
  return rows.reduce((sum, row) => sum + row.onHand, 0);
}

function sumOnOrder(rows: OnOrderRow[]): number {
  return rows.reduce((sum, row) => sum + row.onOrder, 0);
}

function siteOnHand(rows: SiteOnHandRow[], siteId: string): number {
  return sumOnHand(rows.filter((row) => row.siteId === siteId));
}

function groupOnHand(rows: SiteOnHandRow[]): Map<string, SiteOnHandRow[]> {
  const grouped = new Map<string, SiteOnHandRow[]>();
  for (const row of rows) {
    const key = itemKeyOf(row);
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}
