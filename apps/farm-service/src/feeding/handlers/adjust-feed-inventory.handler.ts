/**
 * AdjustFeedInventoryHandler
 *
 * AdjustFeedInventoryCommand'ı işler ve stokta manuel düzeltme yapar.
 *
 * @module Feeding/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { AdjustFeedInventoryCommand, AdjustmentType } from '../commands/adjust-feed-inventory.command';
import { FeedInventory } from '../entities/feed-inventory.entity';

@Injectable()
@CommandHandler(AdjustFeedInventoryCommand)
export class AdjustFeedInventoryHandler implements ICommandHandler<AdjustFeedInventoryCommand, FeedInventory> {
  constructor(
    @InjectRepository(FeedInventory)
    private readonly inventoryRepository: Repository<FeedInventory>,
  ) {}

  async execute(command: AdjustFeedInventoryCommand): Promise<FeedInventory> {
    const { tenantId, payload, userId } = command;

    // Inventory'yi bul
    const inventory = await this.inventoryRepository.findOne({
      where: { id: payload.inventoryId, tenantId },
    });

    if (!inventory) {
      throw new NotFoundException(`Inventory ${payload.inventoryId} bulunamadı`);
    }

    const currentQuantity = Number(inventory.quantityKg);
    let newQuantity: number;

    switch (payload.adjustmentType) {
      case AdjustmentType.INCREASE:
        newQuantity = currentQuantity + payload.quantity;
        break;

      case AdjustmentType.DECREASE:
        newQuantity = currentQuantity - payload.quantity;
        if (newQuantity < 0) {
          throw new BadRequestException(
            `Stok negatif olamaz. Mevcut: ${currentQuantity} kg, Azaltma: ${payload.quantity} kg`,
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

    // Stoğu güncelle
    inventory.quantityKg = newQuantity;
    inventory.updatedBy = userId;

    // Toplam değeri güncelle
    if (inventory.unitPricePerKg) {
      inventory.totalValue = Number(inventory.unitPricePerKg) * newQuantity;
    }

    // Not ekle
    const adjustmentNote = `[${new Date().toISOString()}] ${payload.adjustmentType}: ${payload.quantity} kg - ${payload.reason}`;
    inventory.notes = inventory.notes
      ? `${inventory.notes}\n${adjustmentNote}`
      : adjustmentNote;

    // Durumu güncelle
    inventory.updateStatus();

    // Kaydet
    return this.inventoryRepository.save(inventory);
  }
}
