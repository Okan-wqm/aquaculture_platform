import { BadRequestException, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { TenantClockAuthority } from '../../common/time/tenant-clock.authority';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StorageLocation } from '../entities/storage-location.entity';
import { stockQuantityFromUnits, stockQuantityUnits } from './stock-quantity';

function dateColumnValue(value: Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

export interface FeedAllocationCandidateV1 {
  readonly inventoryId: string;
  readonly storageLocationId: string;
  readonly siteId: string;
  readonly lotNumber: string | null;
  readonly quantityKg: number;
  readonly expiryDate: Date | null;
  readonly receivedDate: Date | null;
}

export interface FeedAllocationSliceV1 {
  readonly inventoryId: string;
  readonly storageLocationId: string;
  readonly lotNumber: string | null;
  readonly quantityKg: number;
  readonly expiryDate: Date | null;
  readonly receivedDate: Date | null;
}

export interface FeedAllocationV1 {
  readonly slices: readonly FeedAllocationSliceV1[];
  readonly poolTotalKg: number;
  readonly usedTenantPool: boolean;
}

/** Pure deterministic compiler over an already locked, canonical FEFO pool. */
export function compileFeedAllocationV1(
  candidates: readonly FeedAllocationCandidateV1[],
  requestedKg: number,
  preferredSiteId?: string,
): FeedAllocationV1 {
  const requestedUnits = stockQuantityUnits(requestedKg, 'Feed allocation quantity');
  const withUnits = candidates.map((candidate) => ({
    candidate,
    units: stockQuantityUnits(candidate.quantityKg, 'Inventory quantity'),
  }));
  const poolUnits = withUnits.reduce((total, entry) => total + entry.units, 0);
  if (!Number.isSafeInteger(poolUnits) || poolUnits < requestedUnits) {
    throw new BadRequestException(
      `Insufficient feed stock. Available: ${stockQuantityFromUnits(poolUnits).toFixed(2)} kg, ` +
        `Requested: ${stockQuantityFromUnits(requestedUnits).toFixed(2)} kg`,
    );
  }

  const ordered = preferredSiteId
    ? [
        ...withUnits.filter((entry) => entry.candidate.siteId === preferredSiteId),
        ...withUnits.filter((entry) => entry.candidate.siteId !== preferredSiteId),
      ]
    : withUnits;
  const slices: FeedAllocationSliceV1[] = [];
  let remainingUnits = requestedUnits;
  let usedTenantPool = false;
  for (const { candidate, units } of ordered) {
    if (remainingUnits === 0) break;
    const allocatedUnits = Math.min(units, remainingUnits);
    if (allocatedUnits === 0) continue;
    slices.push(
      Object.freeze({
        inventoryId: candidate.inventoryId,
        storageLocationId: candidate.storageLocationId,
        lotNumber: candidate.lotNumber,
        quantityKg: stockQuantityFromUnits(allocatedUnits),
        expiryDate: candidate.expiryDate,
        receivedDate: candidate.receivedDate,
      }),
    );
    if (preferredSiteId && candidate.siteId !== preferredSiteId) usedTenantPool = true;
    remainingUnits -= allocatedUnits;
  }
  if (remainingUnits !== 0) {
    throw new BadRequestException('Feed allocation did not converge to the requested quantity');
  }
  return Object.freeze({
    slices: Object.freeze(slices),
    poolTotalKg: stockQuantityFromUnits(poolUnits),
    usedTenantPool,
  });
}

@Injectable()
export class FeedStockAllocationAuthority {
  constructor(private readonly clock: TenantClockAuthority) {}

  /**
   * Locks the complete eligible pool in canonical order and compiles one
   * immutable FEFO allocation. The caller must hold the item advisory lock.
   */
  async allocate(
    manager: EntityManager,
    tenantId: string,
    input: {
      readonly feedId: string;
      readonly quantityKg: number;
      readonly occurredAt: Date;
      readonly preferredSiteId?: string;
      readonly lotNumber?: string;
    },
  ): Promise<FeedAllocationV1> {
    stockQuantityUnits(input.quantityKg, 'Feed allocation quantity');
    const query = tenantManagerRepo(manager, StorageInventory, tenantId)
      .createQueryBuilder('inventory')
      .andWhere('inventory.itemType = :itemType', { itemType: StorageItemType.FEED })
      .andWhere('inventory.itemId = :feedId', { feedId: input.feedId })
      .andWhere('inventory.quantity > 0')
      .andWhere('(inventory.receivedDate IS NULL OR inventory.receivedDate <= :occurredAt)', {
        occurredAt: input.occurredAt,
      });
    if (input.lotNumber) {
      query.andWhere('inventory.lotNumber = :lotNumber', { lotNumber: input.lotNumber });
    }
    const inventory = await query
      .orderBy('inventory.expiryDate', 'ASC', 'NULLS LAST')
      .addOrderBy('inventory.receivedDate', 'ASC', 'NULLS LAST')
      .addOrderBy('inventory.lotNumber', 'ASC', 'NULLS LAST')
      .addOrderBy('inventory.storageLocationId', 'ASC')
      .addOrderBy('inventory.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    if (inventory.length === 0) {
      throw new BadRequestException(
        input.lotNumber
          ? `Feed ${input.feedId} lot ${input.lotNumber} has no usable stock`
          : `Feed ${input.feedId} has no usable stock`,
      );
    }

    const locationIds = [...new Set(inventory.map((row) => row.storageLocationId))];
    const locations = await tenantManagerRepo(manager, StorageLocation, tenantId).find({
      where: { tenantId, id: In(locationIds), isDeleted: false, isActive: true },
    });
    const byId = new Map(locations.map((location) => [location.id, location]));
    const clocks = await this.clock.resolveSites(
      manager,
      tenantId,
      [...new Set(locations.map((location) => location.siteId))],
      input.occurredAt,
    );
    const candidates = inventory.flatMap((row): FeedAllocationCandidateV1[] => {
      const location = byId.get(row.storageLocationId);
      if (!location) {
        throw new BadRequestException(
          `Inventory ${row.id} references an unavailable storage location`,
        );
      }
      const clock = clocks.get(location.siteId);
      if (!clock) {
        throw new BadRequestException(
          `Storage location ${location.id} has no site clock authority`,
        );
      }
      if (row.expiryDate && dateColumnValue(row.expiryDate) <= clock.localDate) {
        return [];
      }
      return [
        {
          inventoryId: row.id,
          storageLocationId: row.storageLocationId,
          siteId: location.siteId,
          lotNumber: row.lotNumber ?? null,
          quantityKg: Number(row.quantity),
          expiryDate: row.expiryDate ?? null,
          receivedDate: row.receivedDate ?? null,
        },
      ];
    });
    if (candidates.length === 0) {
      throw new BadRequestException(
        input.lotNumber
          ? `Feed ${input.feedId} lot ${input.lotNumber} has no usable stock`
          : `Feed ${input.feedId} has no usable stock`,
      );
    }
    return compileFeedAllocationV1(candidates, input.quantityKg, input.preferredSiteId);
  }
}
