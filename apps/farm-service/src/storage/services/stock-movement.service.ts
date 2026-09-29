/**
 * StockMovementService
 *
 * # Why this service exists (feed dual-SSoT write-path correctness — Phase A)
 *
 * Feed stock lives in TWO ledgers: the feeding module's
 * `feed_inventory.quantityKg` (read by the GetFeedInventory query) and the
 * storage module's `storage_inventory.quantity` (+ the `Feed.quantity`
 * roll-up read by the consumption forecast). A feeding USED TO decrement
 * `feed_inventory` synchronously inside its own transaction, then fire a
 * SEPARATE async event handler (`FeedingStorageEventHandler`) that
 * decremented `storage_inventory` — and that handler SWALLOWED its
 * insufficient-stock / error (catch + warn). So a feeding could succeed
 * while its storage deduction silently failed, and the two ledgers diverged
 * with no operator signal.
 *
 * Phase A removes the silent swallow by making the storage OUT deduction
 * happen INSIDE the feeding transaction, fail-closed. For that to be
 * possible the inventory-mutation core (FEFO decrement, lot-mix detection,
 * increment, item-total roll-up, idempotency, and the immutable
 * `stock_movement` audit row) had to become callable from a
 * CALLER-PROVIDED transaction so a feeding write and its feed deduction
 * commit or roll back ATOMICALLY. This service holds exactly that core.
 *
 * `RecordStockMovementHandler` is now a thin wrapper: it opens its own
 * transaction, calls `recordMovement(manager, ...)`, then emits the
 * post-commit domain events. Feeding callers (`CreateFeedingRecordHandler`,
 * `DailyFeedingExecutionService`) call `recordMovement(queryRunner.manager,
 * ...)` INSIDE their own feeding transaction — so an insufficient-stock
 * `BadRequestException` ROLLS BACK the feeding instead of being swallowed.
 *
 * Phase A was write-path only. Phase 2 (stock SSoT) completed the read
 * re-point: the legacy `feed_inventory` writers and the GetFeedInventory
 * read path are GONE — this ledger (+ the Feed.quantity roll-up) is the
 * single feed stock truth. The frozen `feed_inventory` table is dropped in
 * the retirement phase.
 *
 * @module Storage/Services
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { tenantManagerRepo, TenantScopedRepository } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';

import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { ConditionWarning } from '../dto/stock-movement.response';
import { describeStorageItem } from './storage-item-catalog';
import { CatalogStockProjector } from './catalog-stock-projector.service';
import { LowStockEvaluator } from './low-stock/low-stock-evaluator.service';
import { buildLowStockDetectedEvent } from './low-stock/low-stock-event.factory';
import type { LowStockCrossing } from './low-stock/low-stock.types';
import { LotMixService } from './lot-mix.service';
import { FeedAllocationService } from './feed-allocation.service';
import type { FeedAllocationResult } from './feed-allocation.service';
import { StockMutationLockAuthority } from './stock-mutation-lock.authority';
import { stockQuantityUnits } from './stock-quantity';
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
  /**
   * Arrival date to restore on an inbound movement that puts back stock this
   * ledger previously drew (FARM-MEDIUM-254). Leave unset for a genuine
   * receipt: the arrival is now, and the sink stamps it.
   *
   * Set it and the re-created `storage_inventory` row keeps the FEFO position
   * the lot had before it drained, instead of sorting as the freshest stock in
   * the location.
   */
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
}

/**
 * The lot a FEFO decrement actually drew from.
 *
 * For an un-pinned OUT the caller names no lot, so the decrement is the ONLY
 * place that knows which one left — and once a lot drains to zero its
 * `storage_inventory` row is deleted, taking its expiry with it.
 * `stock_movements` is the durable home for that fact
 * (`stock-movement.entity.ts` says so), but it can only carry what the sink
 * hands it. Returning the drawn identity is what lets the sink stamp the audit
 * row from what it TOUCHED rather than from what the caller happened to pass
 * (FARM-MEDIUM-254).
 */
interface DrawnLot {
  lotNumber: string | null;
  expiryDate: Date | null;
  receivedDate: Date | null;
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

/** Result of `recordMovement`. */
export interface RecordMovementResult {
  saved: StockMovement;
  /** True when the idempotency key matched an existing movement (no-op replay). */
  idempotentHit: boolean;
  warnings: ConditionWarning[];
  /**
   * The stock tiers (site, pool) this movement pushed into a worse band. The
   * matching durable `LowStockDetected` events have already been enqueued to
   * the outbox INSIDE the caller's transaction by this service (single
   * low-stock sink); callers use this field only for POST-COMMIT side effects,
   * never to re-emit the durable event. Empty on an idempotent replay.
   */
  lowStockCrossings: LowStockCrossing[];
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
    // FARM-CRITICAL-240'ın yazma tarafı: fiziksel anahtar üzerinde advisory
    // kilit. Satır kilidi HENÜZ VAR OLMAYAN satırı koruyamaz; iki eşzamanlı
    // giriş aynı (tenant, lokasyon, tip, item, lot) için iki satır yaratabilirdi.
    private readonly mutationLocks: StockMutationLockAuthority,
    // The FEFO allocator sits BEHIND resolveFeedDeductionLocation, not beside
    // it: feeding asks this service where to deduct from, and this service is
    // the only thing that asks the allocator. Two entry points would be two
    // places for the fail-closed rule to drift.
    private readonly feedAllocation: FeedAllocationService,
    // Plan K8: the ONE low-stock decision (site + pool tiers, ledger-based).
    private readonly lowStockEvaluator: LowStockEvaluator,
    // FARM-HIGH-337: the ONE writer of the catalog quantity/status projection.
    private readonly catalogProjector: CatalogStockProjector,
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
   * Domain events are NOT emitted here — the caller decides whether to
   * publish (the handler wrapper does; feeding callers rely on their own
   * FeedingRecorded / FeedInventory* outbox events).
   */
  async recordMovement(
    manager: EntityManager,
    input: RecordMovementInput,
    ctx: MovementContext,
  ): Promise<RecordMovementResult> {
    const { tenantId, userId, userName } = ctx;
    const { movementType, itemType, itemId, quantity } = input;

    // Miktar tam sayı hundredths'e derlenir: `numeric(15,2)` kolonun tutamayacağı
    // bir değer sessizce yuvarlanmak yerine reddedilir.
    stockQuantityUnits(quantity, 'Stock quantity');

    // KİLİT ÖNCE. Bu çağrının dokunacağı fiziksel kova ve — verilmişse —
    // idempotency ad alanı, HERHANGİ bir okumadan önce serileştirilir; aksi
    // hâlde idempotency kaydı okunup yazılana kadar geçen pencerede ikinci bir
    // yazar aynı anahtarı yaratabilir ve kaybeden ham 23505 alırdı.
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
        this.logger.log(`Idempotent hit: movement ${existing.id} for key ${input.idempotencyKey}`);
        return {
          saved: existing,
          idempotentHit: true,
          warnings: [],
          lowStockCrossings: [],
        };
      }
    }

    const itemDetails = await describeStorageItem(manager, tenantId, itemType, itemId);
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
    const asOfDate =
      input.movementDate instanceof Date
        ? input.movementDate
        : input.movementDate
          ? new Date(input.movementDate)
          : undefined;

    // What the FEFO decrement actually drew. For an un-pinned OUT the caller
    // named no lot, so this is the only place that knows which one left.
    const drawn: DrawnLot | null = fromLocation
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
        )
      : null;

    // Lot-mix detection — must run BEFORE increaseInventory so the service
    // sees the resident lots as "other" and not yet summed with the
    // incoming quantity.
    let effectiveLotNumber: string | null = null;
    if (toLocation && input.lotNumber) {
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
        input.lotNumber,
        input.expiryDate,
        // Restored provenance for a lot this ledger previously drained
        // (FARM-MEDIUM-254). Absent on a genuine receipt, where the arrival IS
        // now — `increaseInventory` stamps that itself.
        input.receivedDate,
        userId,
      );
    }

    // Re-project the catalog quantity + derived status from the ledger
    // (Feed/Chemical/Consumable; spare parts are derived at read time).
    await this.catalogProjector.project(manager, tenantId, itemType, itemId);

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
      // Stamped from what the sink TOUCHED, not only from what the caller
      // passed. No OUT caller supplies an expiry — the feeding ledger cannot,
      // because FEFO chooses the lot — so every outbound audit row carried a
      // NULL expiry and the entity's own promise to preserve it was false.
      lotNumber: effectiveLotNumber ?? input.lotNumber ?? drawn?.lotNumber ?? undefined,
      expiryDate: input.expiryDate ?? drawn?.expiryDate ?? undefined,
      // The other half of the lot identity (FARM-MEDIUM-254). The decrement
      // already knew it — `DrawnLot.receivedDate` — and it was being discarded
      // for want of a column, so a later return could not restore the FEFO
      // position it took.
      receivedDate: input.receivedDate ?? drawn?.receivedDate ?? undefined,
      idempotencyKey: input.idempotencyKey,
      performedBy: userId,
      performedByName: userName,
      performedAt: new Date(),
    });
    const saved = await movementRepo.save(movement);

    // Single low-stock sink, EDGE-triggered per tier (plan K8): the
    // evaluator reads the post-movement ledger inside this transaction and
    // reports only the tiers this movement pushed into a worse band, so a
    // feeding deduction, a work-order consumption and a manual OUT emit the
    // same signal once per crossing — never again on every later movement
    // that leaves stock already low. A soft-deleted location is not stock
    // (FARM-MEDIUM-293), so its side of the movement moves no tier.
    const lowStockCrossings = await this.lowStockEvaluator.crossingsForMovement(
      manager,
      tenantId,
      {
        itemType,
        itemId,
        quantity,
        fromSiteId: fromLocation && !fromLocation.isDeleted ? fromLocation.siteId : null,
        // A deleted TO location was refused in resolveLocations.
        toSiteId: toLocation ? toLocation.siteId : null,
      },
      itemDetails.poolReorderThreshold,
    );
    for (const crossing of lowStockCrossings) {
      await this.outboxPublisher.enqueue(
        buildLowStockDetectedEvent(tenantId, crossing, itemDetails, saved.id),
        manager,
      );
    }

    return { saved, idempotentHit: false, warnings, lowStockCrossings };
  }

  /**
   * Resolve WHERE a feeding OUT deduction draws from, for a feed the caller
   * knows only by `feedId`. This is the single entry point feeding uses; no
   * caller may reach the allocator around it.
   *
   * # The data-model impedance this solves
   *
   * A feeding event names a feed (and tank/batch), not a concrete storage
   * location, whereas `storage_inventory` keys on
   * `(tenantId, storageLocationId, itemType, itemId, lotNumber)`. This method
   * turns "feed X, N kg, as of D, optionally lot L, preferably site S" into the
   * concrete `(location, lot, kg)` slices the caller then issues as OUT
   * movements, INSIDE the feeding transaction.
   *
   * # Why it returns a PLAN and not one row
   *
   * It used to return a single FEFO row, and `decreaseInventory` then failed the
   * whole tenant transaction when that one row was short. Because the row key is
   * location+lot, that is routine even for a tenant that never uses lot numbers:
   * a warehouse plus a silo is two rows, and pour arithmetic leaves 0.2-2 kg
   * remainders. A 150 kg meal was refused with "Available: 0.3 kg" while the site
   * held 3000 kg (FARM-CRITICAL-245). The insufficiency decision now comes from
   * the POOL, and the deduction cascades across lots in FEFO order — one
   * immutable `stock_movements` row per slice, because aggregating them into one
   * would destroy the EU 178/2002 lot trace.
   *
   * # The contract this keeps (FARM-CRITICAL-237, PR #1244)
   *
   * There is NO non-deducting success path. The `feedHasStoragePresence`
   * predicate that used to gate this call is gone: it read a MUTABLE projection,
   * so a feed whose last lot was consumed answered "not storage-tracked" exactly
   * like a feed the tenant never storage-managed, and feeding committed with no
   * movement at all. Unresolvable stock is a real shortage and fails closed —
   * now by throwing `InsufficientFeedStockError` carrying the pool total the
   * operator actually has, which is strictly more than the previous `null`
   * carried. Deleting a projection row can no longer revive the retired
   * feed_inventory path, because there is no branch left to revive.
   *
   * Supplied-lot binding survives the change: when the payload names a concrete
   * feed batch, allocation is constrained to THAT lot, so a missing lot fails
   * closed with a lot-specific message rather than silently drawing from a
   * different physical lot.
   *
   * @throws InsufficientFeedStockError when the eligible pool cannot cover `quantityKg`
   */
  async resolveFeedDeductionLocation(
    manager: EntityManager,
    tenantId: string,
    feedId: string,
    quantityKg: number,
    asOf: Date,
    lotNumber?: string,
    /**
     * D-9 site kapsamı: verilirse önce ÜNİTENİN SİTESİNİN lokasyonlarındaki
     * lotlar tüketilir (düşüm + forecast aynı kapsamı okur), site havuzu
     * yetmezse tenant-geneli lotlarla DEVAM edilir (`usedSiteFallback=true`).
     */
    siteId?: string,
  ): Promise<FeedAllocationResult> {
    return this.feedAllocation.allocateForDeduction(manager, tenantId, {
      feedId,
      quantityKg,
      asOf,
      lotNumber,
      siteId,
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

    // TRANSFER moves stock between two locations, so BOTH legs are mandatory.
    //
    // Without this branch the method returned {null, null} for a transfer: the
    // decrement and the increment are both gated on a resolved location, so the
    // sink silently moved nothing while still writing the audit row that claims
    // it did, and still recomputing the roll-up. Fail-open, and invisible —
    // there is no error to see and the ledger reads as if the move happened.
    // No caller reaches it today (TransferStockHandler hand-writes its rows,
    // which is FARM-HIGH-239's other half), so this closes the hole BEFORE the
    // handler is routed through here rather than after.
    if (movementType === MovementType.TRANSFER) {
      if (!input.fromLocationId || !input.toLocationId) {
        throw new BadRequestException(
          'Both fromLocationId and toLocationId are required for transfer movements',
        );
      }
      if (input.fromLocationId === input.toLocationId) {
        throw new BadRequestException('A transfer must move stock between two different locations');
      }
      fromLocation = await locationRepo.findOne({
        where: { id: input.fromLocationId, tenantId },
      });
      if (!fromLocation) {
        throw new NotFoundException(`Storage location "${input.fromLocationId}" not found`);
      }
      toLocation = await locationRepo.findOne({ where: { id: input.toLocationId, tenantId } });
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
      // A NAMED side must exist. Returning null here made the sink skip the
      // mutation while still writing the audit row that claims it happened —
      // the same fail-open the TRANSFER branch above closes.
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

    // INVARIANT (plan K8, FARM-MEDIUM-293): stock in a soft-deleted location is
    // on-hand for no reader — not the tiers, not the catalog projection, not
    // FEFO. Booking stock INTO one would make it vanish while the audit row says
    // it arrived (and a PO receipt would shrink on-order with no on-hand gain,
    // hiding a pool crossing). A deleted location may still be DRAINED (the
    // from side), never filled. A spare part whose home location was deleted is
    // stopped here too, instead of silently losing its receipts.
    if (toLocation !== null && toLocation.isDeleted) {
      throw new BadRequestException(
        `Storage location "${toLocation.id}" is deleted; stock cannot be booked into it`,
      );
    }

    return { fromLocation, toLocation };
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
  ): Promise<DrawnLot> {
    let inventory: StorageInventory | null;

    if (lotNumber) {
      inventory = await repo.findOne({
        where: { tenantId, storageLocationId: locationId, itemType, itemId, lotNumber },
        lock: { mode: 'pessimistic_write' },
      });
    } else {
      const effectiveAsOf = asOfDate ?? new Date();
      inventory = await repo
        .createQueryBuilder('inv')
        .andWhere('inv.storageLocationId = :locationId', { locationId })
        .andWhere('inv.itemType = :itemType', { itemType })
        .andWhere('inv.itemId = :itemId', { itemId })
        .andWhere('inv.quantity > 0')
        .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :today)', { today: new Date() })
        .andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', {
          asOf: effectiveAsOf,
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

    // Capture the lot's identity BEFORE the row is mutated or removed. Once a
    // lot drains to zero the row is deleted (below), and with it the only record
    // of that lot's expiry — `stock_movements` is the durable home for it, but
    // it can only carry what the sink knows it touched.
    const drawn: DrawnLot = {
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
    /** Restored arrival date; undefined = a genuine receipt arriving now. */
    receivedDate: Date | undefined,
    userId: string,
  ): Promise<void> {
    // `IsNull()`, not `undefined`: TypeORM DROPS an undefined condition from the
    // where clause entirely, so an un-lotted receipt would match — and then top
    // up — an arbitrary LOTTED row for the same item in the same location. That
    // is wrong with no concurrency at all (FARM-CRITICAL-240).
    //
    // The lock mirrors the decrease path below (:728/:745). Without it this was
    // an unlocked check-then-insert: two concurrent receipts for the same
    // un-lotted feed both read "absent" and both inserted, splitting the
    // physical-stock projection in two. The canonical unique index restored in
    // 1809700000000 is the structural backstop — a genuine race now raises
    // 23505 and rolls the transaction back rather than silently duplicating.
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
        // Stamp `receivedDate` on the initial insert so the FEFO ORDER BY
        // (expiryDate, receivedDate, lotNumber) has a real timestamp to
        // compare against. A restored lot supplies its ORIGINAL arrival
        // (FARM-MEDIUM-254): re-creating a drained row with `now()` would make
        // the oldest feed in the location sort as the freshest.
        receivedDate: receivedDate ?? new Date(),
        createdBy: userId,
        updatedBy: userId,
      });
      await repo.save(inventory);
    }
  }
}
