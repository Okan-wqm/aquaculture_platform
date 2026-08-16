/**
 * StockMovementService
 *
 * # Canonical stock mutation authority
 *
 * Physical `storage_inventory` plus append-only `stock_movements` are the
 * write truth. `Feed.quantity` is a derived roll-up maintained by this same
 * service. No feeding-specific inventory writer or asynchronous repair path
 * is permitted.
 *
 * The storage OUT deduction happens INSIDE the feeding transaction and fails
 * closed. The inventory-mutation core (FEFO allocation, lot-mix detection,
 * projection update, item-total roll-up, idempotency, durable events, and the
 * immutable `stock_movement` fact) accepts a CALLER-PROVIDED transaction so a
 * feeding write and its stock facts commit or roll back ATOMICALLY.
 *
 * `RecordStockMovementHandler` is a thin adapter: it opens a transaction and
 * calls `recordMovement(manager, ...)`. Feeding callers use
 * `recordFeedDeduction(queryRunner.manager, ...)` inside their feeding
 * transaction. Every mutation path therefore shares one lock, projection,
 * immutable-fact, idempotency, and transactional-outbox authority.
 *
 * The legacy `feed_inventory` writers and read path are retired. Physical
 * `storage_inventory` plus immutable `stock_movements` are the stock truth;
 * `Feed.quantity` is a projection maintained only by this authority.
 *
 * @module Storage/Services
 */
import { createHash } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { tenantManagerRepo, TenantScopedRepository } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import type { LowStockDetectedEvent, StockMovementRecordedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';

import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import {
  StockMovement,
  MovementType,
  StockMutationOperationType,
} from '../entities/stock-movement.entity';
import {
  PurchaseOrder,
  PurchaseOrderCategory,
  PurchaseOrderStatus,
} from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { Feed, FeedStatus } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { ConditionWarning } from '../dto/stock-movement.response';
import { LotMixService } from './lot-mix.service';
import { FeedStockAllocationAuthority } from './feed-stock-allocation.authority';
import { StockMutationLockAuthority } from './stock-mutation-lock.authority';
import { stockQuantityFromUnits, stockQuantityUnits } from './stock-quantity';
import { TenantClockAuthority } from '../../common/time/tenant-clock.authority';
import {
  SiteAuthorizationService,
  type SiteScopeCaller,
} from '@aquaculture/backend-common/security';

const STOCK_OPERATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PURCHASE_ORDER_RECEIPT_HASH_DOMAIN = 'aquaculture.purchase-order-receipt/v1';

/**
 * Normalized inputs to a single stock movement. Mirrors the load-bearing
 * fields of `RecordStockMovementInput` but is a plain interface so callers
 * outside the GraphQL layer (feeding handlers) can construct it without
 * instantiating the class-validator DTO.
 */
export interface RecordMovementInput {
  movementType: MovementType;
  itemType: StorageItemType;
  itemId: string;
  quantity: number;
  fromLocationId?: string;
  toLocationId?: string;
  lotNumber?: string;
  expiryDate?: Date;
  receivedDate?: Date;
  reference?: string;
  reason?: string;
  idempotencyKey?: string;
  /**
   * Authoritative event timestamp for FEFO as-of scoping. For event-driven
   * flows (a feeding logged retroactively) the caller MUST set this to the
   * operational event moment so FEFO picks from lots that were actually in
   * inventory at that instant.
   */
  movementDate?: Date;
  /** Exact projection row selected by the locked allocation authority. */
  sourceInventoryId?: string;
  /** Stable logical allocation identity shared across FEFO slices. */
  allocationFamilyKey?: string;
  /** Root identity shared by the original allocation and all corrections. */
  allocationRootKey?: string;
  /** Zero-based deterministic position inside the allocation operation. */
  allocationSliceIndex?: number;
  /** Exact OUT fact restored by a RETURN movement. */
  sourceMovementId?: string;
  /** Typed coordinates for an immutable multi-fact stock operation. */
  operation?: StockMutationOperationRefV1;
}

export interface StockMutationOperationRefV1 {
  readonly type: StockMutationOperationType;
  readonly id: string;
  readonly payloadHash: string;
  readonly itemId: string;
}

export interface PurchaseOrderReceiptLineV1 {
  readonly purchaseOrderItemId: string;
  readonly quantityReceived: number;
  readonly lotNumber?: string;
  readonly expiryDate?: string;
}

export interface PurchaseOrderReceiptV1 {
  readonly operationId: string;
  readonly purchaseOrderId: string;
  readonly storageLocationId: string;
  readonly items: readonly PurchaseOrderReceiptLineV1[];
}

export interface FeedDeductionInput {
  readonly feedId: string;
  readonly quantityKg: number;
  readonly occurredAt: Date;
  readonly preferredSiteId?: string;
  readonly lotNumber?: string;
  readonly reference: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly allocationRootKey?: string;
}

export interface FeedDeductionResult {
  readonly movements: readonly StockMovement[];
  /** Null on replay because pool-at-first-commit is not reconstructed. */
  readonly poolTotalKg: number | null;
  /** Null on replay until allocation-scope evidence is projected from facts. */
  readonly usedTenantPool: boolean | null;
  readonly idempotentHit: boolean;
}

export interface FeedCorrectionInput {
  readonly feedId: string;
  readonly deltaKg: number;
  readonly sourceDeductionKey: string;
  readonly idempotencyKey: string;
  readonly occurredAt?: Date;
  readonly preferredSiteId?: string;
  readonly reference: string;
}

export interface PhysicalCountReconciliationInput {
  readonly itemType: StorageItemType;
  readonly itemId: string;
  readonly storageLocationId: string;
  readonly lotNumber?: string;
  readonly actualQuantity: number;
  readonly reference: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

interface DrawnLotIdentity {
  readonly inventoryId: string;
  readonly lotNumber?: string;
  readonly expiryDate?: Date;
  readonly receivedDate?: Date;
}

interface NormalizedPurchaseOrderReceiptLineV1 {
  readonly purchaseOrderItemId: string;
  readonly quantityReceived: number;
  readonly quantityUnits: number;
  readonly lotNumber?: string;
  readonly expiryDate?: Date;
  readonly expiryDateText?: string;
}

interface CompiledPurchaseOrderReceiptV1 {
  readonly payloadHash: string;
  readonly lines: readonly NormalizedPurchaseOrderReceiptLineV1[];
}

/** Identity context for a movement (who, which tenant). */
export interface MovementContext {
  tenantId: string;
  userId: string;
  /** Denormalized display name for the immutable audit row. */
  userName?: string;
  /**
   * SEC-HIGH-051: object-level site authorization for a DIRECT operator-issued
   * movement. Present ONLY when a human caller (RecordStockMovementHandler)
   * issues the movement — the sink then asserts the caller is assigned to each
   * touched location's site. ABSENT for feeding callers, which already authorize
   * at their OWN sink on the FEEDING site: a feed's storage warehouse may be a
   * different site the operator is legitimately not assigned to, so gating the
   * internal feed-deduction on the warehouse site would wrongly deny feeding.
   */
  siteAuthorization?: SiteScopeCaller;
}

/**
 * Result of `recordMovement`. `currentTotal` is the post-decrement
 * aggregate quantity across all locations for the item — the wrapper uses
 * it for low-stock detection AFTER commit.
 */
export interface RecordMovementResult {
  saved: StockMovement;
  /** Aggregate item quantity after the movement (only computed for OUT/WASTE). */
  currentTotal: number;
  /** True when the idempotency key matched an existing movement (no-op replay). */
  idempotentHit: boolean;
  warnings: ConditionWarning[];
  /**
   * Set when this OUT/WASTE movement left the item's aggregate at or below
   * its minStock. The matching durable `LowStockDetectedEvent` has already
   * been enqueued to the outbox INSIDE the caller's transaction by this
   * service (single low-stock sink); callers use this field only for
   * POST-COMMIT side effects (e.g. the in-process `inventory.lowStock`
   * auto-task trigger), never to re-emit the durable event.
   */
  lowStock: { severity: 'low_stock' | 'out_of_stock'; minimumThreshold?: number } | null;
}

@Injectable()
export class StockMovementService {
  private readonly logger = new Logger(StockMovementService.name);

  constructor(
    private readonly lotMixService: LotMixService,
    private readonly siteAuth: SiteAuthorizationService,
    // OutboxPublisher is provided app-wide by the @Global() FarmOutboxModule.
    // The low-stock signal is enqueued HERE (single sink) so EVERY writer —
    // manual movement, feeding deduction, PO receipt, adjustment — emits it
    // on the same transactional manager; no caller can forget it.
    private readonly outboxPublisher: OutboxPublisher,
    private readonly mutationLocks: StockMutationLockAuthority,
    private readonly feedAllocations: FeedStockAllocationAuthority,
    private readonly clock: TenantClockAuthority,
  ) {}

  /**
   * Record a single stock movement inside the CALLER's transaction.
   *
   * The caller owns the `EntityManager` (and therefore the transaction
   * boundary). This method performs every inventory mutation + the
   * immutable audit row, and throws `BadRequestException` /
   * `NotFoundException` on any violation — which, because the caller owns
   * the transaction, ROLLS BACK the caller's whole unit of work. This is
   * the architectural property that makes feed deduction atomic with the
   * feeding write (no more swallowed insufficient-stock failures).
   *
   * `StockMovementRecorded` and threshold-derived `LowStockDetected` are
   * enqueued here on the same manager. Callers must not duplicate those
   * durable facts; wrappers may emit post-commit in-process projections only.
   */
  async recordMovement(
    manager: EntityManager,
    input: RecordMovementInput,
    ctx: MovementContext,
  ): Promise<RecordMovementResult> {
    return this.recordMovementInternal(manager, input, ctx, true);
  }

  private async recordMovementInternal(
    manager: EntityManager,
    input: RecordMovementInput,
    ctx: MovementContext,
    emitLowStock: boolean,
  ): Promise<RecordMovementResult> {
    const { tenantId, userId, userName } = ctx;
    const { movementType, itemType, itemId, quantity } = input;

    stockQuantityUnits(quantity, 'Stock quantity');
    if (input.lotNumber != null && input.lotNumber.trim().length === 0) {
      throw new BadRequestException('Lot number cannot be blank');
    }

    await this.mutationLocks.acquire(manager, tenantId, [{ itemType, itemId }]);
    if (input.idempotencyKey) {
      await this.mutationLocks.acquireIdempotency(manager, tenantId, input.idempotencyKey);
    }

    const movementRepo = tenantManagerRepo(manager, StockMovement, tenantId);

    // Idempotency guard — at-most-once execution on retries / redelivery.
    // Checked INSIDE the transaction so a concurrent duplicate serialises
    // on the unique (tenant_id, idempotency_key) index rather than racing.
    if (input.idempotencyKey) {
      const existing = await movementRepo.findOne({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        this.assertReplayMatches(existing, input);
        this.logger.log(`Idempotent hit: movement ${existing.id} for key ${input.idempotencyKey}`);
        return {
          saved: existing,
          currentTotal: 0,
          idempotentHit: true,
          warnings: [],
          lowStock: null,
        };
      }
    }

    const itemDetails = await this.getItemDetails(manager, itemType, itemId, tenantId);
    if (!itemDetails) {
      throw new NotFoundException(`${itemType} with ID "${itemId}" not found`);
    }

    const { fromLocation, toLocation } = await this.resolveLocations(manager, input, tenantId);
    const operationClock = await this.clock.resolve(
      manager,
      tenantId,
      fromLocation?.siteId ?? toLocation?.siteId,
      input.movementDate,
    );

    // SEC-HIGH-051: object-level site authorization at the inventory-mutation
    // SINK. For a direct operator movement (ctx.siteAuthorization present), assert
    // the caller is assigned to EACH touched location's site BEFORE any write.
    // MODULE_MANAGER+ bypasses via the role hierarchy; an unassigned site for a
    // MODULE_USER DENIES (fail-closed). Feeding callers omit siteAuthorization —
    // they authorize at their own sink on the feeding site.
    if (ctx.siteAuthorization) {
      if (fromLocation) {
        this.siteAuth.assertSiteAssignment({
          caller: ctx.siteAuthorization,
          siteId: fromLocation.siteId,
        });
      }
      if (toLocation) {
        this.siteAuth.assertSiteAssignment({
          caller: ctx.siteAuthorization,
          siteId: toLocation.siteId,
        });
      }
    }

    // Condition warnings for inbound stock (temperature / humidity mismatch).
    const warnings: ConditionWarning[] = [];
    if (toLocation && (movementType === MovementType.IN || movementType === MovementType.RETURN)) {
      this.checkConditionWarnings(itemDetails, toLocation, warnings);
    }

    const inventoryRepo = tenantManagerRepo(manager, StorageInventory, tenantId);

    // asOfDate carries the operational event timestamp so FEFO picks from
    // lots that were ALREADY in inventory at that instant — a
    // retroactively-logged feeding cannot deduct from a lot that arrived
    // after the event occurred.
    let drawnLot: DrawnLotIdentity | null = null;
    if (fromLocation) {
      drawnLot = await this.decreaseInventory(
        inventoryRepo,
        tenantId,
        fromLocation.id,
        itemType,
        itemId,
        quantity,
        itemDetails.unit,
        input.lotNumber,
        userId,
        operationClock.instant,
        operationClock.localDate,
        input.sourceInventoryId,
      );
    }

    // Lot-mix detection — must run BEFORE increaseInventory so the service
    // sees the resident lots as "other" and not yet summed with the
    // incoming quantity.
    let effectiveLotNumber: string | null = null;
    const inboundLotNumber = input.lotNumber ?? drawnLot?.lotNumber;
    if (toLocation && inboundLotNumber) {
      const mixOutcome = await this.lotMixService.detect({
        tenantId,
        storageLocationId: toLocation.id,
        itemType,
        itemId,
        incomingLotNumber: inboundLotNumber,
        incomingQuantityKg: quantity,
        manufacturer: itemDetails.manufacturer ?? null,
        incomingExpiryDate: input.expiryDate ?? drawnLot?.expiryDate ?? null,
        userId,
        manager,
      });
      effectiveLotNumber = mixOutcome.effectiveLotNumber;
    }

    if (toLocation) {
      await this.increaseInventory(
        inventoryRepo,
        tenantId,
        toLocation.id,
        itemType,
        itemId,
        quantity,
        itemDetails.unit,
        input.lotNumber ?? drawnLot?.lotNumber,
        input.expiryDate ?? drawnLot?.expiryDate,
        input.receivedDate ?? drawnLot?.receivedDate,
        userId,
        operationClock.instant,
      );
    }

    // Roll the item's total quantity back onto the source entity
    // (Feed.quantity / Chemical.quantity / Consumable.quantity + status).
    await this.updateItemTotalQuantity(manager, itemType, itemId, tenantId);

    // Immutable audit row (EU 178/2002 lot traceability).
    const movement = movementRepo.create({
      tenantId,
      movementType,
      itemType,
      itemId,
      itemName: itemDetails.name,
      quantity,
      unit: itemDetails.unit,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      reference: input.reference,
      reason: input.reason,
      // An inverse fact must retain the exact cited source lot even when the
      // physical return creates a separate StorageLotMix relation.
      lotNumber:
        input.sourceMovementId != null
          ? (input.lotNumber ?? drawnLot?.lotNumber)
          : (effectiveLotNumber ?? input.lotNumber ?? drawnLot?.lotNumber),
      expiryDate: input.expiryDate ?? drawnLot?.expiryDate,
      receivedDate: input.receivedDate ?? drawnLot?.receivedDate,
      allocationFamilyKey: input.allocationFamilyKey,
      allocationRootKey: input.allocationRootKey,
      allocationSliceIndex: input.allocationSliceIndex,
      sourceMovementId: input.sourceMovementId,
      operationType: input.operation?.type,
      operationId: input.operation?.id,
      operationPayloadHash: input.operation?.payloadHash,
      operationItemId: input.operation?.itemId,
      idempotencyKey: input.idempotencyKey,
      performedBy: userId,
      performedByName: userName,
      performedAt: operationClock.instant,
    });
    const saved = await movementRepo.save(movement);

    const movementEvent: StockMovementRecordedEvent = {
      ...createBaseEvent<StockMovementRecordedEvent>('StockMovementRecorded', tenantId, {
        aggregateId: saved.id,
        aggregateType: 'StockMovement',
      }),
      userId,
      movementId: saved.id,
      movementType: saved.movementType,
      itemType: saved.itemType,
      itemId: saved.itemId,
      itemName: saved.itemName,
      quantity: saved.quantity,
      unit: saved.unit,
      fromLocationId: saved.fromLocationId,
      toLocationId: saved.toLocationId,
      lotNumber: saved.lotNumber,
    };
    await this.outboxPublisher.enqueue(movementEvent, manager, {
      aggregateId: saved.id,
      idempotencyKey: `stock-movement-recorded:${saved.id}`,
    });

    // Post-update aggregate quantity across all locations for the item —
    // read inside the tx so it reflects the just-applied mutation. Used for
    // low-stock detection on stock-reducing movements only.
    let currentTotal = 0;
    let lowStock: RecordMovementResult['lowStock'] = null;
    if (
      fromLocation &&
      (movementType === MovementType.OUT ||
        movementType === MovementType.WASTE ||
        (movementType === MovementType.ADJUSTMENT && !toLocation))
    ) {
      const stockResult = await tenantManagerRepo(manager, StorageInventory, tenantId)
        .createQueryBuilder('inv')
        .select('COALESCE(SUM(inv.quantity), 0)', 'total')
        .andWhere('inv.itemType = :itemType', { itemType })
        .andWhere('inv.itemId = :itemId', { itemId })
        .getRawOne();
      currentTotal = parseFloat(stockResult?.total ?? '0');

      // Single low-stock sink: threshold detection + the durable event live
      // at the mutation core, so a feeding deduction and a manual OUT emit
      // the SAME signal on the SAME transactional manager. Previously the
      // detection lived only in RecordStockMovementHandler, so feeding-driven
      // depletion never raised LowStockDetected (findings register
      // FARM-HIGH-217 leg of the dead alert chain).
      const minStock = Number(itemDetails.minStock ?? 0);
      if (currentTotal <= 0) {
        lowStock = {
          severity: 'out_of_stock',
          minimumThreshold: minStock > 0 ? minStock : undefined,
        };
      } else if (minStock > 0 && currentTotal <= minStock) {
        lowStock = { severity: 'low_stock', minimumThreshold: minStock };
      }

      if (lowStock && emitLowStock) {
        const lowStockEvent: LowStockDetectedEvent = {
          ...createBaseEvent<LowStockDetectedEvent>('LowStockDetected', tenantId),
          itemType,
          itemId,
          itemName: itemDetails.name,
          currentQuantity: currentTotal,
          unit: itemDetails.unit,
          minimumThreshold: lowStock.minimumThreshold,
          severity: lowStock.severity,
        };
        await this.outboxPublisher.enqueue(lowStockEvent, manager);
      }
    }

    return { saved, currentTotal, idempotentHit: false, warnings, lowStock };
  }

  /**
   * Compile one caller-identified purchase-order receipt into immutable stock
   * facts and the PO cumulative projection. This is the sole receipt mutation
   * authority: the command handler owns only the tenant transaction boundary.
   *
   * The operation fence is tenant-global and acquired before the PO row lock.
   * Equal-quantity deliveries with different operation ids are independent;
   * a retry with the same operation id succeeds only when its entire canonical
   * payload (including actor and every line) is byte-equivalent.
   */
  async recordPurchaseOrderReceipt(
    manager: EntityManager,
    input: PurchaseOrderReceiptV1,
    ctx: MovementContext,
  ): Promise<PurchaseOrder> {
    const compiled = this.compilePurchaseOrderReceipt(input, ctx);
    const operationLockKey = `po-receipt:${input.operationId.toLowerCase()}`;
    await this.mutationLocks.acquireIdempotency(manager, ctx.tenantId, operationLockKey);

    const poRepo = tenantManagerRepo(manager, PurchaseOrder, ctx.tenantId);
    const po = await poRepo.findOne({
      where: { id: input.purchaseOrderId, tenantId: ctx.tenantId, isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (!po) {
      throw new NotFoundException(`Purchase order "${input.purchaseOrderId}" not found`);
    }

    const itemRepo = tenantManagerRepo(manager, PurchaseOrderItem, ctx.tenantId);
    const poItems = await itemRepo.find({
      where: {
        tenantId: ctx.tenantId,
        purchaseOrderId: po.id,
      },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    po.items = poItems;

    const movementRepo = tenantManagerRepo(manager, StockMovement, ctx.tenantId);
    const existingOperation = await movementRepo.find({
      where: {
        tenantId: ctx.tenantId,
        operationType: StockMutationOperationType.PURCHASE_ORDER_RECEIPT,
        operationId: input.operationId,
      },
      order: { operationItemId: 'ASC', id: 'ASC' },
    });
    const storageItemType = this.storageItemTypeForPurchaseOrder(po.category);
    const lines = this.resolvePurchaseOrderReceiptLines(po, compiled.lines);

    if (existingOperation.length > 0) {
      this.assertPurchaseOrderReceiptReplay(
        existingOperation,
        lines,
        input,
        compiled.payloadHash,
        po,
        storageItemType,
        ctx,
      );
      return po;
    }

    if (
      po.status !== PurchaseOrderStatus.ORDERED &&
      po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw new BadRequestException(
        'PO must be in ORDERED or PARTIALLY_RECEIVED status to receive delivery',
      );
    }

    const nextQuantityByItem = new Map<string, number>();
    for (const { line, poItem } of lines) {
      const orderedUnits = stockQuantityUnits(Number(poItem.quantity), 'Ordered quantity');
      const receivedUnits = stockQuantityUnits(
        Number(poItem.quantityReceived),
        'Previously received quantity',
        { allowZero: true },
      );
      const nextUnits = receivedUnits + line.quantityUnits;
      if (nextUnits > orderedUnits) {
        throw new BadRequestException(
          `Cannot receive ${line.quantityReceived} of ${poItem.itemName}. ` +
            `Ordered: ${poItem.quantity}, Already received: ${poItem.quantityReceived}`,
        );
      }
      nextQuantityByItem.set(poItem.id, stockQuantityFromUnits(nextUnits));
    }

    let receiptInstant: Date | undefined;
    for (const { line, poItem } of lines) {
      const movement = await this.recordMovementInternal(
        manager,
        {
          movementType: MovementType.IN,
          itemType: storageItemType,
          itemId: poItem.itemId,
          quantity: line.quantityReceived,
          toLocationId: input.storageLocationId,
          lotNumber: line.lotNumber,
          expiryDate: line.expiryDate,
          reference: `PO: ${po.orderNumber}`,
          idempotencyKey: this.purchaseOrderReceiptMovementKey(input.operationId, poItem.id),
          operation: {
            type: StockMutationOperationType.PURCHASE_ORDER_RECEIPT,
            id: input.operationId,
            payloadHash: compiled.payloadHash,
            itemId: poItem.id,
          },
        },
        ctx,
        true,
      );
      if (movement.idempotentHit) {
        throw new ConflictException(
          `Purchase-order receipt ${input.operationId} has incomplete operation evidence`,
        );
      }
      receiptInstant ??= movement.saved.performedAt;
    }

    for (const { poItem } of lines) {
      const nextQuantity = nextQuantityByItem.get(poItem.id);
      if (nextQuantity == null) {
        throw new ConflictException(`Missing compiled quantity for PO item ${poItem.id}`);
      }
      poItem.quantityReceived = nextQuantity;
      poItem.isFullyReceived =
        stockQuantityUnits(nextQuantity, 'Received quantity', { allowZero: true }) ===
        stockQuantityUnits(Number(poItem.quantity), 'Ordered quantity');
    }
    for (const { poItem } of lines) {
      await itemRepo.save(poItem);
    }

    if (po.items.every((item) => item.isFullyReceived)) {
      po.status = PurchaseOrderStatus.RECEIVED;
      po.actualDeliveryDate = receiptInstant;
    } else {
      po.status = PurchaseOrderStatus.PARTIALLY_RECEIVED;
    }
    return poRepo.save(po);
  }

  private compilePurchaseOrderReceipt(
    input: PurchaseOrderReceiptV1,
    ctx: MovementContext,
  ): CompiledPurchaseOrderReceiptV1 {
    if (!STOCK_OPERATION_UUID.test(input.operationId)) {
      throw new BadRequestException('Purchase-order receipt operationId must be a UUID');
    }
    if (input.items.length === 0) {
      throw new BadRequestException('Purchase-order receipt requires at least one item');
    }

    const lines = input.items
      .map((line): NormalizedPurchaseOrderReceiptLineV1 => {
        if (!STOCK_OPERATION_UUID.test(line.purchaseOrderItemId)) {
          throw new BadRequestException('Purchase-order receipt item identity must be a UUID');
        }
        const quantityUnits = stockQuantityUnits(line.quantityReceived, 'Received quantity');
        const lotNumber = line.lotNumber?.trim();
        if (line.lotNumber != null && !lotNumber) {
          throw new BadRequestException('Lot number cannot be blank');
        }
        let expiryDate: Date | undefined;
        let expiryDateText: string | undefined;
        if (line.expiryDate != null) {
          if (!/^\d{4}-\d{2}-\d{2}$/u.test(line.expiryDate)) {
            throw new BadRequestException('Expiry date must use YYYY-MM-DD');
          }
          expiryDate = new Date(`${line.expiryDate}T00:00:00.000Z`);
          if (
            Number.isNaN(expiryDate.getTime()) ||
            expiryDate.toISOString().slice(0, 10) !== line.expiryDate
          ) {
            throw new BadRequestException('Expiry date must be a real calendar date');
          }
          expiryDateText = line.expiryDate;
        }
        return {
          purchaseOrderItemId: line.purchaseOrderItemId.toLowerCase(),
          quantityReceived: stockQuantityFromUnits(quantityUnits),
          quantityUnits,
          lotNumber,
          expiryDate,
          expiryDateText,
        };
      })
      .sort((left, right) => left.purchaseOrderItemId.localeCompare(right.purchaseOrderItemId));

    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index - 1]?.purchaseOrderItemId === lines[index]?.purchaseOrderItemId) {
        throw new BadRequestException(
          `Purchase-order item ${lines[index]?.purchaseOrderItemId} occurs more than once`,
        );
      }
    }

    const hash = createHash('sha256');
    const write = (value: string): void => {
      hash.update(String(Buffer.byteLength(value, 'utf8')));
      hash.update(':');
      hash.update(value);
    };
    write(PURCHASE_ORDER_RECEIPT_HASH_DOMAIN);
    write(ctx.tenantId.toLowerCase());
    write(ctx.userId.toLowerCase());
    write(input.purchaseOrderId.toLowerCase());
    write(input.storageLocationId.toLowerCase());
    write(String(lines.length));
    for (const line of lines) {
      write(line.purchaseOrderItemId);
      write(String(line.quantityUnits));
      write(line.lotNumber ?? '');
      write(line.expiryDateText ?? '');
    }
    return { payloadHash: hash.digest('hex'), lines };
  }

  private resolvePurchaseOrderReceiptLines(
    po: PurchaseOrder,
    lines: readonly NormalizedPurchaseOrderReceiptLineV1[],
  ): Array<{ line: NormalizedPurchaseOrderReceiptLineV1; poItem: PurchaseOrderItem }> {
    const byId = new Map(po.items.map((item) => [item.id.toLowerCase(), item]));
    return lines.map((line) => {
      const poItem = byId.get(line.purchaseOrderItemId);
      if (!poItem) {
        throw new BadRequestException(
          `Purchase-order item ${line.purchaseOrderItemId} was not found in PO ${po.id}`,
        );
      }
      return { line, poItem };
    });
  }

  private assertPurchaseOrderReceiptReplay(
    existing: readonly StockMovement[],
    lines: ReadonlyArray<{
      line: NormalizedPurchaseOrderReceiptLineV1;
      poItem: PurchaseOrderItem;
    }>,
    input: PurchaseOrderReceiptV1,
    payloadHash: string,
    po: PurchaseOrder,
    itemType: StorageItemType,
    ctx: MovementContext,
  ): void {
    const expectedByItem = new Map(lines.map((entry) => [entry.poItem.id, entry]));
    const operationMismatch =
      existing.length !== lines.length ||
      existing.some((movement) => {
        const operationItemId = movement.operationItemId;
        const expected = operationItemId ? expectedByItem.get(operationItemId) : undefined;
        if (!expected) return true;
        expectedByItem.delete(operationItemId);
        return (
          movement.operationType !== StockMutationOperationType.PURCHASE_ORDER_RECEIPT ||
          movement.operationId !== input.operationId ||
          movement.operationPayloadHash !== payloadHash ||
          movement.movementType !== MovementType.IN ||
          movement.itemType !== itemType ||
          movement.itemId !== expected.poItem.itemId ||
          Math.abs(Number(movement.quantity) - expected.line.quantityReceived) > 1e-9 ||
          movement.toLocationId !== input.storageLocationId ||
          movement.reference !== `PO: ${po.orderNumber}` ||
          movement.performedBy !== ctx.userId ||
          !this.sameOptionalDate(movement.expiryDate, expected.line.expiryDate)
        );
      }) ||
      expectedByItem.size !== 0;
    if (operationMismatch) {
      throw new ConflictException(
        `Purchase-order receipt ${input.operationId} is bound to a different payload or has incomplete evidence`,
      );
    }
  }

  private storageItemTypeForPurchaseOrder(category: PurchaseOrderCategory): StorageItemType {
    switch (category) {
      case PurchaseOrderCategory.FEED:
        return StorageItemType.FEED;
      case PurchaseOrderCategory.CHEMICAL:
        return StorageItemType.CHEMICAL;
      case PurchaseOrderCategory.CONSUMABLE:
        return StorageItemType.CONSUMABLE;
      case PurchaseOrderCategory.HEALTHCARE:
        return StorageItemType.HEALTHCARE;
      default:
        throw new BadRequestException(`Unsupported purchase-order category: ${String(category)}`);
    }
  }

  private purchaseOrderReceiptMovementKey(operationId: string, poItemId: string): string {
    return createHash('sha256')
      .update('aquaculture.purchase-order-receipt-movement/v1\u0000')
      .update(operationId.toLowerCase())
      .update('\u0000')
      .update(poItemId.toLowerCase())
      .digest('hex');
  }

  private sameOptionalDate(left?: Date, right?: Date): boolean {
    if (left == null || right == null) return left == null && right == null;
    return new Date(left).getTime() === new Date(right).getTime();
  }

  /**
   * Atomic feeding allocation: item fence -> complete locked pool -> immutable
   * movement slices. Missing or depleted stock always fails closed.
   */
  async recordFeedDeduction(
    manager: EntityManager,
    input: FeedDeductionInput,
    ctx: MovementContext,
  ): Promise<FeedDeductionResult> {
    this.assertAllocationKey(input.idempotencyKey);
    await this.mutationLocks.acquire(manager, ctx.tenantId, [
      { itemType: StorageItemType.FEED, itemId: input.feedId },
    ]);
    await this.mutationLocks.acquireIdempotency(manager, ctx.tenantId, input.idempotencyKey);
    const movementRepo = tenantManagerRepo(manager, StockMovement, ctx.tenantId);
    const existing = await movementRepo.find({
      where: {
        tenantId: ctx.tenantId,
        itemType: StorageItemType.FEED,
        itemId: input.feedId,
        allocationFamilyKey: input.idempotencyKey,
      },
      order: { allocationSliceIndex: 'ASC', id: 'ASC' },
    });
    if (existing.length > 0) {
      const existingTotal = existing.reduce(
        (total, movement) => total + Number(movement.quantity),
        0,
      );
      const expectedRoot = input.allocationRootKey ?? input.idempotencyKey;
      if (
        existing.some((movement) => movement.movementType !== MovementType.OUT) ||
        existing.some((movement) => movement.allocationRootKey !== expectedRoot) ||
        existing.some((movement) => movement.reference !== input.reference) ||
        existing.some((movement) => movement.reason !== input.reason) ||
        existing.some(
          (movement) => input.lotNumber != null && movement.lotNumber !== input.lotNumber,
        ) ||
        existing.some(
          (movement) => new Date(movement.performedAt).getTime() !== input.occurredAt.getTime(),
        ) ||
        Math.abs(existingTotal - input.quantityKg) > 1e-9
      ) {
        throw new ConflictException(
          'Feed deduction idempotency key is bound to a different allocation',
        );
      }
      return {
        movements: existing,
        poolTotalKg: null,
        usedTenantPool: null,
        idempotentHit: true,
      };
    }

    const allocation = await this.feedAllocations.allocate(manager, ctx.tenantId, {
      feedId: input.feedId,
      quantityKg: input.quantityKg,
      occurredAt: input.occurredAt,
      preferredSiteId: input.preferredSiteId,
      lotNumber: input.lotNumber,
    });
    const movements: StockMovement[] = [];
    for (const [index, slice] of allocation.slices.entries()) {
      const sliceKey = this.deriveSliceKey(input.idempotencyKey, index);
      const result = await this.recordMovementInternal(
        manager,
        {
          movementType: MovementType.OUT,
          itemType: StorageItemType.FEED,
          itemId: input.feedId,
          quantity: slice.quantityKg,
          fromLocationId: slice.storageLocationId,
          lotNumber: slice.lotNumber ?? undefined,
          expiryDate: slice.expiryDate ?? undefined,
          receivedDate: slice.receivedDate ?? undefined,
          reference: input.reference,
          reason: input.reason,
          idempotencyKey: sliceKey,
          allocationFamilyKey: input.idempotencyKey,
          allocationRootKey: input.allocationRootKey ?? input.idempotencyKey,
          allocationSliceIndex: index,
          sourceInventoryId: slice.inventoryId,
          movementDate: input.occurredAt,
        },
        ctx,
        index === allocation.slices.length - 1,
      );
      movements.push(result.saved);
    }
    return {
      movements,
      poolTotalKg: allocation.poolTotalKg,
      usedTenantPool: allocation.usedTenantPool,
      idempotentHit: false,
    };
  }

  /**
   * Corrects an immutable feed allocation without losing lot provenance.
   * Positive deltas compile a new FEFO family. Negative deltas restore exact
   * source movements in reverse draw order, bounded by the unreturned amount.
   */
  async correctFeedDeduction(
    manager: EntityManager,
    input: FeedCorrectionInput,
    ctx: MovementContext,
  ): Promise<readonly StockMovement[]> {
    if (input.deltaKg === 0) return [];
    stockQuantityUnits(Math.abs(input.deltaKg), 'Feed correction quantity');
    const occurredAt =
      input.occurredAt ??
      (await this.clock.resolve(manager, ctx.tenantId, input.preferredSiteId)).instant;
    if (input.deltaKg > 0) {
      return (
        await this.recordFeedDeduction(
          manager,
          {
            feedId: input.feedId,
            quantityKg: input.deltaKg,
            occurredAt,
            preferredSiteId: input.preferredSiteId,
            reference: input.reference,
            reason: 'Upward feeding correction',
            idempotencyKey: input.idempotencyKey,
            allocationRootKey: input.sourceDeductionKey,
          },
          ctx,
        )
      ).movements;
    }

    await this.mutationLocks.acquire(manager, ctx.tenantId, [
      { itemType: StorageItemType.FEED, itemId: input.feedId },
    ]);
    await this.mutationLocks.acquireIdempotency(manager, ctx.tenantId, input.idempotencyKey);
    const movementRepo = tenantManagerRepo(manager, StockMovement, ctx.tenantId);
    const existingCorrection = await movementRepo.find({
      where: {
        tenantId: ctx.tenantId,
        itemType: StorageItemType.FEED,
        itemId: input.feedId,
        allocationFamilyKey: input.idempotencyKey,
      },
      order: { allocationSliceIndex: 'ASC', id: 'ASC' },
    });
    if (existingCorrection.length > 0) {
      const correctedTotal = existingCorrection.reduce(
        (total, movement) => total + Number(movement.quantity),
        0,
      );
      if (
        existingCorrection.some((movement) => movement.movementType !== MovementType.RETURN) ||
        existingCorrection.some(
          (movement) => movement.allocationRootKey !== input.sourceDeductionKey,
        ) ||
        Math.abs(correctedTotal - Math.abs(input.deltaKg)) > 1e-9
      ) {
        throw new ConflictException(
          'Feed correction idempotency key is bound to a different correction',
        );
      }
      return existingCorrection;
    }
    const originals = await movementRepo.find({
      where: {
        tenantId: ctx.tenantId,
        itemType: StorageItemType.FEED,
        itemId: input.feedId,
        movementType: MovementType.OUT,
        allocationRootKey: input.sourceDeductionKey,
      },
      order: { createdAt: 'DESC', allocationSliceIndex: 'DESC', id: 'DESC' },
    });
    if (originals.length === 0) {
      throw new ConflictException(
        `Original feed allocation ${input.sourceDeductionKey} was not found`,
      );
    }
    const returns = await movementRepo.find({
      where: originals.map((movement) => ({
        tenantId: ctx.tenantId,
        sourceMovementId: movement.id,
        movementType: MovementType.RETURN,
      })),
    });
    const returnedBySource = new Map<string, number>();
    for (const movement of returns) {
      if (!movement.sourceMovementId) continue;
      returnedBySource.set(
        movement.sourceMovementId,
        (returnedBySource.get(movement.sourceMovementId) ?? 0) + Number(movement.quantity),
      );
    }

    let remaining = Math.abs(input.deltaKg);
    const restored: StockMovement[] = [];
    for (const original of originals) {
      if (remaining <= 1e-9) break;
      if (!original.fromLocationId) {
        throw new ConflictException(`Stock movement ${original.id} has no source location`);
      }
      const available = Number(original.quantity) - (returnedBySource.get(original.id) ?? 0);
      if (available <= 1e-9) continue;
      const quantity = Math.min(remaining, available);
      const sliceKey = this.deriveSliceKey(input.idempotencyKey, restored.length);
      const result = await this.recordMovementInternal(
        manager,
        {
          movementType: MovementType.RETURN,
          itemType: StorageItemType.FEED,
          itemId: input.feedId,
          quantity,
          toLocationId: original.fromLocationId,
          lotNumber: original.lotNumber,
          expiryDate: original.expiryDate,
          receivedDate: original.receivedDate,
          reference: input.reference,
          reason: 'Downward feeding correction returned to the exact source allocation',
          idempotencyKey: sliceKey,
          allocationFamilyKey: input.idempotencyKey,
          allocationRootKey: input.sourceDeductionKey,
          allocationSliceIndex: restored.length,
          sourceMovementId: original.id,
          movementDate: occurredAt,
        },
        ctx,
        false,
      );
      restored.push(result.saved);
      remaining -= quantity;
    }
    if (remaining > 1e-9) {
      throw new ConflictException(
        `Correction exceeds the unreturned quantity of ${input.sourceDeductionKey}`,
      );
    }
    return restored;
  }

  private assertAllocationKey(key: string): void {
    if (key.length === 0 || key.length > 64) {
      throw new BadRequestException('Feed allocation idempotency key must be 1..64 characters');
    }
  }

  private deriveSliceKey(operationKey: string, index: number): string {
    this.assertAllocationKey(operationKey);
    if (index === 0) return operationKey;
    const candidate = `${operationKey}:${index}`;
    if (candidate.length <= 64) return candidate;
    return createHash('sha256')
      .update(`stock-allocation-slice-v1\u0000${operationKey}\u0000${index}`)
      .digest('hex');
  }

  /** Reconciles a physical count through the same canonical mutation sink. */
  async reconcilePhysicalCount(
    manager: EntityManager,
    input: PhysicalCountReconciliationInput,
    ctx: MovementContext,
  ): Promise<StockMovement | null> {
    stockQuantityUnits(input.actualQuantity, 'Physical count quantity', { allowZero: true });
    await this.mutationLocks.acquire(manager, ctx.tenantId, [
      { itemType: input.itemType, itemId: input.itemId },
    ]);
    const inventory = await tenantManagerRepo(manager, StorageInventory, ctx.tenantId).findOne({
      where: {
        tenantId: ctx.tenantId,
        storageLocationId: input.storageLocationId,
        itemType: input.itemType,
        itemId: input.itemId,
        lotNumber: input.lotNumber ?? IsNull(),
      },
      lock: { mode: 'pessimistic_write' },
    });
    const delta = input.actualQuantity - Number(inventory?.quantity ?? 0);
    if (Math.abs(delta) <= 1e-9) return null;
    return (
      await this.recordMovementInternal(
        manager,
        {
          movementType: MovementType.ADJUSTMENT,
          itemType: input.itemType,
          itemId: input.itemId,
          quantity: Math.abs(delta),
          fromLocationId: delta < 0 ? input.storageLocationId : undefined,
          toLocationId: delta > 0 ? input.storageLocationId : undefined,
          lotNumber: input.lotNumber,
          reference: input.reference,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
        ctx,
        true,
      )
    ).saved;
  }

  /**
   * Validate and load the from/to locations per movement type. Mirrors the
   * rules the handler enforced: IN/RETURN require toLocationId, OUT/WASTE
   * require fromLocationId, ADJUSTMENT needs at least one.
   */
  private async resolveLocations(
    manager: EntityManager,
    input: RecordMovementInput,
    tenantId: string,
  ): Promise<{ fromLocation: StorageLocation | null; toLocation: StorageLocation | null }> {
    const locationRepo = tenantManagerRepo(manager, StorageLocation, tenantId);
    let fromLocation: StorageLocation | null = null;
    let toLocation: StorageLocation | null = null;
    const { movementType } = input;

    if (movementType === MovementType.IN || movementType === MovementType.RETURN) {
      if (!input.toLocationId) {
        throw new BadRequestException(`toLocationId is required for ${movementType} movements`);
      }
      toLocation = await locationRepo.findOne({ where: { id: input.toLocationId, tenantId } });
      if (!toLocation) {
        throw new NotFoundException(`Storage location "${input.toLocationId}" not found`);
      }
    }

    if (movementType === MovementType.OUT || movementType === MovementType.WASTE) {
      if (!input.fromLocationId) {
        throw new BadRequestException(`fromLocationId is required for ${movementType} movements`);
      }
      fromLocation = await locationRepo.findOne({ where: { id: input.fromLocationId, tenantId } });
      if (!fromLocation) {
        throw new NotFoundException(`Storage location "${input.fromLocationId}" not found`);
      }
    }

    if (movementType === MovementType.TRANSFER) {
      if (!input.fromLocationId || !input.toLocationId) {
        throw new BadRequestException(
          'Both fromLocationId and toLocationId are required for transfers',
        );
      }
      if (input.fromLocationId === input.toLocationId) {
        throw new BadRequestException('Cannot transfer stock to the same location');
      }
      [fromLocation, toLocation] = await Promise.all([
        locationRepo.findOne({ where: { id: input.fromLocationId, tenantId } }),
        locationRepo.findOne({ where: { id: input.toLocationId, tenantId } }),
      ]);
      if (!fromLocation) {
        throw new NotFoundException(`Storage location "${input.fromLocationId}" not found`);
      }
      if (!toLocation) {
        throw new NotFoundException(`Storage location "${input.toLocationId}" not found`);
      }
    }

    if (movementType === MovementType.ADJUSTMENT) {
      if (!input.toLocationId && !input.fromLocationId) {
        throw new BadRequestException(
          'Either fromLocationId or toLocationId is required for adjustments',
        );
      }
      if (input.toLocationId) {
        toLocation = await locationRepo.findOne({ where: { id: input.toLocationId, tenantId } });
        if (!toLocation) {
          throw new NotFoundException(`Storage location "${input.toLocationId}" not found`);
        }
      }
      if (input.fromLocationId) {
        fromLocation = await locationRepo.findOne({
          where: { id: input.fromLocationId, tenantId },
        });
        if (!fromLocation) {
          throw new NotFoundException(`Storage location "${input.fromLocationId}" not found`);
        }
      }
    }

    return { fromLocation, toLocation };
  }

  private assertReplayMatches(existing: StockMovement, input: RecordMovementInput): void {
    const mismatches: string[] = [];
    const sameText = (left: string | null | undefined, right: string | null | undefined) =>
      (left ?? null) === (right ?? null);
    const sameDate = (left: Date | null | undefined, right: Date | null | undefined) => {
      if (left == null || right == null) return left == null && right == null;
      return new Date(left).getTime() === new Date(right).getTime();
    };
    if (existing.movementType !== input.movementType) mismatches.push('movementType');
    if (existing.itemType !== input.itemType) mismatches.push('itemType');
    if (existing.itemId !== input.itemId) mismatches.push('itemId');
    if (Math.abs(Number(existing.quantity) - input.quantity) > 1e-9) mismatches.push('quantity');
    if (!sameText(existing.fromLocationId, input.fromLocationId)) mismatches.push('fromLocationId');
    if (!sameText(existing.toLocationId, input.toLocationId)) mismatches.push('toLocationId');
    if (!sameText(existing.lotNumber, input.lotNumber)) mismatches.push('lotNumber');
    if (!sameDate(existing.expiryDate, input.expiryDate)) mismatches.push('expiryDate');
    if (!sameDate(existing.receivedDate, input.receivedDate)) mismatches.push('receivedDate');
    if (!sameText(existing.reference, input.reference)) mismatches.push('reference');
    if (!sameText(existing.reason, input.reason)) mismatches.push('reason');
    if (!sameText(existing.allocationFamilyKey, input.allocationFamilyKey)) {
      mismatches.push('allocationFamilyKey');
    }
    if (!sameText(existing.allocationRootKey, input.allocationRootKey)) {
      mismatches.push('allocationRootKey');
    }
    if ((existing.allocationSliceIndex ?? null) !== (input.allocationSliceIndex ?? null)) {
      mismatches.push('allocationSliceIndex');
    }
    if (!sameText(existing.sourceMovementId, input.sourceMovementId)) {
      mismatches.push('sourceMovementId');
    }
    if (!sameText(existing.operationType, input.operation?.type)) {
      mismatches.push('operationType');
    }
    if (!sameText(existing.operationId, input.operation?.id)) {
      mismatches.push('operationId');
    }
    if (!sameText(existing.operationPayloadHash, input.operation?.payloadHash)) {
      mismatches.push('operationPayloadHash');
    }
    if (!sameText(existing.operationItemId, input.operation?.itemId)) {
      mismatches.push('operationItemId');
    }
    if (mismatches.length > 0) {
      throw new ConflictException(
        `Stock movement idempotency key is bound to a different payload (${mismatches.join(', ')})`,
      );
    }
  }

  private async getItemDetails(
    manager: EntityManager,
    itemType: StorageItemType,
    itemId: string,
    tenantId: string,
  ): Promise<{
    name: string;
    unit: string;
    minStock?: number;
    manufacturer?: string;
    storageTempMin?: number;
    storageTempMax?: number;
    storageHumidityMin?: number;
    storageHumidityMax?: number;
  } | null> {
    switch (itemType) {
      case StorageItemType.FEED: {
        const feed = await tenantManagerRepo(manager, Feed, tenantId).findOne({
          where: { id: itemId, tenantId },
        });
        return feed
          ? {
              name: feed.name,
              unit: feed.unit,
              minStock: feed.minStock,
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
              minStock: chem.minStock,
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
              minStock: cons.minStock,
              storageTempMin: cons.storageTempMin,
              storageTempMax: cons.storageTempMax,
              storageHumidityMin: cons.storageHumidityMin,
              storageHumidityMax: cons.storageHumidityMax,
            }
          : null;
      }
      default:
        return null;
    }
  }

  private checkConditionWarnings(
    item: {
      storageTempMin?: number;
      storageTempMax?: number;
      storageHumidityMin?: number;
      storageHumidityMax?: number;
    },
    location: StorageLocation,
    warnings: ConditionWarning[],
  ): void {
    // Temperature check
    if (item.storageTempMin != null || item.storageTempMax != null) {
      if (location.temperatureMin != null || location.temperatureMax != null) {
        const locMin = location.temperatureMin ?? -Infinity;
        const locMax = location.temperatureMax ?? Infinity;
        const itemMin = item.storageTempMin ?? -Infinity;
        const itemMax = item.storageTempMax ?? Infinity;

        if (locMin > itemMax || locMax < itemMin) {
          warnings.push({
            field: 'temperature',
            message: `Item requires ${item.storageTempMin ?? '?'}-${item.storageTempMax ?? '?'}°C but location provides ${location.temperatureMin ?? '?'}-${location.temperatureMax ?? '?'}°C`,
            itemMin: item.storageTempMin,
            itemMax: item.storageTempMax,
            locationMin: location.temperatureMin,
            locationMax: location.temperatureMax,
          });
        }
      }
    }

    // Humidity check
    if (item.storageHumidityMin != null || item.storageHumidityMax != null) {
      if (location.humidityMin != null || location.humidityMax != null) {
        const locMin = location.humidityMin ?? 0;
        const locMax = location.humidityMax ?? 100;
        const itemMin = item.storageHumidityMin ?? 0;
        const itemMax = item.storageHumidityMax ?? 100;

        if (locMin > itemMax || locMax < itemMin) {
          warnings.push({
            field: 'humidity',
            message: `Item requires ${item.storageHumidityMin ?? '?'}-${item.storageHumidityMax ?? '?'}% humidity but location provides ${location.humidityMin ?? '?'}-${location.humidityMax ?? '?'}%`,
            itemMin: item.storageHumidityMin,
            itemMax: item.storageHumidityMax,
            locationMin: location.humidityMin,
            locationMax: location.humidityMax,
          });
        }
      }
    }
  }

  /**
   * FEFO (First-Expired-First-Out) decrement with three compliance
   * guarantees: deterministic tiebreak (expiryDate, receivedDate,
   * lotNumber), expired-lot exclusion, and as-of scoping for backdating
   * safety. Pessimistic write lock prevents concurrent double-spend.
   *
   * Throws BadRequestException when no lot is found or stock is
   * insufficient — the caller's transaction rolls back. This is the
   * fail-closed property that ends the silent feed-stock divergence.
   */
  private async decreaseInventory(
    repo: TenantScopedRepository<StorageInventory>,
    tenantId: string,
    locationId: string,
    itemType: StorageItemType,
    itemId: string,
    quantity: number,
    unit: string,
    lotNumber: string | undefined,
    userId: string,
    asOfDate: Date,
    localDate: string,
    sourceInventoryId?: string,
  ): Promise<DrawnLotIdentity> {
    let inventory: StorageInventory | null;

    if (sourceInventoryId) {
      inventory = await repo.findOne({
        where: {
          id: sourceInventoryId,
          tenantId,
          storageLocationId: locationId,
          itemType,
          itemId,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (inventory && lotNumber !== undefined && inventory.lotNumber !== lotNumber) {
        throw new ConflictException('Locked feed allocation lot identity changed');
      }
    } else if (lotNumber) {
      inventory = await repo.findOne({
        where: { tenantId, storageLocationId: locationId, itemType, itemId, lotNumber },
        lock: { mode: 'pessimistic_write' },
      });
    } else {
      inventory = await repo
        .createQueryBuilder('inv')
        .andWhere('inv.storageLocationId = :locationId', { locationId })
        .andWhere('inv.itemType = :itemType', { itemType })
        .andWhere('inv.itemId = :itemId', { itemId })
        .andWhere('inv.quantity > 0')
        .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :localDate)', { localDate })
        .andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', { asOf: asOfDate })
        .orderBy('inv.expiryDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.receivedDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.lotNumber', 'ASC')
        .setLock('pessimistic_write')
        .getOne();
    }

    if (!inventory) {
      throw new BadRequestException('No inventory found for this item in the specified location');
    }

    if (Number(inventory.quantity) < quantity) {
      throw new BadRequestException(
        `Insufficient stock. Available: ${inventory.quantity} ${unit}, Requested: ${quantity} ${unit}`,
      );
    }

    const drawn: DrawnLotIdentity = {
      inventoryId: inventory.id,
      lotNumber: inventory.lotNumber,
      expiryDate: inventory.expiryDate,
      receivedDate: inventory.receivedDate,
    };
    inventory.quantity = Number(inventory.quantity) - quantity;
    inventory.updatedBy = userId;

    if (inventory.quantity <= 0) {
      await repo.remove(inventory);
    } else {
      await repo.save(inventory);
    }
    return drawn;
  }

  private async increaseInventory(
    repo: TenantScopedRepository<StorageInventory>,
    tenantId: string,
    locationId: string,
    itemType: StorageItemType,
    itemId: string,
    quantity: number,
    unit: string,
    lotNumber: string | undefined,
    expiryDate: Date | undefined,
    receivedDate: Date | undefined,
    userId: string,
    operationInstant: Date,
  ): Promise<void> {
    let inventory = await repo.findOne({
      where: {
        tenantId,
        storageLocationId: locationId,
        itemType,
        itemId,
        lotNumber: lotNumber ?? IsNull(),
      },
    });

    if (inventory) {
      inventory.quantity = Number(inventory.quantity) + quantity;
      inventory.updatedBy = userId;
      if (expiryDate) inventory.expiryDate = expiryDate;
      // Do NOT refresh `receivedDate` on restock — the original arrival
      // date is the FEFO tiebreaker and must stay stable across top-ups of
      // the same lot.
      await repo.save(inventory);
    } else {
      inventory = repo.create({
        tenantId,
        storageLocationId: locationId,
        itemType,
        itemId,
        quantity,
        unit,
        lotNumber,
        expiryDate,
        // Stamp `receivedDate` on the initial insert so the FEFO ORDER BY
        // (expiryDate, receivedDate, lotNumber) has a real timestamp to
        // compare against.
        receivedDate: receivedDate ?? operationInstant,
        createdBy: userId,
        updatedBy: userId,
      });
      await repo.save(inventory);
    }
  }

  /**
   * Sum all inventory for the item across locations and write the total +
   * stock status back onto the source entity. This is what keeps
   * `Feed.quantity` — the field the feed-consumption forecast reads —
   * authoritative after every movement.
   */
  private async updateItemTotalQuantity(
    manager: EntityManager,
    itemType: StorageItemType,
    itemId: string,
    tenantId: string,
  ): Promise<void> {
    const result = await tenantManagerRepo(manager, StorageInventory, tenantId)
      .createQueryBuilder('inv')
      .select('COALESCE(SUM(inv.quantity), 0)', 'total')
      .andWhere('inv.itemType = :itemType', { itemType })
      .andWhere('inv.itemId = :itemId', { itemId })
      .getRawOne();

    const totalQuantity = parseFloat(result?.total ?? '0');

    switch (itemType) {
      case StorageItemType.FEED: {
        const feedRepo = tenantManagerRepo(manager, Feed, tenantId);
        const feed = await feedRepo.findOne({ where: { id: itemId, tenantId } });
        if (feed) {
          feed.quantity = totalQuantity;
          if (totalQuantity <= 0) feed.status = FeedStatus.OUT_OF_STOCK;
          else if (totalQuantity <= Number(feed.minStock)) feed.status = FeedStatus.LOW_STOCK;
          else feed.status = FeedStatus.AVAILABLE;
          await feedRepo.save(feed);
        }
        break;
      }
      case StorageItemType.CHEMICAL: {
        const chemRepo = tenantManagerRepo(manager, Chemical, tenantId);
        const chem = await chemRepo.findOne({ where: { id: itemId, tenantId } });
        if (chem) {
          chem.quantity = totalQuantity;
          chem.updateStockStatus();
          await chemRepo.save(chem);
        }
        break;
      }
      case StorageItemType.CONSUMABLE:
      case StorageItemType.HEALTHCARE: {
        const consRepo = tenantManagerRepo(manager, Consumable, tenantId);
        const cons = await consRepo.findOne({ where: { id: itemId, tenantId } });
        if (cons) {
          cons.quantity = totalQuantity;
          cons.updateStockStatus();
          await consRepo.save(cons);
        }
        break;
      }
    }
  }
}
