/**
 * CreateFeedingRecordHandler
 *
 * CreateFeedingRecordCommand'ı işler ve yeni yemleme kaydı oluşturur.
 * Otomatik stok düşümü yapar: ilgili FeedInventory'den tüketilen miktar düşülür.
 *
 * Phase A refactor:
 *  - Replaced fire-and-forget eventBus.publish() (post-commit, @Optional
 *    injection that silently dropped events) with OutboxPublisher.enqueue()
 *    inside the same transaction as the domain write.
 *  - Moved Batch + Feed validation reads INSIDE the transaction with
 *    pessimistic_write lock on Batch to eliminate the TOCTOU race where the
 *    batch could be deactivated between the pre-check and the feeding write.
 *
 * Feed dual-SSoT write-path correctness (Phase A):
 *  - Asserts the locked batch is feedable (BatchDomainService.assertFeedable)
 *    INSIDE the tx — feeding an empty / non-feedable batch is rejected before
 *    any stock is touched.
 *  - Deducts feed from the storage ledger (StorageInventory + Feed.quantity
 *    roll-up) via StockMovementService.recordMovement on the SAME
 *    queryRunner.manager — but ONLY when the feed is storage-tracked
 *    (feedHasStoragePresence). For a storage-tracked feed, insufficient stock
 *    / no-lot throws and ROLLS BACK the whole feeding — replacing the old
 *    async storage event handler that swallowed its failure and let the two
 *    ledgers diverge silently. For a feed the tenant does NOT track in storage
 *    (zero storage rows — e.g. a tenant that never adopted the warehouse
 *    module), the storage OUT is SKIPPED with an observable structured warn
 *    and the feed_inventory-only path applies, so a pre-Phase-B tenant is not
 *    pushed off a fail-closed cliff.
 *  - KEEPS the legacy feed_inventory decrement: the GetFeedInventory read
 *    path still reads feed_inventory.quantityKg, so both ledgers update
 *    atomically (or roll back together). Collapsing onto one ledger is
 *    Phase B (table merge + read re-points + destructive migration).
 *
 * @module Feeding/Handlers
 */
import { randomUUID } from 'crypto';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso, FeedInventoryLowEvent, FeedingRecordedEvent , createBaseEvent } from '@platform/event-contracts';
import { CreateFeedingRecordCommand } from '../commands/create-feeding-record.command';
import { FeedingRecord, FeedingMethod } from '../entities/feeding-record.entity';
import { FeedInventory, InventoryStatus } from '../entities/feed-inventory.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { MovementType } from '../../storage/entities/stock-movement.entity';
import { StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

@Injectable()
@CommandHandler(CreateFeedingRecordCommand)
export class CreateFeedingRecordHandler implements ICommandHandler<CreateFeedingRecordCommand, FeedingRecord> {
  private readonly logger = new Logger(CreateFeedingRecordHandler.name);

  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(FeedInventory)
    private readonly inventoryRepository: Repository<FeedInventory>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly backdatePolicy: BackdatePolicyService,
    private readonly batchDomainService: BatchDomainService,
    private readonly stockMovementService: StockMovementService,
    private readonly financeSettings: FinanceSettingsService,
  ) {}

  async execute(command: CreateFeedingRecordCommand): Promise<FeedingRecord> {
    const { tenantId, payload, userId } = command;

    // ── Backdate policy: reject future feedingDates unconditionally and
    // reject historical dates that fall beyond the configured feeding
    // limit (FEEDING_BACKDATE_LIMIT_DAYS env var, default 7). See
    // docs/illustrator/ Girdi 8 — unbounded backdating corrupts
    // downstream FCR / SGR derivations that assume time-ordered events.
    const proposedDate: Date =
      payload.feedingDate instanceof Date
        ? payload.feedingDate
        : new Date(payload.feedingDate);
    this.backdatePolicy.validate({
      context: 'feeding',
      proposedDate,
      subjectLabel: `batch ${payload.batchId}`,
    });

    // All reads + writes inside a single transaction. TOCTOU fix: batch/feed
    // lookups now run with pessimistic locks so a concurrent CloseBatch or
    // feed-delete cannot mutate state between the validation and the write.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Batch'i doğrula (inside TX with pessimistic_write lock)
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: payload.batchId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${payload.batchId} bulunamadı`);
      }

      if (!batch.isActive) {
        throw new BadRequestException('Aktif olmayan batch için yemleme kaydı oluşturulamaz');
      }

      // Reject feeding an empty (currentQuantity ≤ 0) or non-feedable
      // (HARVESTED / CLOSED / FAILED / …) batch. Recording feed against such
      // a batch inflates totalFeedConsumed with no biomass and corrupts FCR.
      // Runs on the pessimistically-locked batch so the decision cannot race
      // a concurrent CloseBatch / final harvest. Throws BadRequestException.
      this.batchDomainService.assertFeedable(batch);

      // Feed'i doğrula (inside TX)
      const feed = await queryRunner.manager.findOne(Feed, {
        where: { id: payload.feedId, tenantId },
      });

      if (!feed) {
        throw new NotFoundException(`Feed ${payload.feedId} bulunamadı`);
      }

      // Yemleme kaydını oluştur
      const feedingRecord = queryRunner.manager.create(FeedingRecord, {
        tenantId,
        batchId: payload.batchId,
        tankId: payload.tankId,
        pondId: payload.pondId,
        batchLocationId: payload.batchLocationId,

        feedingDate: payload.feedingDate,
        feedingTime: payload.feedingTime,
        feedingSequence: payload.feedingSequence || 1,
        totalMealsToday: payload.totalMealsToday || 1,

        feedId: payload.feedId,
        feedBatchNumber: payload.feedBatchNumber,

        plannedAmount: payload.plannedAmount,
        actualAmount: payload.actualAmount,
        wasteAmount: payload.wasteAmount,

        environment: payload.environment,
        fishBehavior: payload.fishBehavior,

        feedingMethod: payload.feedingMethod || FeedingMethod.MANUAL,
        equipmentId: payload.equipmentId,
        feedingDurationMinutes: payload.feedingDurationMinutes,

        feedCost: payload.feedCost || this.calculateFeedCost(feed, payload.actualAmount),
        // Currency SSoT: the tenant's finance settings resolve the default —
        // never a hardcoded literal. The previous NOK fallback here is what
        // drifted against the farm entities' TRY defaults and HR's USD.
        currency:
          payload.currency ||
          (await this.financeSettings.getDefaultCurrencyInTx(queryRunner.manager, tenantId)),

        fedBy: payload.fedBy || userId,
        notes: payload.notes,
        skipReason: payload.skipReason,
      });

      // Varyans hesapla
      feedingRecord.calculateVariance();

      // Feeding record kaydet (transaction içinde)
      const saved = await queryRunner.manager.save(feedingRecord);

      // Batch'in toplam yem tüketimini güncelle
      batch.totalFeedConsumed = Number(batch.totalFeedConsumed || 0) + payload.actualAmount;
      batch.totalFeedCost = Number(batch.totalFeedCost || 0) + (saved.feedCost ?? 0);
      await queryRunner.manager.save(batch);

      // Storage-ledger deduction (StorageInventory + Feed.quantity roll-up),
      // INSIDE this transaction, fail-closed. Replaces the old async
      // FeedingStorageEventHandler that swallowed insufficient-stock / errors
      // and let the storage ledger drift from the feeding ledger. If the feed
      // has no usable lot in any storage location, or the located lot has
      // insufficient stock, this throws and the whole feeding rolls back.
      await this.deductFromStorageLedger(
        queryRunner.manager,
        tenantId,
        payload.feedId,
        payload.actualAmount,
        payload.feedBatchNumber,
        new Date(payload.feedingDate),
        saved.id,
        userId,
      );

      // Legacy feed_inventory deduction — STILL the SSoT the GetFeedInventory
      // read path uses, so it must stay in sync with the storage ledger. Both
      // deductions run inside the same tx: they commit or roll back together,
      // so the two ledgers never diverge. May also enqueue a
      // FeedInventoryLowEvent on the outbox if stock hits the reorder point.
      // (Collapsing onto a single ledger is Phase B.)
      await this.deductFeedInventory(
        queryRunner.manager,
        tenantId,
        payload.feedId,
        payload.actualAmount,
        payload.feedBatchNumber,
        userId,
      );

      // Enqueue FeedingRecordedEvent into the transactional outbox BEFORE commit.
      // Storage deduction is now done IN-TX above (no longer driven by this
      // event), so this event is purely a downstream-integration / analytics
      // notification. Enqueued on the outbox so it commits atomically with the
      // feeding record and never fires for a rolled-back feeding.
      const feedingEvent: FeedingRecordedEvent = {
        ...createBaseEvent<FeedingRecordedEvent>('FeedingRecorded', tenantId, { aggregateId: payload.batchId, aggregateType: 'Batch' }),
        userId,
        batchId: payload.batchId,
        tankId: payload.tankId,
        feedId: payload.feedId,
        plannedAmountKg: payload.plannedAmount ?? 0,
        actualAmountKg: payload.actualAmount,
        feedingDate: toEventIso(payload.feedingDate),
        feedingTime: payload.feedingTime || '',
        variance: (payload.actualAmount - (payload.plannedAmount ?? 0)),
        // Additive money fields (finance capability): string-encoded decimal
        // per HR-MEDIUM-001 so downstream finance projections never touch
        // IEEE 754 arithmetic.
        feedCost: saved.feedCost != null ? Number(saved.feedCost).toFixed(2) : undefined,
        currency: saved.feedCost != null ? saved.currency : undefined,
      };
      await this.outboxPublisher.enqueue(feedingEvent, queryRunner.manager);

      // The transactional boundary commits (feeding record + batch update +
      // inventory deduction + outbox row(s) are all atomic) on return, and
      // rolls back + rethrows on any throw above.
      return saved;
    });
  }

  /**
   * Deduct the fed amount from the storage ledger (StorageInventory +
   * Feed.quantity roll-up + immutable StockMovement audit row) INSIDE the
   * caller's transaction, fail-closed FOR STORAGE-TRACKED FEEDS.
   *
   * # Two independently-populated ledgers, two correct outcomes (Phase A)
   *
   * Feed stock is populated by two separate operator workflows:
   * `feed_inventory` (add-feed-inventory) and `storage_inventory`
   * (receive-delivery). A tenant may use feeding + feed_inventory and never
   * have adopted the storage/warehouse module — for that tenant there are
   * ZERO storage rows for the feed, and the feed_inventory-only path is the
   * correct (pre-existing) behaviour. So this method first distinguishes
   * "tenant does not track this feed in storage" from "storage-tracked feed
   * is short":
   *
   *   - NO storage presence for the feed (feedHasStoragePresence == false)
   *     → the tenant does not manage this feed in storage. SKIP the storage
   *       OUT deduction and proceed (the legacy feed_inventory deduction
   *       still runs). Emit an OBSERVABLE structured warn so the pre-Phase-B
   *       divergence is visible — NOT a swallowed catch, NOT a failure.
   *   - Storage presence EXISTS but no usable lot / insufficient quantity
   *     → a REAL shortage for a storage-managed feed → FAIL-CLOSED: let
   *       recordMovement (or the no-lot guard) throw so the whole feeding
   *       rolls back.
   *
   * The presence check + the resolve both run on the SAME locked/in-tx
   * manager so they are consistent with each other and with the deduction.
   *
   * When a concrete feed batch (lotNumber) is on the payload, the location is
   * resolved for THAT supplied lot (Blocker-4): a lot that exists only in
   * feed_inventory but not in storage routes into the no-usable-lot policy
   * with a lot-specific message instead of silently deducting a different
   * FEFO lot. The idempotency key is derived from the feeding record id so a
   * retried feeding does not double-deduct.
   */
  private async deductFromStorageLedger(
    manager: EntityManager,
    tenantId: string,
    feedId: string,
    actualAmountKg: number,
    feedBatchNumber: string | undefined,
    feedingDate: Date,
    feedingRecordId: string,
    userId: string,
  ): Promise<void> {
    // Does the tenant track this feed in storage at all? If not, the
    // feed_inventory-only path is correct and the storage OUT is skipped —
    // observably, so the divergence is not silent.
    const hasStoragePresence = await this.stockMovementService.feedHasStoragePresence(
      manager,
      tenantId,
      feedId,
    );

    if (!hasStoragePresence) {
      this.logger.warn(
        'Storage ledger not tracked for feed — skipping in-transaction storage ' +
          'deduction; feed_inventory-only path applies (pre-Phase-B divergence is ' +
          'expected for this tenant). ' +
          `feedId=${feedId}, tenantId=${tenantId}, feedingRecordId=${feedingRecordId}, ` +
          `actualAmountKg=${actualAmountKg}`,
      );
      return;
    }

    // Storage-tracked feed: resolve the location of the supplied lot (or the
    // FEFO-preferred usable lot when no lot is named), as of the feeding
    // instant.
    const location = await this.stockMovementService.resolveFeedDeductionLocation(
      manager,
      tenantId,
      feedId,
      feedingDate,
      feedBatchNumber,
    );

    if (!location) {
      // Storage-tracked feed with no usable lot (expired / out-of-stock, or
      // the SUPPLIED lot is absent from storage) → REAL shortage →
      // fail-closed: throw rolls back the whole feeding.
      throw new BadRequestException(
        feedBatchNumber
          ? `Feed ${feedId} lot "${feedBatchNumber}" has no available storage stock to deduct ` +
              `${actualAmountKg}kg. Receive this lot into a storage location before recording this feeding.`
          : `Feed ${feedId} has no available storage stock to deduct ${actualAmountKg}kg. ` +
              `Receive feed into a storage location before recording this feeding.`,
      );
    }

    await this.stockMovementService.recordMovement(
      manager,
      {
        movementType: MovementType.OUT,
        itemType: StorageItemType.FEED,
        itemId: feedId,
        quantity: actualAmountKg,
        fromLocationId: location.storageLocationId,
        // The resolved location already corresponds to the supplied lot (when
        // one was named) — resolveFeedDeductionLocation constrained the read
        // to it — so use the resolved lot for the OUT deduction.
        lotNumber: location.lotNumber,
        reference: `FEEDING: ${feedingRecordId}`,
        reason: 'Auto-deducted from feeding record (in-transaction).',
        idempotencyKey: `feeding-deduct-${feedingRecordId}`,
        movementDate: feedingDate,
      },
      { tenantId, userId, userName: 'Feeding' },
    );
  }

  /**
   * Stoktan yem düşümü yapar.
   * feedBatchNumber (lotNumber) verilmişse önce o lot'tan düşer.
   * Verilmemişse FIFO mantığıyla en eski AVAILABLE stoktan düşer.
   *
   * Legacy feed_inventory ledger. KEPT in Phase A because the
   * GetFeedInventory read path still reads feed_inventory.quantityKg. Runs in
   * the same tx as the storage deduction (above) so the two ledgers stay in
   * sync. Insufficient feed_inventory is clamped to 0 (not fail-closed) here
   * because the fail-closed authority is the storage ledger; this writer's
   * sole job in Phase A is to keep the legacy read surface consistent.
   */
  private async deductFeedInventory(
    manager: import('typeorm').EntityManager,
    tenantId: string,
    feedId: string,
    actualAmountKg: number,
    feedBatchNumber?: string,
    userId?: string,
  ): Promise<void> {
    // Uygun inventory'yi bul
    let feedInventory: FeedInventory | null = null;

    if (feedBatchNumber) {
      // Lot numarasına göre bul
      feedInventory = await manager.findOne(FeedInventory, {
        where: {
          tenantId,
          feedId,
          lotNumber: feedBatchNumber,
          status: In([InventoryStatus.AVAILABLE, InventoryStatus.LOW_STOCK]),
        },
        lock: { mode: 'pessimistic_write' },
      });
    }

    if (!feedInventory) {
      // FIFO: en eski kullanılabilir stoktan düş
      feedInventory = await manager.findOne(FeedInventory, {
        where: {
          tenantId,
          feedId,
          status: In([InventoryStatus.AVAILABLE, InventoryStatus.LOW_STOCK]),
        },
        order: { receivedDate: 'ASC', createdAt: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
    }

    if (!feedInventory) {
      this.logger.warn(
        `No available feed inventory found for feedId=${feedId}, tenantId=${tenantId}. ` +
        `Feeding record created without inventory deduction.`,
      );
      return;
    }

    const currentQuantity = Number(feedInventory.quantityKg);
    const newQuantity = currentQuantity - actualAmountKg;

    if (newQuantity < 0) {
      this.logger.warn(
        `Feed inventory insufficient: ${currentQuantity}kg available, ${actualAmountKg}kg requested. ` +
        `Setting inventory to 0. inventoryId=${feedInventory.id}`,
      );
    }

    feedInventory.quantityKg = Math.max(0, newQuantity);
    feedInventory.updatedBy = userId;

    // Toplam değeri güncelle
    if (feedInventory.unitPricePerKg) {
      feedInventory.totalValue = Number(feedInventory.unitPricePerKg) * feedInventory.quantityKg;
    }

    // Durumu güncelle
    feedInventory.updateStatus();

    await manager.save(feedInventory);

    this.logger.debug(
      `Feed inventory deducted: inventoryId=${feedInventory.id}, ` +
      `${currentQuantity}kg -> ${feedInventory.quantityKg}kg (used ${actualAmountKg}kg)`,
    );

    // Enqueue FeedInventoryLowEvent into the transactional outbox if the
    // remaining stock crosses the reorder threshold. The same `manager`
    // participates in the caller's transaction so the event commits atomically
    // with the inventory update.
    if (feedInventory.quantityKg <= feedInventory.minStockKg) {
      const lowStockEvent: FeedInventoryLowEvent = {
        ...createBaseEvent<FeedInventoryLowEvent>('FeedInventoryLow', tenantId, { aggregateId: feedInventory.id, aggregateType: 'FeedInventory' }),
        userId,
        inventoryId: feedInventory.id,
        feedId: feedInventory.feedId,
        siteId: feedInventory.siteId,
        currentQuantityKg: feedInventory.quantityKg,
        reorderPointKg: feedInventory.minStockKg,
        status: feedInventory.quantityKg <= 0 ? 'critical' : 'low_stock',
      };
      await this.outboxPublisher.enqueue(lowStockEvent, manager);
    }
  }

  private calculateFeedCost(feed: Feed, amountKg: number): number {
    if (!feed.pricePerKg) return 0;
    return Number(feed.pricePerKg) * amountKg;
  }
}
