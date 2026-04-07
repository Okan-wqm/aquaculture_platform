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
 * @module Feeding/Handlers
 */
import { randomUUID } from 'crypto';

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { FeedInventoryLowEvent, FeedingRecordedEvent } from '@platform/event-contracts';
import { CreateFeedingRecordCommand } from '../commands/create-feeding-record.command';
import { FeedingRecord, FeedingMethod } from '../entities/feeding-record.entity';
import { FeedInventory, InventoryStatus } from '../entities/feed-inventory.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';

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
  ) {}

  async execute(command: CreateFeedingRecordCommand): Promise<FeedingRecord> {
    const { tenantId, payload, userId } = command;

    // All reads + writes inside a single transaction. TOCTOU fix: batch/feed
    // lookups now run with pessimistic locks so a concurrent CloseBatch or
    // feed-delete cannot mutate state between the validation and the write.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
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
        currency: payload.currency || 'NOK',

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

      // Otomatik stok düşüm — may also enqueue a FeedInventoryLowEvent on the
      // outbox if stock hits the reorder point.
      await this.deductFeedInventory(
        queryRunner.manager,
        tenantId,
        payload.feedId,
        payload.actualAmount,
        payload.feedBatchNumber,
        userId,
      );

      // Enqueue FeedingRecordedEvent into the transactional outbox BEFORE commit.
      // The storage module consumes this NATS event to auto-deduct feed inventory
      // and update reorder projections — this is the key integration that
      // connects farm operations to inventory management. With the outbox the
      // feeding record and integration event commit atomically.
      const feedingEvent: FeedingRecordedEvent = {
        eventId: randomUUID(),
        eventType: 'FeedingRecorded',
        timestamp: new Date(),
        tenantId,
        version: 1,
        userId,
        aggregateId: payload.batchId,
        aggregateType: 'Batch',
        batchId: payload.batchId,
        tankId: payload.tankId,
        feedId: payload.feedId,
        plannedAmountKg: payload.plannedAmount ?? 0,
        actualAmountKg: payload.actualAmount,
        feedingDate: new Date(payload.feedingDate),
        feedingTime: payload.feedingTime || '',
        variance: (payload.actualAmount - (payload.plannedAmount ?? 0)),
      };
      await this.outboxPublisher.enqueue(feedingEvent, queryRunner.manager);

      // Commit transaction (feeding record + batch update + inventory
      // deduction + outbox row(s) are all atomic)
      await queryRunner.commitTransaction();

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Stoktan yem düşümü yapar.
   * feedBatchNumber (lotNumber) verilmişse önce o lot'tan düşer.
   * Verilmemişse FIFO mantığıyla en eski AVAILABLE stoktan düşer.
   * Stok yetersiz olsa bile feeding record engellenmez (operasyonel gereklilik).
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
        eventId: randomUUID(),
        eventType: 'FeedInventoryLow',
        timestamp: new Date(),
        tenantId,
        version: 1,
        userId,
        aggregateId: feedInventory.id,
        aggregateType: 'FeedInventory',
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
