/**
 * StorageItemCatalog — the ONE lookup from a ledger key `(itemType, itemId)`
 * to the catalog row that describes it.
 *
 * WHY: the stock sink, the transfer handler and the inventory-count handler
 * each carried their own `switch (itemType)` with a `default: return null`.
 * Two of them silently rejected HEALTHCARE stock, and every one of them would
 * have silently rejected SPARE_PART stock (FARM-HIGH-338). One exhaustive
 * switch makes a forgotten category a compile error instead.
 *
 * WHAT: `describe` returns the name/unit/threshold view the ledger needs, or
 * null when the catalog row does not exist in this tenant.
 */
import { EntityManager } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { SparePart } from '../../maintenance/entities/spare-part.entity';
import { StorageItemType, assertNeverItemType } from '../entities/storage-inventory.entity';

/** Catalog facts the ledger needs about one stock item. */
export interface StorageItemDescriptor {
  name: string;
  unit: string;
  /**
   * The POOL reorder threshold (plan K8 tier 2). Catalog `minStock` for
   * feed/chemical/consumable/healthcare; `reorderPoint` for spare parts,
   * whose buy trigger is the reorder point (FARM-4). 0 = not stock-controlled.
   */
  poolReorderThreshold: number;
  manufacturer?: string;
  storageTempMin?: number;
  storageTempMax?: number;
  storageHumidityMin?: number;
  storageHumidityMax?: number;
}

/**
 * Resolve the catalog row behind a ledger key inside the caller's transaction.
 * WHY: every stock writer must name what it moved; WHAT: exhaustive over
 * `StorageItemType`, null when the row is absent in this tenant.
 */
export async function describeStorageItem(
  manager: EntityManager,
  tenantId: string,
  itemType: StorageItemType,
  itemId: string,
): Promise<StorageItemDescriptor | null> {
  switch (itemType) {
    case StorageItemType.FEED: {
      const feed = await tenantManagerRepo(manager, Feed, tenantId).findOne({
        where: { id: itemId, tenantId },
      });
      return feed
        ? {
            name: feed.name,
            unit: feed.unit,
            poolReorderThreshold: Number(feed.minStock),
            manufacturer: feed.manufacturer,
            storageTempMin: feed.storageTempMin,
            storageTempMax: feed.storageTempMax,
            storageHumidityMin: feed.storageHumidityMin,
            storageHumidityMax: feed.storageHumidityMax,
          }
        : null;
    }
    case StorageItemType.CHEMICAL: {
      const chem = await tenantManagerRepo(manager, Chemical, tenantId).findOne({
        where: { id: itemId, tenantId },
      });
      return chem
        ? {
            name: chem.name,
            unit: chem.unit,
            poolReorderThreshold: Number(chem.minStock),
            storageTempMin: chem.storageTempMin,
            storageTempMax: chem.storageTempMax,
            storageHumidityMin: chem.storageHumidityMin,
            storageHumidityMax: chem.storageHumidityMax,
          }
        : null;
    }
    case StorageItemType.CONSUMABLE:
    case StorageItemType.HEALTHCARE: {
      // Healthcare products (medications, vaccines) share the consumable
      // table — a unified entity with healthcare-specific categories.
      const cons = await tenantManagerRepo(manager, Consumable, tenantId).findOne({
        where: { id: itemId, tenantId },
      });
      return cons
        ? {
            name: cons.name,
            unit: cons.unit,
            poolReorderThreshold: Number(cons.minStock),
            storageTempMin: cons.storageTempMin,
            storageTempMax: cons.storageTempMax,
            storageHumidityMin: cons.storageHumidityMin,
            storageHumidityMax: cons.storageHumidityMax,
          }
        : null;
    }
    case StorageItemType.SPARE_PART: {
      const part = await tenantManagerRepo(manager, SparePart, tenantId).findOne({
        where: { id: itemId, tenantId },
      });
      return part
        ? {
            name: part.name,
            unit: part.unit,
            poolReorderThreshold: Number(part.reorderPoint),
            manufacturer: part.manufacturer,
          }
        : null;
    }
    default:
      return assertNeverItemType(itemType);
  }
}
