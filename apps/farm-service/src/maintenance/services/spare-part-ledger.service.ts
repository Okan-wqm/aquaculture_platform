/**
 * SparePartLedgerService — every spare-part stock change, through the ONE
 * storage ledger sink (FARM-HIGH-338).
 *
 * WHY: spare-part stock used to be a counter four writers mutated without a
 * single persisted movement row: the manual movement built an audit object and
 * threw it away, bulk stock-in and work-order completion wrote the counter
 * directly, and work-order completion CLAMPED to zero instead of refusing to
 * consume stock that was not there. Spare parts now move like every other
 * stock item: `StockMovementService.recordMovement` writes the inventory row,
 * the immutable `stock_movements` audit row and the low-stock signal in the
 * caller's transaction, and refuses insufficient stock (fail-closed).
 *
 * WHAT: each method runs INSIDE a transaction the caller owns (`manager`), so a
 * failed movement rolls back the whole operation (a work-order completion, a
 * part registration).
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In, MoreThan } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';

import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';
import { MovementType } from '../../storage/entities/stock-movement.entity';
import {
  MovementContext,
  StockMovementService,
} from '../../storage/services/stock-movement.service';
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { SparePart } from '../entities/spare-part.entity';
import type { StockMovementInput } from '../dto/spare-part.dto';
import {
  compileSparePartDraw,
  type SparePartDrawCandidate,
  type WorkOrderAssetRef,
  workOrderSiteId,
} from './work-order-consumption';

/** Who performs a movement. Operator movements carry their site scope. */
export interface SparePartActor {
  userId: string;
  /** Present for a direct operator movement (SEC-HIGH-051 site check at the sink). */
  siteAuthorization?: SiteScopeCaller;
}

/** A part consumed by a work order. */
export interface ConsumedMaterial {
  sparePartId: string;
  quantity: number;
}

@Injectable()
export class SparePartLedgerService {
  constructor(
    private readonly stockMovements: StockMovementService,
    // The item lock the sink takes; an adjustment takes it BEFORE reading the
    // count baseline so no concurrent movement lands between read and write.
    private readonly mutationLocks: StockMutationLockAuthority,
  ) {}

  /**
   * Assert a storage location exists, is live and belongs to this tenant.
   * WHY: `spare_parts.storageLocationId` is the place every later movement
   * defaults to; a dangling or deleted location would fail far from its cause.
   */
  async assertLocation(
    manager: EntityManager,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    const location = await tenantManagerRepo(manager, StorageLocation, tenantId).findOne({
      where: { id: locationId, tenantId },
    });
    if (!location) throw new NotFoundException(`Storage location "${locationId}" not found`);
    if (location.isDeleted) {
      throw new BadRequestException(`Storage location "${locationId}" is deleted`);
    }
  }

  /**
   * Re-home a part (`storageLocationId`) only when its current home holds no
   * stock.
   * WHY: the home is where every later movement defaults to; re-pointing it
   * while stock still sits at the old home strands that stock — a count at the
   * new home reads 0 and books a phantom IN. The stock moves first (a
   * `transfer` movement through this ledger), then the home.
   * INVARIANT: read under the item lock, so no concurrent receipt lands at the
   * old home between the check and the re-home.
   */
  async assertRelocatable(
    manager: EntityManager,
    tenantId: string,
    part: SparePart,
    nextLocationId: string | null,
  ): Promise<void> {
    const current = part.storageLocationId ?? null;
    if (current === null || current === nextLocationId) return;
    await this.mutationLocks.acquire(manager, tenantId, [
      { itemType: StorageItemType.SPARE_PART, itemId: part.id },
    ]);
    const onHand = await this.onHandAtLocation(manager, tenantId, part.id, current);
    if (onHand > 0) {
      throw new BadRequestException(
        `Spare part ${part.code} still holds ${onHand} ${part.unit} at its storage location; ` +
          'transfer that stock (spare-part movement type "transfer") before changing the location',
      );
    }
  }

  /** Opening balance of a newly registered part: one IN movement. */
  async recordOpeningBalance(
    manager: EntityManager,
    tenantId: string,
    part: SparePart,
    quantity: number,
    actor: SparePartActor,
  ): Promise<void> {
    const locationId = this.requireLocation(part, undefined);
    await this.stockMovements.recordMovement(
      manager,
      {
        movementType: MovementType.IN,
        itemType: StorageItemType.SPARE_PART,
        itemId: part.id,
        quantity,
        toLocationId: locationId,
        reference: 'Opening balance',
      },
      this.context(tenantId, actor),
    );
  }

  /**
   * An operator's in / out / adjustment / transfer. Adjustment carries the
   * COUNTED on-hand at the location; the ledger records the signed difference as
   * one ADJUSTMENT movement (none when the count matches). Transfer moves stock
   * from the location to `toStorageLocationId` as ONE ledger TRANSFER movement:
   * the sink locks the item, checks the caller's site on both legs, refuses a
   * deleted destination and reports the source site's tier crossing.
   */
  async recordMovement(
    manager: EntityManager,
    tenantId: string,
    part: SparePart,
    input: StockMovementInput,
    actor: SparePartActor,
  ): Promise<void> {
    const locationId = this.requireLocation(part, input.storageLocationId);
    const reference = input.workOrderId ? `WO:${input.workOrderId}` : undefined;
    const reason = [input.reason, input.notes].filter(Boolean).join(' — ') || undefined;
    const ctx = this.context(tenantId, actor);
    const base = { itemType: StorageItemType.SPARE_PART, itemId: part.id, reference, reason };

    switch (input.movementType) {
      case 'in':
        this.requirePositive(input.quantity);
        await this.stockMovements.recordMovement(
          manager,
          {
            ...base,
            movementType: MovementType.IN,
            quantity: input.quantity,
            toLocationId: locationId,
          },
          ctx,
        );
        part.lastOrderDate = new Date();
        return;
      case 'out':
        this.requirePositive(input.quantity);
        await this.stockMovements.recordMovement(
          manager,
          {
            ...base,
            movementType: MovementType.OUT,
            quantity: input.quantity,
            fromLocationId: locationId,
          },
          ctx,
        );
        part.lastUsedDate = new Date();
        return;
      case 'transfer': {
        this.requirePositive(input.quantity);
        if (!input.toStorageLocationId) {
          throw new BadRequestException('A transfer needs the receiving toStorageLocationId');
        }
        await this.stockMovements.recordMovement(
          manager,
          {
            ...base,
            movementType: MovementType.TRANSFER,
            quantity: input.quantity,
            fromLocationId: locationId,
            toLocationId: input.toStorageLocationId,
          },
          ctx,
        );
        return;
      }
      case 'adjustment': {
        // INVARIANT: the counted delta is computed under the item's mutation
        // lock (the same advisory lock the sink re-takes; xact locks stack).
        // If violated → a movement committed between this read and the
        // adjustment is silently undone or doubled by a stale delta.
        await this.mutationLocks.acquire(manager, tenantId, [
          { itemType: StorageItemType.SPARE_PART, itemId: part.id },
        ]);
        const onHand = await this.onHandAtLocation(manager, tenantId, part.id, locationId);
        const delta = input.quantity - onHand;
        if (delta === 0) return;
        await this.stockMovements.recordMovement(
          manager,
          {
            ...base,
            movementType: MovementType.ADJUSTMENT,
            quantity: Math.abs(delta),
            ...(delta > 0 ? { toLocationId: locationId } : { fromLocationId: locationId }),
          },
          ctx,
        );
        return;
      }
    }
  }

  /** Received parts, one IN movement each at the part's own location. */
  async receiveMany(
    manager: EntityManager,
    tenantId: string,
    parts: readonly SparePart[],
    items: ReadonlyArray<{ sparePartId: string; quantity: number; notes?: string }>,
    reason: string | undefined,
    actor: SparePartActor,
  ): Promise<void> {
    const byId = new Map(parts.map((part) => [part.id, part]));
    for (const item of items) {
      const part = byId.get(item.sparePartId);
      if (!part) throw new NotFoundException(`Yedek parça bulunamadı: ${item.sparePartId}`);
      this.requirePositive(item.quantity);
      await this.stockMovements.recordMovement(
        manager,
        {
          movementType: MovementType.IN,
          itemType: StorageItemType.SPARE_PART,
          itemId: part.id,
          quantity: item.quantity,
          toLocationId: this.requireLocation(part, undefined),
          reason: [reason, item.notes].filter(Boolean).join(' — ') || undefined,
        },
        this.context(tenantId, actor),
      );
      part.lastOrderDate = new Date();
    }
  }

  /**
   * THE single path that consumes spare parts for a work order.
   *
   * WHY no site check at the sink: like a feeding deduction, this is an
   * internal consequence of an operation the caller is already authorised for
   * (completing the work order); gating it on the store's site would block a
   * technician from using a part issued to them. The insufficient-stock rule is
   * NOT relaxed: the draw refuses a site that holds too little, the sink
   * refuses a short row, and the completion rolls back.
   *
   * WHY across the site (V-B1-9): receipts and transfers put a part in other
   * stores than its home, so drawing from the home alone failed while the part
   * lay in the next store. The draw covers the work order's site — its asset's
   * site, or the part's home site for an unplaced asset — home location first,
   * then the oldest stock (`compileSparePartDraw`), one OUT movement per slice.
   * INVARIANT: planned under the part's stock mutation lock, so no concurrent
   * movement changes the rows between the plan and its slices.
   */
  async consumeForWorkOrder(
    manager: EntityManager,
    tenantId: string,
    workOrder: WorkOrderAssetRef,
    materials: readonly ConsumedMaterial[],
    userId: string,
  ): Promise<void> {
    if (materials.length === 0) return;
    const parts = await tenantManagerRepo(manager, SparePart, tenantId).find({
      where: { tenantId, id: In(materials.map((material) => material.sparePartId)) },
    });
    const byId = new Map(parts.map((part) => [part.id, part]));
    const assetSiteId = await workOrderSiteId(manager, tenantId, workOrder);
    for (const material of materials) {
      const part = byId.get(material.sparePartId);
      if (!part) throw new NotFoundException(`Yedek parça bulunamadı: ${material.sparePartId}`);
      this.requirePositive(material.quantity);
      await this.mutationLocks.acquire(manager, tenantId, [
        { itemType: StorageItemType.SPARE_PART, itemId: part.id },
      ]);
      const siteId = assetSiteId ?? (await this.homeSiteId(manager, tenantId, part));
      const candidates = await this.drawCandidates(manager, tenantId, part.id, siteId);
      const slices = compileSparePartDraw(
        candidates,
        material.quantity,
        part.storageLocationId,
        part.code,
      );
      for (const slice of slices) {
        await this.stockMovements.recordMovement(
          manager,
          {
            movementType: MovementType.OUT,
            itemType: StorageItemType.SPARE_PART,
            itemId: part.id,
            quantity: slice.quantity,
            fromLocationId: slice.storageLocationId,
            lotNumber: slice.lotNumber,
            reference: `WO:${workOrder.id}`,
          },
          { tenantId, userId },
        );
      }
      part.lastUsedDate = new Date();
    }
    await tenantManagerRepo(manager, SparePart, tenantId).saveMany(parts);
  }

  /** The site of the part's home location (the draw site of an unplaced asset). */
  private async homeSiteId(
    manager: EntityManager,
    tenantId: string,
    part: SparePart,
  ): Promise<string> {
    const homeId = this.requireLocation(part, undefined);
    const home = await tenantManagerRepo(manager, StorageLocation, tenantId).findOne({
      where: { id: homeId, tenantId },
      select: ['id', 'siteId'],
    });
    if (!home) throw new NotFoundException(`Storage location "${homeId}" not found`);
    return home.siteId;
  }

  /**
   * The part's usable rows at one site: live locations only (FARM-MEDIUM-293),
   * positive and unexpired — the rows the sink's decrement can draw.
   */
  private async drawCandidates(
    manager: EntityManager,
    tenantId: string,
    partId: string,
    siteId: string,
  ): Promise<SparePartDrawCandidate[]> {
    const locations = await tenantManagerRepo(manager, StorageLocation, tenantId).find({
      where: { tenantId, siteId, isDeleted: false },
      select: ['id'],
    });
    if (locations.length === 0) return [];
    const rows = await tenantManagerRepo(manager, StorageInventory, tenantId).find({
      where: {
        tenantId,
        itemType: StorageItemType.SPARE_PART,
        itemId: partId,
        storageLocationId: In(locations.map((location) => location.id)),
        quantity: MoreThan(0),
      },
    });
    const now = Date.now();
    return rows
      .filter((row) => !row.expiryDate || new Date(row.expiryDate).getTime() > now)
      .map((row) => ({
        storageLocationId: row.storageLocationId,
        lotNumber: row.lotNumber ?? null,
        quantity: Number(row.quantity),
        receivedDate: row.receivedDate ?? null,
        expiryDate: row.expiryDate ?? null,
      }));
  }

  private requireLocation(part: SparePart, explicit: string | undefined): string {
    const locationId = explicit ?? part.storageLocationId;
    if (!locationId) {
      throw new BadRequestException(
        `Spare part ${part.code} has no storage location; assign one before moving its stock`,
      );
    }
    return locationId;
  }

  private requirePositive(quantity: number): void {
    if (!(quantity > 0)) throw new BadRequestException('Quantity must be greater than zero');
  }

  private context(tenantId: string, actor: SparePartActor): MovementContext {
    return { tenantId, userId: actor.userId, siteAuthorization: actor.siteAuthorization };
  }

  private async onHandAtLocation(
    manager: EntityManager,
    tenantId: string,
    partId: string,
    locationId: string,
  ): Promise<number> {
    const row: { total: string } | undefined = await tenantManagerRepo(
      manager,
      StorageInventory,
      tenantId,
    )
      .createQueryBuilder('inv')
      .select('COALESCE(SUM(inv.quantity), 0)', 'total')
      .andWhere('inv.itemType = :itemType', { itemType: StorageItemType.SPARE_PART })
      .andWhere('inv.itemId = :itemId', { itemId: partId })
      .andWhere('inv.storageLocationId = :locationId', { locationId })
      .getRawOne();
    return Number(row?.total ?? 0);
  }
}
