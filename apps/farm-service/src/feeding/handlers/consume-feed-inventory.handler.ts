/**
 * ConsumeFeedInventoryHandler
 *
 * ConsumeFeedInventoryCommand'ı işler ve stoktan tüketim yapar.
 *
 * SECURITY FIX: Added DataSource injection and wrapped all operations in a
 * transaction with pessimistic_write lock to prevent TOCTOU race conditions
 * (double-spend of feed inventory). Math.max(0, ...) added to prevent
 * negative inventory quantities.
 *
 * @module Feeding/Handlers
 */
import { randomUUID } from 'crypto';

import { Injectable, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { FeedInventoryLowEvent } from '@platform/event-contracts';
import { ConsumeFeedInventoryCommand, ConsumptionReason } from '../commands/consume-feed-inventory.command';
import { FeedInventory, InventoryStatus } from '../entities/feed-inventory.entity';

@Injectable()
@CommandHandler(ConsumeFeedInventoryCommand)
export class ConsumeFeedInventoryHandler implements ICommandHandler<ConsumeFeedInventoryCommand, FeedInventory> {
  private readonly logger = new Logger(ConsumeFeedInventoryHandler.name);

  constructor(
    @InjectRepository(FeedInventory)
    private readonly inventoryRepository: Repository<FeedInventory>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: ConsumeFeedInventoryCommand): Promise<FeedInventory> {
    const { tenantId, payload, userId } = command;

    // All reads and writes inside a single transaction with pessimistic lock
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: FeedInventory;

    try {
      // Inventory'yi bul with pessimistic lock (prevents concurrent consumption)
      const inventory = await queryRunner.manager.findOne(FeedInventory, {
        where: { id: payload.inventoryId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!inventory) {
        throw new NotFoundException(`Inventory ${payload.inventoryId} bulunamadı`);
      }

      // Stok kontrolü
      if (inventory.status === InventoryStatus.OUT_OF_STOCK) {
        throw new BadRequestException('Stok tükendi');
      }

      if (inventory.status === InventoryStatus.EXPIRED && payload.reason !== ConsumptionReason.EXPIRED) {
        throw new BadRequestException('Süresi geçmiş stok kullanılamaz');
      }

      const currentQuantity = Number(inventory.quantityKg);
      if (payload.quantityKg > currentQuantity) {
        throw new BadRequestException(
          `Yetersiz stok. Mevcut: ${currentQuantity} kg, Talep: ${payload.quantityKg} kg`,
        );
      }

      // Stoğu azalt (Math.max to prevent negative inventory)
      inventory.quantityKg = Math.max(0, currentQuantity - payload.quantityKg);
      inventory.updatedBy = userId;

      // Toplam değeri güncelle
      if (inventory.unitPricePerKg) {
        inventory.totalValue = Number(inventory.unitPricePerKg) * inventory.quantityKg;
      }

      // Durumu güncelle
      inventory.updateStatus();

      // Kaydet
      saved = await queryRunner.manager.save(FeedInventory, inventory);

      // Commit transaction
      await queryRunner.commitTransaction();
    } catch (error) {
      // Rollback transaction on any error
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // Release query runner
      await queryRunner.release();
    }

    // Publish domain event: FeedInventoryLow (low stock alert) -- after commit, outside transaction
    if (saved.status === InventoryStatus.LOW_STOCK && this.eventBus) {
      try {
        const event: FeedInventoryLowEvent = {
          eventId: randomUUID(),
          eventType: 'FeedInventoryLow',
          tenantId,
          timestamp: new Date(),
          inventoryId: saved.id,
          feedId: saved.feedId,
          siteId: saved.siteId,
          currentQuantityKg: saved.quantityKg,
          reorderPointKg: saved.minStockKg,
          status: 'low_stock',
          version: 1,
        };
        await this.eventBus.publish(event);
        this.logger.debug(`Published FeedInventoryLowEvent for inventory ${saved.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish FeedInventoryLowEvent: ${(eventError as Error).message}`);
      }
    }

    return saved;
  }
}
