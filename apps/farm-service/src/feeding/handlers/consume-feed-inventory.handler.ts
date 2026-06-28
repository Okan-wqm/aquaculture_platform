/**
 * ConsumeFeedInventoryHandler
 *
 * Records a withdrawal from a feed lot — feeding event, spillage,
 * write-off, etc. Pessimistic-write lock on the inventory row
 * prevents TOCTOU double-spend on the `quantityKg` decrement.
 *
 * # Two events, one transaction
 *
 * Every consumption ALWAYS enqueues a `FeedInventoryConsumed` event
 * — this is the food-safety-traceability anchor that lets auditors
 * follow every gram out of the lot. When the post-op stock lands
 * in the LOW_STOCK band, a second `FeedInventoryLow` event is
 * enqueued alongside it as a derived alert signal.
 *
 * Both events enqueue INSIDE the same transaction as the row
 * decrement via `OutboxPublisher.enqueue(event, queryRunner.manager)`.
 * A prior iteration used a direct NATS publish for the Low event
 * OUTSIDE the tx — that variant loses events if NATS is briefly
 * unavailable. The outbox is the at-least-once guarantee.
 *
 * @module Feeding/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  type FeedInventoryConsumedEvent,
  type FeedInventoryLowEvent,
} from '@platform/event-contracts';
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
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: ConsumeFeedInventoryCommand): Promise<FeedInventory> {
    const { tenantId, payload, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Pessimistic lock on inventory to prevent concurrent double-spend.
      const inventory = await queryRunner.manager.findOne(FeedInventory, {
        where: { id: payload.inventoryId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!inventory) {
        throw new NotFoundException(`Inventory ${payload.inventoryId} bulunamadı`);
      }

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

      // Stoğu azalt (Math.max to prevent negative inventory under any
      // transient arithmetic drift — the explicit check above already
      // rejects over-spend, this is belt-and-braces).
      inventory.quantityKg = Math.max(0, currentQuantity - payload.quantityKg);
      inventory.updatedBy = userId;

      if (inventory.unitPricePerKg) {
        inventory.totalValue = Number(inventory.unitPricePerKg) * inventory.quantityKg;
      }

      inventory.updateStatus();

      const saved = await queryRunner.manager.save(FeedInventory, inventory);

      // Always-fire traceability event.
      const consumedEvent: FeedInventoryConsumedEvent = {
        ...createBaseEvent<FeedInventoryConsumedEvent>('FeedInventoryConsumed', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FeedInventory',
        }),
        inventoryId: saved.id,
        feedId: saved.feedId,
        siteId: saved.siteId,
        reason: payload.reason,
        quantityKg: payload.quantityKg,
        newQuantityKg: Number(saved.quantityKg),
        newStatus: saved.status,
        consumedAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(consumedEvent, queryRunner.manager);

      // Derivative alert when the post-op stock drops to the
      // LOW_STOCK band. Same tx so the alert never lands without
      // its underlying consumption (which would leave a dashboard
      // firing an alert nobody can trace to a cause).
      if (saved.status === InventoryStatus.LOW_STOCK) {
        const lowEvent: FeedInventoryLowEvent = {
          ...createBaseEvent<FeedInventoryLowEvent>('FeedInventoryLow', tenantId, {
            aggregateId: saved.id,
            aggregateType: 'FeedInventory',
          }),
          inventoryId: saved.id,
          feedId: saved.feedId,
          siteId: saved.siteId,
          currentQuantityKg: Number(saved.quantityKg),
          reorderPointKg: Number(saved.minStockKg ?? 0),
          status: 'low_stock',
        };
        await this.outboxPublisher.enqueue(lowEvent, queryRunner.manager);
      }

      return saved;
    });
  }
}
