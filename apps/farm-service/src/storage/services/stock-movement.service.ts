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
import type { LowStockDetectedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';

import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed, FeedStatus } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { ConditionWarning } from '../dto/stock-movement.response';
import { LotMixService } from './lot-mix.service';
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
    // FARM-CRITICAL-240'ın yazma tarafı: fiziksel anahtar üzerinde advisory
    // kilit. Satır kilidi HENÜZ VAR OLMAYAN satırı koruyamaz; iki eşzamanlı
    // giriş aynı (tenant, lokasyon, tip, item, lot) için iki satır yaratabilirdi.
    private readonly mutationLocks: StockMutationLockAuthority,
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

    // Post-update aggregate quantity across all locations for the item —
    // read inside the tx so it reflects the just-applied mutation. Used for
    // low-stock detection on stock-reducing movements only.
    let currentTotal = 0;
    let lowStock: RecordMovementResult['lowStock'] = null;
    if (
      fromLocation &&
      (movementType === MovementType.OUT || movementType === MovementType.WASTE)
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

      if (lowStock) {
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
   * Resolve which storage location + lot a feeding OUT deduction should
   * draw from, for a feed the caller knows only by `feedId`.
   *
   * # The data-model impedance this solves
   *
   * A feeding event names a feed (and tank/batch), not a concrete storage
   * location, whereas `storage_inventory` keys on
   * `(tenantId, storageLocationId, itemType, itemId, lotNumber)`. This
   * method finds the FEFO-preferred lot of the feed ACROSS every storage
   * location and returns that location + lot so the caller can issue a
   * concrete OUT `recordMovement`. It is the same FEFO lot-selection the
   * old (now-deleted) async storage event handler performed inline — moved
   * here so it runs INSIDE the feeding transaction.
   *
   * # Supplied-lot binding (Blocker-4 correctness)
   *
   * When the feeding payload names a concrete feed batch (`lotNumber`), the
   * deduction MUST draw from THAT lot — not from whatever FEFO would pick.
   * So this resolves the location of the SUPPLIED lot: it constrains the read
   * to `inv.lotNumber = :lotNumber`. If that specific lot is absent from
   * storage (it may exist only in feed_inventory), the read returns null and
   * the caller routes into the no-usable-lot policy with a lot-specific
   * message — it does NOT silently fall through to a different FEFO lot, which
   * would deduct from the wrong physical stock and break lot traceability.
   * When no `lotNumber` is supplied, FEFO selects across all lots as before.
   *
   * FEFO with the same three compliance guarantees the decrement enforces:
   *   1. deterministic tiebreak (expiryDate, receivedDate, lotNumber)
   *   2. expired-lot exclusion (never feed fish an expired lot)
   *   3. as-of scoping (a backdated feeding cannot pull from a lot that
   *      arrived after the feeding occurred)
   *
   * Returns `null` when NO storage location stocks a usable lot of the feed
   * (or of the supplied lot). After the single-ledger cutover, callers always
   * treat that result as an actual shortage and fail closed. Mutable projection
   * presence is never an authority-mode switch: a depleted row may be removed,
   * but that cannot revive the retired feed_inventory compatibility path.
   */
  async resolveFeedDeductionLocation(
    manager: EntityManager,
    tenantId: string,
    feedId: string,
    asOf: Date,
    lotNumber?: string,
    /**
     * D-9 site kapsamı: verilirse önce ÜNİTENİN SİTESİNİN lokasyonlarındaki
     * lotlar denenir (düşüm + forecast aynı kapsamı okur); site'ta uygun lot
     * yoksa belgeli tenant-geneli fallback (`usedSiteFallback=true`) uygulanır.
     */
    siteId?: string,
  ): Promise<{ storageLocationId: string; lotNumber?: string; usedSiteFallback: boolean } | null> {
    const buildQuery = (scopeSiteId?: string) => {
      const query = tenantManagerRepo(manager, StorageInventory, tenantId)
        .createQueryBuilder('inv')
        .andWhere('inv.itemType = :itemType', { itemType: StorageItemType.FEED })
        .andWhere('inv.itemId = :itemId', { itemId: feedId })
        .andWhere('inv.quantity > 0')
        .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :today)', { today: new Date() })
        .andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', { asOf });
      if (scopeSiteId) {
        // Join şartı TypeORM PROPERTY sözdiziminde yazılır (`inv.storageLocationId`),
        // tırnaklı kolon adıyla DEĞİL: `StorageInventory.storageLocationId` →
        // `storage_location_id`, `StorageLocation.siteId` → `site_id` (entity'de
        // açık `name:`). Tırnaklı `inv."storageLocationId"` ifadesini TypeORM
        // property-eşlemesine sokmaz, SQL'e birebir geçirir ve her site-kapsamlı
        // düşüm `42703 column inv.storageLocationId does not exist` ile patlardı
        // (FARM-CRITICAL-237). Eşleme sorumluluğu ORM'de kalır.
        query.innerJoin(
          StorageLocation,
          'loc',
          'loc.id = inv.storageLocationId AND loc.siteId = :scopeSiteId',
          { scopeSiteId },
        );
      }
      // Supplied-lot binding: when a concrete feed batch is named, resolve the
      // location of THAT lot only, so the OUT deduction hits the physical lot
      // the operator declared (and never a different FEFO lot).
      if (lotNumber) {
        query.andWhere('inv.lotNumber = :lotNumber', { lotNumber });
      }
      return query
        .orderBy('inv.expiryDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.receivedDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.lotNumber', 'ASC')
        .getOne();
    };

    if (siteId) {
      const siteScoped = await buildQuery(siteId);
      if (siteScoped) {
        return {
          storageLocationId: siteScoped.storageLocationId,
          lotNumber: siteScoped.lotNumber,
          usedSiteFallback: false,
        };
      }
    }
    const inventory = await buildQuery(undefined);
    if (!inventory) return null;
    return {
      storageLocationId: inventory.storageLocationId,
      lotNumber: inventory.lotNumber,
      usedSiteFallback: !!siteId,
    };
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
      if (input.toLocationId) {
        toLocation = await locationRepo.findOne({ where: { id: input.toLocationId, tenantId } });
      }
      if (input.fromLocationId) {
        fromLocation = await locationRepo.findOne({
          where: { id: input.fromLocationId, tenantId },
        });
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
    // The roll-up target is locked BEFORE the SUM is taken, not after.
    //
    // Order matters: this is a read-modify-write of a single aggregate row from
    // a sum over many rows. Two movements against different lots of the same
    // feed commit concurrently; under READ COMMITTED each would otherwise sum
    // without seeing the peer's uncommitted row and the second write would
    // overwrite the first with a total missing that movement (FARM-CRITICAL-240).
    // Taking the row lock first makes the pair serialize, so the later SUM runs
    // after the earlier transaction has committed and sees its row.
    //
    // Lock ORDER across the service stays inventory-row → aggregate-row, because
    // this method is only ever called after the inventory mutation. Reversing it
    // anywhere would open an AB-BA cycle.
    const sumInventory = async (): Promise<number> => {
      const result = await tenantManagerRepo(manager, StorageInventory, tenantId)
        .createQueryBuilder('inv')
        .select('COALESCE(SUM(inv.quantity), 0)', 'total')
        .andWhere('inv.itemType = :itemType', { itemType })
        .andWhere('inv.itemId = :itemId', { itemId })
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
}
