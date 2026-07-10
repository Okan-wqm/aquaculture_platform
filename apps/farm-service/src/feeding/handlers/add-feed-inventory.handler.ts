/**
 * AddFeedInventoryHandler
 *
 * Records a feed-lot arrival at a site — either creating a fresh
 * `feed_inventory` row or folding the new quantity into an existing
 * row keyed by `(feedId, siteId, lotNumber)`.
 *
 * Atomic boundary:
 *   - feed_inventory insert / update
 *   - `FeedInventoryReceived` outbox enqueue
 * commit together. Lot-traceability (food-safety-critical) depends
 * on every arrival being audit-visible; a DB commit followed by an
 * event-enqueue failure would produce a phantom lot that doesn't
 * appear on any downstream projection.
 *
 * @module Feeding/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  type FeedInventoryReceivedEvent,
} from '@platform/event-contracts';
import { AddFeedInventoryCommand } from '../commands/add-feed-inventory.command';
import { FeedInventory } from '../entities/feed-inventory.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Site } from '../../site/entities/site.entity';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

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
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly financeSettings: FinanceSettingsService,
  ) {}

  async execute(command: AddFeedInventoryCommand): Promise<FeedInventory> {
    const { tenantId, payload, userId } = command;

    // Currency SSoT (FARM-HIGH-151): feed-lot value books under the
    // tenant default currency from finance_settings, never a hardcoded
    // literal.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

    // Feed'i doğrula (pre-transaction read — validation only)
    const feed = await this.feedRepository.findOne({
      where: { id: payload.feedId, tenantId },
    });

    if (!feed) {
      throw new NotFoundException(`Feed ${payload.feedId} bulunamadı`);
    }

    // Site'ı doğrula (pre-transaction read — validation only)
    const site = await this.siteRepository.findOne({
      where: { id: payload.siteId, tenantId },
    });

    if (!site) {
      throw new NotFoundException(`Site ${payload.siteId} bulunamadı`);
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Mevcut inventory var mı kontrol et (aynı lot numarası ile)
      let inventory: FeedInventory | null = null;
      if (payload.lotNumber) {
        inventory = await queryRunner.manager.findOne(FeedInventory, {
          where: {
            tenantId,
            feedId: payload.feedId,
            siteId: payload.siteId,
            lotNumber: payload.lotNumber,
          },
        });
      }

      const isNewLotRow = !inventory;

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
          currency: payload.currency || defaultCurrency,

          storageLocation: payload.storageLocation,
          storageTemperature: payload.storageTemperature,

          notes: payload.notes,
          createdBy: userId,
        });
      }

      inventory.updateStatus();
      const saved = await queryRunner.manager.save(FeedInventory, inventory);

      const event: FeedInventoryReceivedEvent = {
        ...createBaseEvent<FeedInventoryReceivedEvent>('FeedInventoryReceived', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FeedInventory',
        }),
        inventoryId: saved.id,
        feedId: saved.feedId,
        siteId: saved.siteId,
        departmentId: saved.departmentId,
        lotNumber: saved.lotNumber,
        quantityKg: payload.quantityKg,
        newTotalQuantityKg: Number(saved.quantityKg),
        manufacturingDate: toEventIso(saved.manufacturingDate),
        expiryDate: toEventIso(saved.expiryDate),
        receivedDate: toEventIso(saved.receivedDate ?? new Date()),
        unitPricePerKg: payload.unitPricePerKg,
        currency: saved.currency,
        isNewLotRow,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      return saved;
    });
  }
}
