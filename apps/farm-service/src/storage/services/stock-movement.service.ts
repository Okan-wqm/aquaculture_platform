/**
 * StockMovementService
 *
 * # Canonical stock mutation authority
 *
 * Every physical stock change enters through this caller-transaction-aware
 * service. It owns exact lot-key mutation, FEFO allocation, item roll-ups,
 * immutable movement facts and transactional outbox projections. Command
 * handlers and feeding flows are transaction/bounded-context adapters only;
 * they do not reproduce projection or audit writes.
 *
 * Feeding deductions additionally compile a complete locked pool into
 * immutable slices. Tracking classification is anchored in movement history,
 * with projection presence admitted only as a legacy bootstrap signal, so a
 * depleted feed can never become silently "untracked" again.
 *
 * @module Storage/Services
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, In, IsNull, Like } from 'typeorm';
import {
  tenantManagerRepo,
  type TenantMutationSession,
  TenantScopedRepository,
} from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import type { LowStockDetectedEvent, StockMovementRecordedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';

import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed, FeedStatus } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { ConditionWarning } from '../dto/stock-movement.response';
import { LotMixService } from './lot-mix.service';
import {
  StockMutationLockAuthority,
  type StockMutationScopeV1,
} from './stock-mutation-lock.authority';
import {
  SiteAuthorizationService,
  type SiteScopeCaller,
} from '@aquaculture/backend-common/security';

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
  /** Immutable arrival provenance when restoring or transferring a drawn lot. */
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
  /**
   * Exact locked projection row selected by the composite allocation authority.
   * GraphQL inputs never expose this field; it binds a compiled FEFO slice to
   * the row that was locked while the whole pool was qualified.
   */
  sourceInventoryId?: string;
  /** Stable feeding allocation ledger identity; never derived from retry keys. */
  allocationFamilyKey?: string;
  /** Exact immutable OUT slice restored by a logical RETURN correction. */
  sourceMovementId?: string;
}

export interface FeedDeductionInput {
  feedId: string;
  quantityKg: number;
  asOf: Date;
  lotNumber?: string;
  siteId?: string;
  reference: string;
  reason: string;
  idempotencyKey: string;
  allocationFamilyKey: string;
}

export interface FeedCorrectionInput {
  feedId: string;
  deltaKg: number;
  asOf: Date;
  siteId?: string;
  sourceDeductionKey: string;
  idempotencyKey: string;
  reference: string;
}

export interface FeedAllocationCandidate {
  inventoryId: string;
  storageLocationId: string;
  siteId: string;
  lotNumber: string | null;
  quantityKg: number;
  expiryDate: Date | null;
  receivedDate: Date | null;
}

export interface FeedAllocationSlice {
  inventoryId: string;
  storageLocationId: string;
  lotNumber: string | null;
  quantityKg: number;
}

export interface FeedDeductionResult {
  tracked: boolean;
  movements: readonly StockMovement[];
  usedSiteFallback: boolean;
  poolTotalKg: number;
  idempotentHit: boolean;
}

interface DrawnInventoryIdentity {
  lotNumber: string | null;
  expiryDate: Date | null;
  receivedDate: Date | null;
}

interface OutstandingFeedAllocationSlice {
  readonly movement: StockMovement;
  readonly availableUnits: number;
}

const STOCK_QUANTITY_SCALE = 100;

function stockQuantityUnits(quantity: number, label: string): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new BadRequestException(`${label} must be positive`);
  }
  const units = Math.round(quantity * STOCK_QUANTITY_SCALE);
  if (!Number.isSafeInteger(units) || Math.abs(units / STOCK_QUANTITY_SCALE - quantity) > 1e-9) {
    throw new BadRequestException(`${label} supports at most two decimal places`);
  }
  return units;
}

function nullableText(value: string | null | undefined): string | null {
  return value ?? null;
}

function nullableDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'invalid-date';
  return parsed.toISOString();
}

/** Idempotency is a payload binding, not merely a duplicate-key shortcut. */
function assertIdempotentMovementReplay(existing: StockMovement, input: RecordMovementInput): void {
  const mismatches: string[] = [];
  if (existing.movementType !== input.movementType) mismatches.push('movementType');
  if (existing.itemType !== input.itemType) mismatches.push('itemType');
  if (existing.itemId !== input.itemId) mismatches.push('itemId');
  if (
    stockQuantityUnits(Number(existing.quantity), 'Existing movement quantity') !==
    stockQuantityUnits(input.quantity, 'Stock movement quantity')
  ) {
    mismatches.push('quantity');
  }
  if (nullableText(existing.fromLocationId) !== nullableText(input.fromLocationId)) {
    mismatches.push('fromLocationId');
  }
  if (nullableText(existing.toLocationId) !== nullableText(input.toLocationId)) {
    mismatches.push('toLocationId');
  }
  if (nullableText(existing.lotNumber) !== nullableText(input.lotNumber)) {
    mismatches.push('lotNumber');
  }
  if (nullableDate(existing.expiryDate) !== nullableDate(input.expiryDate)) {
    mismatches.push('expiryDate');
  }
  if (nullableDate(existing.receivedDate) !== nullableDate(input.receivedDate)) {
    mismatches.push('receivedDate');
  }
  if (nullableText(existing.allocationFamilyKey) !== nullableText(input.allocationFamilyKey)) {
    mismatches.push('allocationFamilyKey');
  }
  if (nullableText(existing.sourceMovementId) !== nullableText(input.sourceMovementId)) {
    mismatches.push('sourceMovementId');
  }
  if (nullableText(existing.reference) !== nullableText(input.reference)) {
    mismatches.push('reference');
  }
  if (nullableText(existing.reason) !== nullableText(input.reason)) {
    mismatches.push('reason');
  }
  if (
    input.movementDate !== undefined &&
    nullableDate(existing.performedAt) !== nullableDate(input.movementDate)
  ) {
    mismatches.push('movementDate');
  }
  if (mismatches.length > 0) {
    throw new ConflictException(
      `Stock movement idempotency key is already bound to a different payload (${mismatches.join(
        ', ',
      )})`,
    );
  }
}

/**
 * Pure, deterministic FEFO allocation compiler. Callers must pass candidates
 * in canonical `(expiry, received, lot, location, id)` order. Site preference
 * is a stable partition over that order, so every transaction locks rows in
 * one global order while still consuming local stock first.
 */
export function compileFeedAllocation(
  candidates: readonly FeedAllocationCandidate[],
  requestedKg: number,
  preferredSiteId?: string,
): { slices: FeedAllocationSlice[]; usedSiteFallback: boolean; poolTotalKg: number } {
  const requestedUnits = stockQuantityUnits(requestedKg, 'Feed deduction quantity');
  const candidateUnits = candidates.map((candidate) => ({
    candidate,
    units: stockQuantityUnits(candidate.quantityKg, 'Inventory quantity'),
  }));
  const poolUnits = candidateUnits.reduce((total, entry) => total + entry.units, 0);
  if (!Number.isSafeInteger(poolUnits) || poolUnits < requestedUnits) {
    throw new BadRequestException(
      `Insufficient feed stock. Available: ${(poolUnits / STOCK_QUANTITY_SCALE).toFixed(2)} kg, ` +
        `Requested: ${requestedKg.toFixed(2)} kg`,
    );
  }

  const ordered = preferredSiteId
    ? [
        ...candidateUnits.filter((entry) => entry.candidate.siteId === preferredSiteId),
        ...candidateUnits.filter((entry) => entry.candidate.siteId !== preferredSiteId),
      ]
    : candidateUnits;
  const slices: FeedAllocationSlice[] = [];
  let remainingUnits = requestedUnits;
  let usedSiteFallback = false;

  for (const { candidate, units } of ordered) {
    if (remainingUnits === 0) break;
    const allocatedUnits = Math.min(remainingUnits, units);
    if (allocatedUnits === 0) continue;
    slices.push({
      inventoryId: candidate.inventoryId,
      storageLocationId: candidate.storageLocationId,
      lotNumber: candidate.lotNumber,
      quantityKg: allocatedUnits / STOCK_QUANTITY_SCALE,
    });
    if (preferredSiteId && candidate.siteId !== preferredSiteId) {
      usedSiteFallback = true;
    }
    remainingUnits -= allocatedUnits;
  }

  if (remainingUnits !== 0) {
    throw new BadRequestException('Feed allocation did not converge to the requested quantity');
  }

  return {
    slices,
    usedSiteFallback,
    poolTotalKg: poolUnits / STOCK_QUANTITY_SCALE,
  };
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
    // manual movement, feeding deduction, waste, adjustment — emits it
    // on the same transactional manager; no caller can forget it.
    private readonly outboxPublisher: OutboxPublisher,
    private readonly stockMutationLocks: StockMutationLockAuthority,
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
   * StockMovementRecorded and any LowStockDetected projection are enqueued
   * here on the same manager. Callers may perform post-commit local signals,
   * but cannot reproduce durable stock events.
   */
  async recordMovement(
    session: TenantMutationSession,
    input: RecordMovementInput,
    ctx: MovementContext,
  ): Promise<RecordMovementResult> {
    const scope = await this.stockMutationLocks.acquire(session, ctx.tenantId, {
      itemType: input.itemType,
      itemId: input.itemId,
    });
    return this.recordMovementInternal(scope, input, ctx, true);
  }

  private async recordMovementInternal(
    scope: StockMutationScopeV1,
    input: RecordMovementInput,
    ctx: MovementContext,
    emitLowStock: boolean,
  ): Promise<RecordMovementResult> {
    const manager = scope.manager;
    const { tenantId, userId, userName } = ctx;
    const { movementType, itemType, itemId, quantity } = input;

    stockQuantityUnits(quantity, 'Stock movement quantity');
    if (input.idempotencyKey && input.idempotencyKey.length > 64) {
      throw new BadRequestException('Stock movement idempotency key cannot exceed 64 characters');
    }
    if (input.allocationFamilyKey && input.allocationFamilyKey.length > 64) {
      throw new BadRequestException('Stock allocation family key cannot exceed 64 characters');
    }
    if (input.sourceMovementId && !input.allocationFamilyKey) {
      throw new BadRequestException('Exact stock restoration requires an allocation family key');
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
        assertIdempotentMovementReplay(existing, input);
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

    if (input.sourceMovementId) {
      if (movementType !== MovementType.RETURN || !input.toLocationId) {
        throw new BadRequestException('A source movement can only authorize an inbound RETURN');
      }
      const sourceMovement = await movementRepo.findOne({
        where: {
          id: input.sourceMovementId,
          tenantId,
          movementType: MovementType.OUT,
          itemType,
          itemId,
          allocationFamilyKey: input.allocationFamilyKey,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sourceMovement) {
        throw new BadRequestException(
          `Immutable allocation source ${input.sourceMovementId} was not found`,
        );
      }
      if (
        sourceMovement.fromLocationId !== input.toLocationId ||
        nullableText(sourceMovement.lotNumber) !== nullableText(input.lotNumber) ||
        nullableDate(sourceMovement.expiryDate) !== nullableDate(input.expiryDate) ||
        nullableDate(sourceMovement.receivedDate) !== nullableDate(input.receivedDate)
      ) {
        throw new BadRequestException(
          `Exact stock restoration diverges from source movement ${sourceMovement.id}`,
        );
      }
      const priorReturns = await movementRepo.find({
        where: {
          tenantId,
          movementType: MovementType.RETURN,
          itemType,
          itemId,
          allocationFamilyKey: input.allocationFamilyKey,
          sourceMovementId: sourceMovement.id,
        },
      });
      const restoredUnits = priorReturns.reduce(
        (total, movement) =>
          total + stockQuantityUnits(Number(movement.quantity), 'Recorded return quantity'),
        0,
      );
      const sourceUnits = stockQuantityUnits(
        Number(sourceMovement.quantity),
        'Recorded source movement quantity',
      );
      const requestedUnits = stockQuantityUnits(quantity, 'Stock restoration quantity');
      if (restoredUnits + requestedUnits > sourceUnits) {
        throw new BadRequestException(
          `Stock restoration exceeds immutable source movement ${sourceMovement.id}`,
        );
      }
    }

    const itemDetails = await this.getItemDetails(manager, itemType, itemId, tenantId);
    if (!itemDetails) {
      throw new NotFoundException(`${itemType} with ID "${itemId}" not found`);
    }

    const { fromLocation, toLocation } = await this.resolveLocations(manager, input, tenantId);

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
    const explicitMovementInstant =
      input.movementDate instanceof Date
        ? input.movementDate
        : input.movementDate
          ? new Date(input.movementDate)
          : undefined;
    const movementInstant = explicitMovementInstant ?? (await scope.readMutationInstant());
    const asOfDate = movementInstant;

    const drawn = fromLocation
      ? await this.decreaseInventory(
          inventoryRepo,
          tenantId,
          fromLocation.id,
          itemType,
          itemId,
          quantity,
          itemDetails.unit,
          input.lotNumber,
          userId,
          asOfDate,
          input.sourceInventoryId,
          movementType === MovementType.TRANSFER || movementType === MovementType.ADJUSTMENT,
        )
      : null;

    // Lot-mix detection — must run BEFORE increaseInventory so the service
    // sees the resident lots as "other" and not yet summed with the
    // incoming quantity.
    let effectiveLotNumber: string | null = null;
    if (toLocation && input.lotNumber && !input.sourceMovementId) {
      const mixOutcome = await this.lotMixService.detect({
        tenantId,
        storageLocationId: toLocation.id,
        itemType,
        itemId,
        incomingLotNumber: input.lotNumber,
        incomingQuantityKg: quantity,
        manufacturer: itemDetails.manufacturer ?? null,
        incomingExpiryDate: input.expiryDate ?? null,
        userId,
        manager,
        mixedAt: movementInstant,
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
        effectiveLotNumber ?? input.lotNumber ?? drawn?.lotNumber ?? undefined,
        input.expiryDate ?? drawn?.expiryDate ?? undefined,
        input.receivedDate ?? drawn?.receivedDate ?? undefined,
        movementInstant,
        userId,
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
      lotNumber: effectiveLotNumber ?? input.lotNumber ?? drawn?.lotNumber ?? undefined,
      expiryDate: input.expiryDate ?? drawn?.expiryDate ?? undefined,
      receivedDate: input.receivedDate ?? drawn?.receivedDate ?? undefined,
      allocationFamilyKey: input.allocationFamilyKey,
      sourceMovementId: input.sourceMovementId,
      idempotencyKey: input.idempotencyKey,
      performedBy: userId,
      performedByName: userName,
      performedAt: movementInstant,
    });
    const saved = await movementRepo.save(movement);
    await this.enqueueMovementRecorded(manager, saved, tenantId, userId);

    // Post-update aggregate quantity across all locations for the item —
    // read inside the tx so it reflects the just-applied mutation. Used for
    // low-stock detection on stock-reducing movements only.
    let currentTotal = 0;
    let lowStock: RecordMovementResult['lowStock'] = null;
    const reducesAggregate =
      fromLocation !== null &&
      toLocation === null &&
      (movementType === MovementType.OUT ||
        movementType === MovementType.WASTE ||
        movementType === MovementType.ADJUSTMENT);
    if (reducesAggregate) {
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
   * Qualify, allocate and persist one feeding deduction as a single authority
   * operation. The former public "presence" and "resolve one lot" calls made
   * the decision mutable and split allocation from mutation. This operation
   * holds the idempotency fence, locks the complete candidate pool in one
   * canonical order, proves aggregate sufficiency, then records one immutable
   * movement per FEFO slice on the same transaction manager.
   */
  async recordFeedDeduction(
    session: TenantMutationSession,
    input: FeedDeductionInput,
    ctx: MovementContext,
  ): Promise<FeedDeductionResult> {
    stockQuantityUnits(input.quantityKg, 'Feed deduction quantity');
    if (input.idempotencyKey.length > 64) {
      throw new BadRequestException('Stock movement idempotency key cannot exceed 64 characters');
    }
    if (input.allocationFamilyKey.length > 64) {
      throw new BadRequestException('Stock allocation family key cannot exceed 64 characters');
    }
    const scope = await this.stockMutationLocks.acquire(session, ctx.tenantId, {
      itemType: StorageItemType.FEED,
      itemId: input.feedId,
    });
    const manager = scope.manager;

    const existing = await this.findMovementFamily(
      manager,
      ctx.tenantId,
      input.feedId,
      input.idempotencyKey,
    );
    if (existing.length > 0) {
      const replayUnits = existing.reduce(
        (total, movement) =>
          total + stockQuantityUnits(Number(movement.quantity), 'Recorded movement quantity'),
        0,
      );
      if (
        replayUnits !== stockQuantityUnits(input.quantityKg, 'Feed deduction quantity') ||
        existing.some(
          (movement) =>
            movement.movementType !== MovementType.OUT ||
            movement.allocationFamilyKey !== input.allocationFamilyKey,
        )
      ) {
        throw new ConflictException('Feed deduction replay diverges from its immutable allocation');
      }
      return {
        tracked: true,
        movements: existing,
        usedSiteFallback: false,
        poolTotalKg: existing.reduce((total, movement) => total + Number(movement.quantity), 0),
        idempotentHit: true,
      };
    }

    const tracked = await this.isFeedStorageTracked(manager, ctx.tenantId, input.feedId);
    if (!tracked) {
      return {
        tracked: false,
        movements: [],
        usedSiteFallback: false,
        poolTotalKg: 0,
        idempotentHit: false,
      };
    }

    const candidates = await this.loadFeedAllocationCandidates(
      manager,
      ctx.tenantId,
      input.feedId,
      input.asOf,
      input.lotNumber,
    );
    const allocation = compileFeedAllocation(candidates, input.quantityKg, input.siteId);
    const movements: StockMovement[] = [];

    for (const [index, slice] of allocation.slices.entries()) {
      const sliceIdempotencyKey =
        index === 0 ? input.idempotencyKey : `${input.idempotencyKey}:${index}`;
      if (sliceIdempotencyKey.length > 64) {
        throw new BadRequestException(
          'Composite stock movement idempotency key cannot exceed 64 characters',
        );
      }
      const result = await this.recordMovementInternal(
        scope,
        {
          movementType: MovementType.OUT,
          itemType: StorageItemType.FEED,
          itemId: input.feedId,
          quantity: slice.quantityKg,
          fromLocationId: slice.storageLocationId,
          lotNumber: slice.lotNumber ?? undefined,
          reference: input.reference,
          reason: input.reason,
          idempotencyKey: sliceIdempotencyKey,
          movementDate: input.asOf,
          sourceInventoryId: slice.inventoryId,
          allocationFamilyKey: input.allocationFamilyKey,
        },
        ctx,
        index === allocation.slices.length - 1,
      );
      movements.push(result.saved);
    }

    if (allocation.usedSiteFallback) {
      this.logger.warn(
        `Feed deduction used tenant-wide fallback for feed ${input.feedId} ` +
          `(preferred site ${input.siteId}, ${input.quantityKg} kg)`,
      );
    }

    return {
      tracked: true,
      movements,
      usedSiteFallback: allocation.usedSiteFallback,
      poolTotalKg: allocation.poolTotalKg,
      idempotentHit: false,
    };
  }

  async recordFeedCorrection(
    session: TenantMutationSession,
    input: FeedCorrectionInput,
    ctx: MovementContext,
  ): Promise<FeedDeductionResult> {
    if (input.deltaKg === 0) {
      return {
        tracked: true,
        movements: [],
        usedSiteFallback: false,
        poolTotalKg: 0,
        idempotentHit: false,
      };
    }
    stockQuantityUnits(Math.abs(input.deltaKg), 'Feed correction quantity');
    if (input.deltaKg > 0) {
      return this.recordFeedDeduction(
        session,
        {
          feedId: input.feedId,
          quantityKg: input.deltaKg,
          asOf: input.asOf,
          siteId: input.siteId,
          reference: input.reference,
          reason: 'Feeding upward correction (in-transaction).',
          idempotencyKey: input.idempotencyKey,
          allocationFamilyKey: input.sourceDeductionKey,
        },
        ctx,
      );
    }
    const scope = await this.stockMutationLocks.acquire(session, ctx.tenantId, {
      itemType: StorageItemType.FEED,
      itemId: input.feedId,
    });
    const manager = scope.manager;
    const replay = await this.findMovementFamily(
      manager,
      ctx.tenantId,
      input.feedId,
      input.idempotencyKey,
    );
    if (replay.length > 0) {
      const expectedType = input.deltaKg > 0 ? MovementType.OUT : MovementType.RETURN;
      const replayUnits = replay.reduce(
        (total, movement) =>
          total + stockQuantityUnits(Number(movement.quantity), 'Recorded correction quantity'),
        0,
      );
      if (
        replayUnits !== stockQuantityUnits(Math.abs(input.deltaKg), 'Feed correction quantity') ||
        replay.some(
          (movement) =>
            movement.movementType !== expectedType ||
            movement.allocationFamilyKey !== input.sourceDeductionKey,
        )
      ) {
        throw new ConflictException(
          'Feed correction replay diverges from its immutable allocation',
        );
      }
      return {
        tracked: true,
        movements: replay,
        usedSiteFallback: false,
        poolTotalKg: replay.reduce((total, movement) => total + Number(movement.quantity), 0),
        idempotentHit: true,
      };
    }

    const outstanding = await this.loadOutstandingFeedAllocation(
      manager,
      ctx.tenantId,
      input.feedId,
      input.sourceDeductionKey,
    );
    if (outstanding.length === 0) {
      if (await this.isFeedStorageTracked(manager, ctx.tenantId, input.feedId)) {
        throw new BadRequestException(
          `Immutable feed allocation "${input.sourceDeductionKey}" has no outstanding slices`,
        );
      }
      return {
        tracked: false,
        movements: [],
        usedSiteFallback: false,
        poolTotalKg: 0,
        idempotentHit: false,
      };
    }

    let remainingUnits = stockQuantityUnits(Math.abs(input.deltaKg), 'Feed correction quantity');
    const availableUnits = outstanding.reduce((total, slice) => total + slice.availableUnits, 0);
    if (remainingUnits > availableUnits) {
      throw new BadRequestException(
        `Feed correction exceeds the ${(availableUnits / STOCK_QUANTITY_SCALE).toFixed(
          2,
        )} kg immutable deduction`,
      );
    }

    const movements: StockMovement[] = [];
    for (const slice of [...outstanding].reverse()) {
      if (remainingUnits === 0) break;
      const movement = slice.movement;
      if (!movement.fromLocationId) {
        throw new BadRequestException(`Deduction movement ${movement.id} has no source location`);
      }
      const returnedUnits = Math.min(remainingUnits, slice.availableUnits);
      const index = movements.length;
      const idempotencyKey =
        index === 0 ? input.idempotencyKey : `${input.idempotencyKey}:${index}`;
      if (idempotencyKey.length > 64) {
        throw new BadRequestException(
          'Composite stock movement idempotency key cannot exceed 64 characters',
        );
      }
      const result = await this.recordMovementInternal(
        scope,
        {
          movementType: MovementType.RETURN,
          itemType: StorageItemType.FEED,
          itemId: input.feedId,
          quantity: returnedUnits / STOCK_QUANTITY_SCALE,
          toLocationId: movement.fromLocationId,
          lotNumber: movement.lotNumber,
          expiryDate: movement.expiryDate,
          receivedDate: movement.receivedDate,
          allocationFamilyKey: input.sourceDeductionKey,
          sourceMovementId: movement.id,
          reference: input.reference,
          reason: 'Feeding downward correction returned to immutable deduction slices.',
          idempotencyKey,
          movementDate: input.asOf,
        },
        ctx,
        false,
      );
      movements.push(result.saved);
      remainingUnits -= returnedUnits;
    }

    if (remainingUnits !== 0) {
      throw new BadRequestException('Feed correction did not converge to the requested quantity');
    }
    return {
      tracked: true,
      movements,
      usedSiteFallback: false,
      poolTotalKg: availableUnits / STOCK_QUANTITY_SCALE,
      idempotentHit: false,
    };
  }

  private async findMovementFamily(
    manager: EntityManager,
    tenantId: string,
    feedId: string,
    idempotencyKey: string,
  ): Promise<StockMovement[]> {
    return tenantManagerRepo(manager, StockMovement, tenantId).find({
      where: [
        {
          tenantId,
          itemType: StorageItemType.FEED,
          itemId: feedId,
          idempotencyKey,
        },
        {
          tenantId,
          itemType: StorageItemType.FEED,
          itemId: feedId,
          idempotencyKey: Like(`${idempotencyKey}:%`),
        },
      ],
      order: { idempotencyKey: 'ASC' },
    });
  }

  /**
   * Rebuild the still-open allocation vector from immutable OUT/RETURN facts.
   * No mutable inventory row participates, so exhausted lots remain restorable
   * and repeated corrections cannot return more than the family consumed.
   */
  private async loadOutstandingFeedAllocation(
    manager: EntityManager,
    tenantId: string,
    feedId: string,
    allocationFamilyKey: string,
  ): Promise<OutstandingFeedAllocationSlice[]> {
    const movements = await tenantManagerRepo(manager, StockMovement, tenantId).find({
      where: {
        tenantId,
        itemType: StorageItemType.FEED,
        itemId: feedId,
        allocationFamilyKey,
      },
      order: { performedAt: 'ASC', idempotencyKey: 'ASC' },
    });
    const deductions = movements.filter((movement) => movement.movementType === MovementType.OUT);
    const returnedBySource = new Map<string, number>();
    for (const movement of movements) {
      if (movement.movementType === MovementType.OUT) continue;
      if (movement.movementType !== MovementType.RETURN || !movement.sourceMovementId) {
        throw new BadRequestException(
          `Allocation family ${allocationFamilyKey} contains an unlinked movement`,
        );
      }
      returnedBySource.set(
        movement.sourceMovementId,
        (returnedBySource.get(movement.sourceMovementId) ?? 0) +
          stockQuantityUnits(Number(movement.quantity), 'Recorded return quantity'),
      );
    }

    const outstanding: OutstandingFeedAllocationSlice[] = [];
    for (const movement of deductions) {
      const deductedUnits = stockQuantityUnits(
        Number(movement.quantity),
        'Recorded deduction quantity',
      );
      const returnedUnits = returnedBySource.get(movement.id) ?? 0;
      if (returnedUnits > deductedUnits) {
        throw new BadRequestException(
          `Allocation source ${movement.id} was restored beyond its immutable quantity`,
        );
      }
      if (returnedUnits < deductedUnits) {
        outstanding.push({ movement, availableUnits: deductedUnits - returnedUnits });
      }
      returnedBySource.delete(movement.id);
    }
    if (returnedBySource.size > 0) {
      throw new BadRequestException(
        `Allocation family ${allocationFamilyKey} references a foreign source movement`,
      );
    }
    return outstanding;
  }

  private async isFeedStorageTracked(
    manager: EntityManager,
    tenantId: string,
    feedId: string,
  ): Promise<boolean> {
    const immutableMovementCount = await tenantManagerRepo(manager, StockMovement, tenantId).count({
      where: { itemType: StorageItemType.FEED, itemId: feedId },
    });
    if (immutableMovementCount > 0) return true;

    // Legacy/bootstrap rows may pre-date movement capture. Projection presence
    // is admitted only until the first deduction writes the immutable marker;
    // depletion can never switch a feed back to "untracked" afterwards.
    const bootstrapProjectionCount = await tenantManagerRepo(
      manager,
      StorageInventory,
      tenantId,
    ).count({
      where: { itemType: StorageItemType.FEED, itemId: feedId },
    });
    return bootstrapProjectionCount > 0;
  }

  private async loadFeedAllocationCandidates(
    manager: EntityManager,
    tenantId: string,
    feedId: string,
    asOf: Date,
    lotNumber?: string,
  ): Promise<FeedAllocationCandidate[]> {
    const query = tenantManagerRepo(manager, StorageInventory, tenantId)
      .createQueryBuilder('inventory')
      .andWhere('inventory.itemType = :itemType', { itemType: StorageItemType.FEED })
      .andWhere('inventory.itemId = :itemId', { itemId: feedId })
      .andWhere('inventory.quantity > :zero', { zero: 0 })
      .andWhere('(inventory.expiryDate IS NULL OR inventory.expiryDate > :asOf)', { asOf })
      .andWhere('(inventory.receivedDate IS NULL OR inventory.receivedDate <= :asOf)', { asOf });
    if (lotNumber !== undefined) {
      query.andWhere('inventory.lotNumber = :lotNumber', { lotNumber });
    }

    const inventory = await query
      .orderBy('inventory.expiryDate', 'ASC', 'NULLS LAST')
      .addOrderBy('inventory.receivedDate', 'ASC', 'NULLS LAST')
      .addOrderBy('inventory.lotNumber', 'ASC', 'NULLS LAST')
      .addOrderBy('inventory.storageLocationId', 'ASC')
      .addOrderBy('inventory.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    if (inventory.length === 0) return [];

    const locationIds = [...new Set(inventory.map((row) => row.storageLocationId))];
    const locations = await tenantManagerRepo(manager, StorageLocation, tenantId).find({
      where: { tenantId, id: In(locationIds), isDeleted: false },
    });
    const locationsById = new Map(locations.map((location) => [location.id, location]));

    return inventory.map((row) => {
      const location = locationsById.get(row.storageLocationId);
      if (!location) {
        throw new BadRequestException(
          `Inventory ${row.id} references an unavailable storage location`,
        );
      }
      return {
        inventoryId: row.id,
        storageLocationId: row.storageLocationId,
        siteId: location.siteId,
        lotNumber: row.lotNumber ?? null,
        quantityKg: Number(row.quantity),
        expiryDate: row.expiryDate ?? null,
        receivedDate: row.receivedDate ?? null,
      };
    });
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
          'Both fromLocationId and toLocationId are required for transfer movements',
        );
      }
      if (input.fromLocationId === input.toLocationId) {
        throw new BadRequestException('A transfer must use two different storage locations');
      }
      fromLocation = await locationRepo.findOne({
        where: { id: input.fromLocationId, tenantId },
      });
      if (!fromLocation) {
        throw new NotFoundException(`Storage location "${input.fromLocationId}" not found`);
      }
      toLocation = await locationRepo.findOne({
        where: { id: input.toLocationId, tenantId },
      });
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
    asOfDate?: Date,
    sourceInventoryId?: string,
    exactLotKey = false,
  ): Promise<DrawnInventoryIdentity> {
    let inventory: StorageInventory | null;

    if (sourceInventoryId) {
      inventory = await repo.findOne({
        where: {
          id: sourceInventoryId,
          tenantId,
          storageLocationId: locationId,
          itemType,
          itemId,
          lotNumber: lotNumber ?? IsNull(),
        },
        lock: { mode: 'pessimistic_write' },
      });
    } else if (lotNumber !== undefined || exactLotKey) {
      inventory = await repo.findOne({
        where: {
          tenantId,
          storageLocationId: locationId,
          itemType,
          itemId,
          lotNumber: lotNumber ?? IsNull(),
        },
        lock: { mode: 'pessimistic_write' },
      });
    } else {
      inventory = await repo
        .createQueryBuilder('inv')
        .andWhere('inv.storageLocationId = :locationId', { locationId })
        .andWhere('inv.itemType = :itemType', { itemType })
        .andWhere('inv.itemId = :itemId', { itemId })
        .andWhere('inv.quantity > 0')
        .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :asOf)', {
          asOf: asOfDate,
        })
        .andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', {
          asOf: asOfDate,
        })
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

    const drawn: DrawnInventoryIdentity = {
      lotNumber: inventory.lotNumber ?? null,
      expiryDate: inventory.expiryDate ?? null,
      receivedDate: inventory.receivedDate ?? null,
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
    movementInstant: Date,
    userId: string,
  ): Promise<void> {
    let inventory = await repo.findOne({
      where: {
        tenantId,
        storageLocationId: locationId,
        itemType,
        itemId,
        lotNumber: lotNumber ?? IsNull(),
      },
      lock: { mode: 'pessimistic_write' },
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
        // A restored/transferred lot keeps the exact arrival provenance from
        // the immutable movement family. A genuine receipt uses the one
        // operation instant already selected above; it does not consult a
        // second process clock while persisting the same aggregate mutation.
        receivedDate: receivedDate ?? movementInstant,
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
    const sumInventory = async (): Promise<number> => {
      const result = await tenantManagerRepo(manager, StorageInventory, tenantId)
        .createQueryBuilder('inventory')
        .select('COALESCE(SUM(inventory.quantity), 0)', 'total')
        .andWhere('inventory.itemType = :itemType', { itemType })
        .andWhere('inventory.itemId = :itemId', { itemId })
        .getRawOne();
      return parseFloat(result?.total ?? '0');
    };

    switch (itemType) {
      case StorageItemType.FEED: {
        const feedRepo = tenantManagerRepo(manager, Feed, tenantId);
        const feed = await feedRepo.findOne({
          where: { id: itemId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (feed) {
          const totalQuantity = await sumInventory();
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
        const chem = await chemRepo.findOne({
          where: { id: itemId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (chem) {
          const totalQuantity = await sumInventory();
          chem.quantity = totalQuantity;
          chem.updateStockStatus();
          await chemRepo.save(chem);
        }
        break;
      }
      case StorageItemType.CONSUMABLE:
      case StorageItemType.HEALTHCARE: {
        const consRepo = tenantManagerRepo(manager, Consumable, tenantId);
        const cons = await consRepo.findOne({
          where: { id: itemId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (cons) {
          const totalQuantity = await sumInventory();
          cons.quantity = totalQuantity;
          cons.updateStockStatus();
          await consRepo.save(cons);
        }
        break;
      }
    }
  }

  private async enqueueMovementRecorded(
    manager: EntityManager,
    saved: StockMovement,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const event: StockMovementRecordedEvent = {
      ...createBaseEvent<StockMovementRecordedEvent>('StockMovementRecorded', tenantId),
      userId,
      movementId: saved.id,
      movementType: saved.movementType,
      itemType: saved.itemType,
      itemId: saved.itemId,
      itemName: saved.itemName,
      quantity: Number(saved.quantity),
      unit: saved.unit,
      fromLocationId: saved.fromLocationId,
      toLocationId: saved.toLocationId,
      lotNumber: saved.lotNumber,
    };
    await this.outboxPublisher.enqueue(event, manager, {
      idempotencyKey: `stock-movement-recorded:${saved.id}`,
      aggregateId: saved.itemId,
    });
  }
}
