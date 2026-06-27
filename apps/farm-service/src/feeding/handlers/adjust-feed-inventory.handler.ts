/**
 * AdjustFeedInventoryHandler
 *
 * Manual correction to a feed lot's running quantity — increase,
 * decrease, or set-absolute. Audit-trail critical: every correction
 * must be attributable to an operator, a reason, and a timestamp,
 * and must announce itself on the event bus for the reconciliation
 * / variance-detection consumers downstream.
 *
 * Atomic boundary:
 *   - pessimistic lock on the inventory row (prevents concurrent
 *     adjustment + consumption producing a torn state)
 *   - quantity write
 *   - `FeedInventoryAdjusted` outbox enqueue
 * commit together.
 *
 * @module Feeding/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  type FeedInventoryAdjustedEvent,
} from '@platform/event-contracts';
import { AdjustFeedInventoryCommand, AdjustmentType } from '../commands/adjust-feed-inventory.command';
import { FeedInventory } from '../entities/feed-inventory.entity';

@Injectable()
@CommandHandler(AdjustFeedInventoryCommand)
export class AdjustFeedInventoryHandler implements ICommandHandler<AdjustFeedInventoryCommand, FeedInventory> {
  constructor(
    @InjectRepository(FeedInventory)
    private readonly inventoryRepository: Repository<FeedInventory>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: AdjustFeedInventoryCommand): Promise<FeedInventory> {
    const { tenantId, payload, userId } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const inventory = await queryRunner.manager.findOne(FeedInventory, {
        where: { id: payload.inventoryId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!inventory) {
        throw new NotFoundException(`Inventory ${payload.inventoryId} bulunamadı`);
      }

      const previousQuantity = Number(inventory.quantityKg);
      let newQuantity: number;

      switch (payload.adjustmentType) {
        case AdjustmentType.INCREASE:
          newQuantity = previousQuantity + payload.quantity;
          break;

        case AdjustmentType.DECREASE:
          newQuantity = previousQuantity - payload.quantity;
          if (newQuantity < 0) {
            throw new BadRequestException(
              `Stok negatif olamaz. Mevcut: ${previousQuantity} kg, Azaltma: ${payload.quantity} kg`,
            );
          }
          break;

        case AdjustmentType.SET_QUANTITY:
          if (payload.quantity < 0) {
            throw new BadRequestException('Stok miktarı negatif olamaz');
          }
          newQuantity = payload.quantity;
          break;

        default:
          throw new BadRequestException('Geçersiz düzeltme tipi');
      }

      inventory.quantityKg = newQuantity;
      inventory.updatedBy = userId;

      if (inventory.unitPricePerKg) {
        inventory.totalValue = Number(inventory.unitPricePerKg) * newQuantity;
      }

      const adjustedAt = new Date();
      const adjustmentNote = `[${adjustedAt.toISOString()}] ${payload.adjustmentType}: ${payload.quantity} kg - ${payload.reason}`;
      inventory.notes = inventory.notes
        ? `${inventory.notes}\n${adjustmentNote}`
        : adjustmentNote;

      inventory.updateStatus();

      const saved = await queryRunner.manager.save(FeedInventory, inventory);

      const event: FeedInventoryAdjustedEvent = {
        ...createBaseEvent<FeedInventoryAdjustedEvent>('FeedInventoryAdjusted', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FeedInventory',
        }),
        inventoryId: saved.id,
        feedId: saved.feedId,
        siteId: saved.siteId,
        adjustmentType: payload.adjustmentType,
        adjustmentQuantityKg: payload.quantity,
        previousQuantityKg: previousQuantity,
        newQuantityKg: newQuantity,
        reason: payload.reason,
        notes: payload.notes,
        adjustedAt: toEventIso(adjustedAt),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
