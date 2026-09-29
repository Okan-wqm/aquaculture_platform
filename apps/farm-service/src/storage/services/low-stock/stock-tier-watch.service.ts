/**
 * StockTierWatch — the low-stock edge trigger for commands that move a stock
 * tier WITHOUT moving stock (plan K8; V-B1-5 of the B1a-1 verifier round).
 *
 * WHY: `StockMovementService` emits LowStockDetected when a movement pushes a
 * tier into a worse band. A tier also changes band when its INPUTS change with
 * no movement at all: a site policy is created or raised, a catalog minStock or
 * spare-part reorder point is raised, a purchase order stops counting as open
 * (cancel, pulled back to draft, closed as received), or a restored site wakes
 * its dormant policies. Before this watch those commands emitted nothing, and
 * every later movement then saw "already low" — the next event came only at
 * out_of_stock, and nothing reconciles until PR-B1a-2.
 *
 * WHAT: `around()` serialises the command on the items' stock mutation locks
 * (the same advisory locks every movement takes), evaluates every tier of the
 * items before and after the command inside the command's own transaction,
 * enqueues one LowStockDetected per tier that WORSENED through the one sink
 * (`enqueueLowStockCrossings`), and re-projects the catalog status (whose rule
 * reads the same inputs, V-B1-4).
 *
 * INVARIANT: exactly once per crossing. The locks exclude every concurrent
 * movement and watched command of the same item between the two snapshots, and
 * both snapshots read the same transaction; if violated → a crossing emitted by
 * both a movement and a command, or by neither.
 */
import { Injectable } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { EntityManager } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { StorageItemSitePolicy } from '../../entities/storage-item-site-policy.entity';
import { CatalogStockProjector } from '../catalog-stock-projector.service';
import { describeStorageItem } from '../storage-item-catalog';
import { StockMutationLockAuthority } from '../stock-mutation-lock.authority';
import { LowStockEvaluator } from './low-stock-evaluator.service';
import { enqueueLowStockCrossings } from './low-stock-event.factory';
import type { LowStockCrossing, StockReading, StorageItemKey } from './low-stock.types';
import { StockBand, worsenedSeverity } from './stock-band';
import { canonicalStockItemType } from './stock-identity';

/** What one watched command changes: the items it touches and its cause. */
export interface TierWatchScope<T> {
  /** Every stock item whose tiers the command can move. */
  items: readonly StorageItemKey[];
  /** The record whose change is the event's `causationId` (policy, item, order, site). */
  causationId: (result: T) => string;
}

/** Every tier of one item, keyed by tier identity. */
type TierSnapshot = Map<string, StockReading>;

function tierKey(reading: StockReading): string {
  return reading.level === 'site' ? `site:${reading.siteId}` : 'pool';
}

@Injectable()
export class StockTierWatch {
  constructor(
    private readonly evaluator: LowStockEvaluator,
    private readonly mutationLocks: StockMutationLockAuthority,
    private readonly catalogProjector: CatalogStockProjector,
    // Provided app-wide by the @Global() FarmOutboxModule (same sink as movements).
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Run `command` inside the caller's transaction and signal every tier it
   * pushed into a worse band.
   * WHY: a threshold, open-order or site change is a tier change; WHAT: lock →
   * snapshot → command → snapshot → emit worsened tiers → re-project catalogs.
   * A tier absent before (dormant or new policy) counts as `ok`; a tier absent
   * after (deleted policy, closed site) emits nothing.
   */
  async around<T>(
    manager: EntityManager,
    tenantId: string,
    scope: TierWatchScope<T>,
    command: () => Promise<T>,
  ): Promise<T> {
    const items = distinctCanonical(scope.items);
    await this.mutationLocks.acquire(manager, tenantId, items);

    const before = new Map<string, TierSnapshot>();
    for (const item of items) {
      before.set(keyOf(item), await this.snapshot(manager, tenantId, item));
    }

    const result = await command();

    const causationId = scope.causationId(result);
    for (const item of items) {
      const label = await describeStorageItem(manager, tenantId, item.itemType, item.itemId);
      if (label !== null) {
        const after = await this.snapshot(manager, tenantId, item);
        const crossings = worsenedTiers(before.get(keyOf(item)) ?? new Map(), after);
        await enqueueLowStockCrossings(
          this.outboxPublisher,
          manager,
          tenantId,
          crossings,
          label,
          causationId,
        );
      }
      await this.catalogProjector.project(manager, tenantId, item.itemType, item.itemId);
    }
    return result;
  }

  /**
   * The items with a policy at `siteId`, live or dormant — the tiers a site
   * restore wakes. WHY not the reader's `sitePolicies`: it hides the dormant
   * policies of a deleted site, which are exactly the ones a restore revives.
   */
  async sitePolicyItems(
    manager: EntityManager,
    tenantId: string,
    siteId: string,
  ): Promise<StorageItemKey[]> {
    const policies = await tenantManagerRepo(manager, StorageItemSitePolicy, tenantId).find({
      where: { tenantId, siteId },
      select: ['itemType', 'itemId'],
    });
    return policies.map((policy) => ({ itemType: policy.itemType, itemId: policy.itemId }));
  }

  /** Every tier of one item now (empty when the catalog row does not exist). */
  private async snapshot(
    manager: EntityManager,
    tenantId: string,
    item: StorageItemKey,
  ): Promise<TierSnapshot> {
    const described = await describeStorageItem(manager, tenantId, item.itemType, item.itemId);
    if (described === null) return new Map();
    const evaluation = await this.evaluator.evaluateItem(
      manager,
      tenantId,
      item,
      described.poolReorderThreshold,
    );
    const readings: StockReading[] = [evaluation.pool, ...evaluation.sites];
    return new Map(readings.map((reading) => [tierKey(reading), reading]));
  }
}

/** The tiers of `after` whose band is worse than the same tier in `before`. */
export function worsenedTiers(before: TierSnapshot, after: TierSnapshot): LowStockCrossing[] {
  const crossings: LowStockCrossing[] = [];
  for (const [key, reading] of after) {
    const previous: StockBand = before.get(key)?.band ?? 'ok';
    const severity = worsenedSeverity(previous, reading.band);
    if (severity !== null) crossings.push({ before: previous, severity, reading });
  }
  return crossings;
}

function keyOf(item: StorageItemKey): string {
  return `${item.itemType}:${item.itemId}`;
}

/** One entry per physical item (HEALTHCARE and CONSUMABLE share a row). */
function distinctCanonical(items: readonly StorageItemKey[]): StorageItemKey[] {
  const byKey = new Map<string, StorageItemKey>();
  for (const item of items) {
    const canonical = { itemType: canonicalStockItemType(item.itemType), itemId: item.itemId };
    byKey.set(keyOf(canonical), canonical);
  }
  return [...byKey.values()];
}
