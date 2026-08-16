/**
 * LotMixService
 *
 * Detects and records the moment two distinct lots of the same item
 * physically converge in the same storage location. Called from the
 * RecordStockMovementHandler's increaseInventory path right before the
 * new lot is persisted so the handler can decide whether to create a
 * mix event.
 *
 * The event record is emitted as a `StorageLotMix` row in
 * `farm.storage_lot_mixes`. Downstream `traceLot(lotNumber)` queries
 * join against this table so they can surface every lot that shared a
 * physical container even after the mix dates — a prerequisite for the
 * 2-hour traceback that Mattilsynet + EU food-safety regulations
 * require on feed / medication incidents.
 *
 * Scope note: the detector operates inside a single (itemType, itemId)
 * bucket, so every contributing lot is a batch of the same product.
 * Cross-item container sharing (e.g. two different feeds in one silo)
 * is a separate invariant handled elsewhere — out of scope here.
 *
 * Phase 2.4 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-B16.
 */
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { LotContribution, StorageLotMix } from '../entities/storage-lot-mix.entity';

export interface DetectMixParams {
  tenantId: string;
  storageLocationId: string;
  itemType: StorageItemType;
  itemId: string;
  /** New lot about to land in the location. */
  incomingLotNumber: string | null;
  incomingQuantityKg: number;
  /**
   * Manufacturer of the item being moved — resolved by the caller from
   * Feed/Chemical/Consumable. All lots of the same item share this
   * value, so it is recorded as a snapshot on every contribution.
   */
  manufacturer?: string | null;
  incomingExpiryDate?: Date | null;
  userId: string;
  /** Canonical transaction/operation instant owned by the stock mutation scope. */
  mixedAt: Date;
  /** EntityManager for transactional consistency with the parent movement. */
  manager: EntityManager;
}

export interface MixOutcome {
  /** True when a new mix row was created. */
  mixCreated: boolean;
  /** The persisted row if one was created, else null. */
  mix: StorageLotMix | null;
  /**
   * Composite lot identifier to stamp on the outbound movement ledger.
   * Null when no mix occurred.
   */
  effectiveLotNumber: string | null;
}

@Injectable()
export class LotMixService {
  private readonly logger = new Logger(LotMixService.name);

  /**
   * Run the detection. No-ops when the incoming lot is the only lot in
   * the location (the common case) or when the movement carries no lot
   * number; creates a StorageLotMix row when another lot with a
   * different `lotNumber` is already resident in non-zero quantity.
   */
  async detect(params: DetectMixParams): Promise<MixOutcome> {
    const {
      tenantId,
      storageLocationId,
      itemType,
      itemId,
      incomingLotNumber,
      incomingQuantityKg,
      manufacturer,
      incomingExpiryDate,
      userId,
      mixedAt,
      manager,
    } = params;

    if (!incomingLotNumber) {
      // Lot tracking does not apply to this movement (e.g. generic
      // consumable without a lot) — nothing to mix.
      return { mixCreated: false, mix: null, effectiveLotNumber: null };
    }

    const inventoryRepo = tenantManagerRepo(manager, StorageInventory, tenantId);
    // tenantId auto-injected by the scoped wrapper — drop it from the WHERE.
    const existing = await inventoryRepo.find({
      where: { storageLocationId, itemType, itemId },
      select: ['id', 'lotNumber', 'quantity', 'expiryDate'],
    });

    const otherLots = existing.filter(
      (row) => row.lotNumber && row.lotNumber !== incomingLotNumber && Number(row.quantity) > 0,
    );

    if (otherLots.length === 0) {
      return { mixCreated: false, mix: null, effectiveLotNumber: null };
    }

    const contributions: LotContribution[] = [
      ...otherLots.map((row) => {
        // filter(row.lotNumber) above narrows the string type.
        const lotNumber = row.lotNumber as string;
        return {
          lotNumber,
          quantityKg: Number(row.quantity),
          contributionPct: 0,
          manufacturer: manufacturer ?? undefined,
          expiryDate: row.expiryDate ? this.toIsoDate(row.expiryDate) : undefined,
        };
      }),
      {
        lotNumber: incomingLotNumber,
        quantityKg: incomingQuantityKg,
        contributionPct: 0,
        manufacturer: manufacturer ?? undefined,
        expiryDate: incomingExpiryDate ? this.toIsoDate(incomingExpiryDate) : undefined,
      },
    ];

    const totalQuantityKg = contributions.reduce((sum, c) => sum + c.quantityKg, 0);
    for (const c of contributions) {
      c.contributionPct = totalQuantityKg > 0 ? (c.quantityKg / totalQuantityKg) * 100 : 0;
    }

    const effectiveLotNumber = ['MIX', ...contributions.map((c) => c.lotNumber).sort()].join('-');

    const mixRepo = tenantManagerRepo(manager, StorageLotMix, tenantId);
    const mix = mixRepo.create({
      tenantId,
      storageLocationId,
      itemType,
      itemId,
      effectiveLotNumber,
      contributingLots: contributions,
      totalQuantityKg: totalQuantityKg.toFixed(2),
      mixedAt,
      createdBy: userId,
    });
    const saved = await mixRepo.save(mix);

    this.logger.log(
      `Recorded lot mix ${saved.id} at location ${storageLocationId}: ` +
        `${contributions.map((c) => c.lotNumber).join(', ')} ` +
        `(effectiveLot=${effectiveLotNumber})`,
    );

    return { mixCreated: true, mix: saved, effectiveLotNumber };
  }

  /**
   * traceLot query helper — resolves every mix event that a given lot
   * number participated in, whether as the incoming lot or as a
   * resident lot named in someone else's mix.
   *
   * Takes the caller's `EntityManager` so the lookup runs on the same
   * fail-closed tenant boundary connection as the trace query itself
   * (search_path + RLS GUC pinned + asserted by `runInTenantRead`).
   */
  async findMixesForLot(
    manager: EntityManager,
    tenantId: string,
    lotNumber: string,
  ): Promise<StorageLotMix[]> {
    return manager
      .createQueryBuilder(StorageLotMix, 'mix')
      .where('mix.tenantId = :tenantId', { tenantId })
      .andWhere(
        // JSONB containment — does the contributing lot array include
        // any row whose lotNumber matches?
        `mix."contributingLots" @> :lotFilter`,
        {
          lotFilter: JSON.stringify([{ lotNumber }]),
        },
      )
      .orderBy('mix.mixedAt', 'DESC')
      .getMany();
  }

  private toIsoDate(value: Date | string): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return new Date(value).toISOString();
  }
}
