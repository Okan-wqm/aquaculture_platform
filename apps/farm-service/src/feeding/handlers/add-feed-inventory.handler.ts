/**
 * AddFeedInventoryHandler
 *
 * AddFeedInventoryCommand'ı işler ve yem stoğu ekler.
 *
 * @module Feeding/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { AddFeedInventoryCommand } from '../commands/add-feed-inventory.command';
import { FeedInventory, InventoryStatus } from '../entities/feed-inventory.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Site } from '../../site/entities/site.entity';

@Injectable()
@CommandHandler(AddFeedInventoryCommand)
export class AddFeedInventoryHandler implements ICommandHandler<AddFeedInventoryCommand, FeedInventory> {
  constructor(
    @InjectRepository(FeedInventory)
    private readonly inventoryRepository: Repository<FeedInventory>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async execute(command: AddFeedInventoryCommand): Promise<FeedInventory> {
    const { tenantId, payload, userId } = command;

    // Feed'i doğrula
    const feed = await this.feedRepository.findOne({
      where: { id: payload.feedId, tenantId },
    });

    if (!feed) {
      throw new NotFoundException(`Feed ${payload.feedId} bulunamadı`);
    }

    // Site'ı doğrula
    const site = await this.siteRepository.findOne({
      where: { id: payload.siteId, tenantId },
    });

    if (!site) {
      throw new NotFoundException(`Site ${payload.siteId} bulunamadı`);
    }

    // Mevcut inventory var mı kontrol et (aynı lot numarası ile)
    let inventory: FeedInventory | null = null;

    if (payload.lotNumber) {
      inventory = await this.inventoryRepository.findOne({
        where: {
          tenantId,
          feedId: payload.feedId,
          siteId: payload.siteId,
          lotNumber: payload.lotNumber,
        },
      });
    }

    if (inventory) {
      // Mevcut stoğu güncelle
      inventory.quantityKg = Number(inventory.quantityKg) + payload.quantityKg;
      inventory.updatedBy = userId;
    } else {
      // Yeni stok kaydı oluştur
      const totalValue = payload.unitPricePerKg
        ? payload.unitPricePerKg * payload.quantityKg
        : undefined;

      inventory = this.inventoryRepository.create({
        tenantId,
        feedId: payload.feedId,
        siteId: payload.siteId,
        departmentId: payload.departmentId,

        quantityKg: payload.quantityKg,
        minStockKg: payload.minStockKg || 0,

        lotNumber: payload.lotNumber,
        manufacturingDate: payload.manufacturingDate,
        expiryDate: payload.expiryDate,
        receivedDate: payload.receivedDate || new Date(),

        unitPricePerKg: payload.unitPricePerKg,
        totalValue,
        currency: payload.currency || 'TRY',

        storageLocation: payload.storageLocation,
        storageTemperature: payload.storageTemperature,

        notes: payload.notes,
        createdBy: userId,
      });
    }

    // Durumu güncelle
    inventory.updateStatus();

    // Kaydet
    return this.inventoryRepository.save(inventory);
  }
}
