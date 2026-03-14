/**
 * ConsumeFeedInventoryHandler
 *
 * ConsumeFeedInventoryCommand'ı işler ve stoktan tüketim yapar.
 *
 * @module Feeding/Handlers
 */
import { randomUUID } from 'crypto';

import { Injectable, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: ConsumeFeedInventoryCommand): Promise<FeedInventory> {
    const { tenantId, payload, userId } = command;

    // Inventory'yi bul
    const inventory = await this.inventoryRepository.findOne({
      where: { id: payload.inventoryId, tenantId },
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

    // Stoğu azalt
    inventory.quantityKg = currentQuantity - payload.quantityKg;
    inventory.updatedBy = userId;

    // Toplam değeri güncelle
    if (inventory.unitPricePerKg) {
      inventory.totalValue = Number(inventory.unitPricePerKg) * inventory.quantityKg;
    }

    // Durumu güncelle
    inventory.updateStatus();

    // Kaydet
    const saved = await this.inventoryRepository.save(inventory);

    // Publish domain event: FeedInventoryLow (low stock alert)
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
