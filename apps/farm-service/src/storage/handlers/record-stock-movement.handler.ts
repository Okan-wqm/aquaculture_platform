import { randomUUID } from 'crypto';

import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, Logger, BadRequestException, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import type { StockMovementRecordedEvent, LowStockDetectedEvent } from '@platform/event-contracts';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { ConditionWarning } from '../dto/stock-movement.response';

@CommandHandler(RecordStockMovementCommand)
export class RecordStockMovementHandler implements ICommandHandler<RecordStockMovementCommand, StockMovement> {
  private readonly logger = new Logger(RecordStockMovementHandler.name);

  constructor(
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
    @InjectRepository(StorageInventory)
    private readonly inventoryRepository: Repository<StorageInventory>,
    @InjectRepository(StockMovement)
    private readonly movementRepository: Repository<StockMovement>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
    private readonly dataSource: DataSource,
    // EVENT_BUS is provided globally by EventBusModule (@Global).
    // @Optional() ensures the handler still works in test environments
    // or when NATS is unavailable — event emission is best-effort, not mandatory.
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: RecordStockMovementCommand): Promise<StockMovement & { warnings?: ConditionWarning[] }> {
    const { input, tenantId, userId } = command;
    const { movementType, itemType, itemId, quantity } = input;

    this.logger.log(`Recording ${movementType} movement for ${itemType} ${itemId}`);

    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }

    // Idempotency guard: if a movement with this key already exists, return it
    // immediately without creating a duplicate. This handles network retries and
    // double-click submissions gracefully — the client receives the same response
    // regardless of how many times the request is sent.
    if (input.idempotencyKey) {
      const existing = await this.movementRepository.findOne({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        this.logger.log(`Idempotent hit: movement ${existing.id} for key ${input.idempotencyKey}`);
        return existing;
      }
    }

    // Get item details
    const itemDetails = await this.getItemDetails(itemType as StorageItemType, itemId, tenantId);
    if (!itemDetails) {
      throw new NotFoundException(`${itemType} with ID "${itemId}" not found`);
    }

    // Validate locations based on movement type
    let fromLocation: StorageLocation | null = null;
    let toLocation: StorageLocation | null = null;

    if (movementType === MovementType.IN || movementType === MovementType.RETURN) {
      if (!input.toLocationId) {
        throw new BadRequestException(`toLocationId is required for ${movementType} movements`);
      }
      toLocation = await this.locationRepository.findOne({
        where: { id: input.toLocationId, tenantId },
      });
      if (!toLocation) {
        throw new NotFoundException(`Storage location "${input.toLocationId}" not found`);
      }
    }

    if (movementType === MovementType.OUT || movementType === MovementType.WASTE) {
      if (!input.fromLocationId) {
        throw new BadRequestException(`fromLocationId is required for ${movementType} movements`);
      }
      fromLocation = await this.locationRepository.findOne({
        where: { id: input.fromLocationId, tenantId },
      });
      if (!fromLocation) {
        throw new NotFoundException(`Storage location "${input.fromLocationId}" not found`);
      }
    }

    if (movementType === MovementType.ADJUSTMENT) {
      if (!input.toLocationId && !input.fromLocationId) {
        throw new BadRequestException('Either fromLocationId or toLocationId is required for adjustments');
      }
      if (input.toLocationId) {
        toLocation = await this.locationRepository.findOne({
          where: { id: input.toLocationId, tenantId },
        });
      }
      if (input.fromLocationId) {
        fromLocation = await this.locationRepository.findOne({
          where: { id: input.fromLocationId, tenantId },
        });
      }
    }

    // Check condition warnings for IN movements
    const warnings: ConditionWarning[] = [];
    if (toLocation && (movementType === MovementType.IN || movementType === MovementType.RETURN)) {
      this.checkConditionWarnings(itemDetails, toLocation, warnings);
    }

    // Execute in transaction
    return this.dataSource.transaction(async (manager) => {
      const inventoryRepo = manager.getRepository(StorageInventory);
      const movementRepo = manager.getRepository(StockMovement);

      // Update inventory based on movement type
      if (fromLocation) {
        await this.decreaseInventory(
          inventoryRepo, tenantId, fromLocation.id,
          itemType as StorageItemType, itemId, quantity, itemDetails.unit,
          input.lotNumber, userId,
        );
      }

      if (toLocation) {
        await this.increaseInventory(
          inventoryRepo, tenantId, toLocation.id,
          itemType as StorageItemType, itemId, quantity, itemDetails.unit,
          input.lotNumber, input.expiryDate, userId,
        );
      }

      // Update item total quantity
      await this.updateItemTotalQuantity(manager, itemType as StorageItemType, itemId, tenantId);

      // Create movement record
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
        // Capture lot and expiry on the movement record for full audit trail.
        // This enables lot traceability queries: "Which lots were consumed from
        // location X between dates Y and Z?" — required for EU 178/2002.
        lotNumber: input.lotNumber,
        expiryDate: input.expiryDate,
        // Idempotency key for at-most-once delivery guarantee on retries.
        idempotencyKey: input.idempotencyKey,
        performedBy: userId,
        performedAt: new Date(),
      });

      const saved = await movementRepo.save(movement);

      // --- Domain Event: StockMovementRecorded ---
      // Emit domain event for cross-module integration after the movement is
      // persisted within the transaction. Every stock change (IN, OUT, WASTE,
      // ADJUSTMENT, RETURN) produces this event so that downstream consumers
      // have a single, unified integration point.
      //
      // Consumers:
      //   - notification-service: real-time dashboard updates and push notifications
      //   - alert-engine: evaluates threshold rules for automated reorder workflows
      //   - feeding module: correlates feed OUT movements with feeding records
      //   - billing module: updates inventory valuation ledger for COGS reporting
      if (this.eventBus) {
        try {
          const movementEvent: StockMovementRecordedEvent = {
            eventId: randomUUID(),
            eventType: 'StockMovementRecorded',
            timestamp: new Date(),
            tenantId,
            version: 1,
            userId,
            movementId: saved.id,
            movementType: saved.movementType,
            itemType: saved.itemType,
            itemId: saved.itemId,
            itemName: saved.itemName,
            quantity: saved.quantity,
            unit: saved.unit,
            fromLocationId: saved.fromLocationId,
            toLocationId: saved.toLocationId,
            lotNumber: saved.lotNumber,
          };
          await this.eventBus.publish(movementEvent);
          this.logger.debug(`Published StockMovementRecordedEvent for movement ${saved.id}`);
        } catch (eventError) {
          // Event emission failure must NOT roll back the stock movement.
          // The movement record is the source of truth; events are best-effort delivery.
          // Failed events will be retried by NATS JetStream's built-in retry mechanism
          // or caught by the dead-letter queue (DLQ) for manual reprocessing.
          this.logger.warn(
            `Failed to emit StockMovementRecorded event for movement ${saved.id}: ${(eventError as Error).message}`,
          );
        }
      }

      // --- Domain Event: LowStockDetected ---
      // After stock-reducing movements (OUT, WASTE), check whether the item's
      // total quantity has dropped below the minimum threshold or reached zero.
      // This enables proactive alerting before stock-out situations, which is
      // critical in aquaculture: running out of feed causes fish starvation,
      // and running out of treatment chemicals prevents disease response.
      if (this.eventBus && fromLocation && (movementType === MovementType.OUT || movementType === MovementType.WASTE)) {
        try {
          // Query the current aggregate quantity across all locations.
          // The updateItemTotalQuantity call above already updated the item entity,
          // but we need the raw number here for the event payload.
          const stockResult = await manager.getRepository(StorageInventory)
            .createQueryBuilder('inv')
            .select('COALESCE(SUM(inv.quantity), 0)', 'total')
            .where('inv.itemType = :itemType', { itemType })
            .andWhere('inv.itemId = :itemId', { itemId })
            .andWhere('inv.tenantId = :tenantId', { tenantId })
            .getRawOne();
          const currentTotal = parseFloat(stockResult?.total || '0');

          // Determine severity: zero stock is an emergency; below-threshold is a warning.
          let severity: 'low_stock' | 'out_of_stock' | null = null;
          let minimumThreshold: number | undefined;

          if (currentTotal <= 0) {
            severity = 'out_of_stock';
          } else {
            // Look up the item's configured minimum stock threshold.
            // Only Feed entities have an explicit minStock field today;
            // Chemical and Consumable use updateStockStatus() which sets
            // the status string. We check the Feed case explicitly.
            if (itemType === StorageItemType.FEED) {
              const feed = await manager.getRepository(Feed).findOne({ where: { id: itemId, tenantId } });
              if (feed && feed.minStock > 0 && currentTotal <= Number(feed.minStock)) {
                severity = 'low_stock';
                minimumThreshold = Number(feed.minStock);
              }
            }
          }

          if (severity) {
            const lowStockEvent: LowStockDetectedEvent = {
              eventId: randomUUID(),
              eventType: 'LowStockDetected',
              timestamp: new Date(),
              tenantId,
              version: 1,
              itemType,
              itemId,
              itemName: saved.itemName,
              currentQuantity: currentTotal,
              unit: saved.unit,
              minimumThreshold,
              severity,
            };
            await this.eventBus.publish(lowStockEvent);
            this.logger.debug(
              `Published LowStockDetectedEvent for ${itemType} ${itemId}: ${severity} (current: ${currentTotal})`,
            );
          }
        } catch (lowStockError) {
          // Low-stock event emission is best-effort. A failure here must not
          // affect the stock movement transaction or its response to the client.
          this.logger.warn(`Failed to check/emit low stock event: ${(lowStockError as Error).message}`);
        }
      }

      // Return with warnings
      return Object.assign(saved, { warnings: warnings.length > 0 ? warnings : undefined });
    });
  }

  private async getItemDetails(
    itemType: StorageItemType, itemId: string, tenantId: string,
  ): Promise<{ name: string; unit: string; storageTempMin?: number; storageTempMax?: number; storageHumidityMin?: number; storageHumidityMax?: number } | null> {
    switch (itemType) {
      case StorageItemType.FEED: {
        const feed = await this.feedRepository.findOne({ where: { id: itemId, tenantId } });
        return feed ? { name: feed.name, unit: feed.unit, storageTempMin: feed.storageTempMin, storageTempMax: feed.storageTempMax, storageHumidityMin: feed.storageHumidityMin, storageHumidityMax: feed.storageHumidityMax } : null;
      }
      case StorageItemType.CHEMICAL: {
        const chem = await this.chemicalRepository.findOne({ where: { id: itemId, tenantId } });
        return chem ? { name: chem.name, unit: chem.unit, storageTempMin: (chem as any).storageTempMin, storageTempMax: (chem as any).storageTempMax, storageHumidityMin: (chem as any).storageHumidityMin, storageHumidityMax: (chem as any).storageHumidityMax } : null;
      }
      case StorageItemType.CONSUMABLE: {
        const cons = await this.consumableRepository.findOne({ where: { id: itemId, tenantId } });
        return cons ? { name: cons.name, unit: cons.unit, storageTempMin: cons.storageTempMin, storageTempMax: cons.storageTempMax, storageHumidityMin: cons.storageHumidityMin, storageHumidityMax: cons.storageHumidityMax } : null;
      }
      case StorageItemType.HEALTHCARE: {
        // Healthcare products (fish medications, vaccines, treatments) are stored
        // in the consumables table with healthcare-specific categories. This unified
        // entity approach avoids a separate healthcare table while maintaining the
        // distinct StorageItemType for UI filtering and regulatory reporting.
        const healthcare = await this.consumableRepository.findOne({
          where: { id: itemId, tenantId },
        });
        return healthcare
          ? {
              name: healthcare.name,
              unit: healthcare.unit,
              storageTempMin: healthcare.storageTempMin,
              storageTempMax: healthcare.storageTempMax,
              storageHumidityMin: healthcare.storageHumidityMin,
              storageHumidityMax: healthcare.storageHumidityMax,
            }
          : null;
      }
      default:
        return null;
    }
  }

  private checkConditionWarnings(
    item: { storageTempMin?: number; storageTempMax?: number; storageHumidityMin?: number; storageHumidityMax?: number },
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

  private async decreaseInventory(
    repo: Repository<StorageInventory>,
    tenantId: string, locationId: string,
    itemType: StorageItemType, itemId: string,
    quantity: number, unit: string,
    lotNumber: string | undefined, userId: string,
  ): Promise<void> {
    // FEFO (First Expired First Out) picking strategy for aquaculture compliance.
    // When no specific lot is requested, we consume from the earliest-expiring
    // inventory first. This is critical for:
    // - Feed: prevents fish from receiving expired feed (health risk)
    // - Chemicals: prevents using expired water treatment chemicals (efficacy loss)
    // - Healthcare: prevents administering expired medications (regulatory violation)
    //
    // Enterprise pattern: SAP uses "shelf life expiration date" (SLED) with
    // configurable picking strategy per storage type. We default to FEFO as it
    // is the industry standard for perishable goods in aquaculture.
    let inventory: StorageInventory | null;

    if (lotNumber) {
      // Exact lot specified — pick from that specific lot
      inventory = await repo.findOne({
        where: {
          tenantId,
          storageLocationId: locationId,
          itemType,
          itemId,
          lotNumber,
        },
        // Pessimistic write lock prevents concurrent transactions from reading
        // the same balance and both decrementing — which would result in negative
        // inventory. This is the standard enterprise pattern (SAP uses "enqueue"
        // locking, PostgreSQL uses SELECT ... FOR UPDATE under the hood).
        lock: { mode: 'pessimistic_write' },
      });
    } else {
      // No lot specified — FEFO: pick from earliest expiry date first.
      // Items with NULL expiry date are picked last (NULLS LAST) because
      // they are assumed to have no expiry concern (e.g., non-perishable consumables).
      inventory = await repo
        .createQueryBuilder('inv')
        .where('inv.tenantId = :tenantId', { tenantId })
        .andWhere('inv.storageLocationId = :locationId', { locationId })
        .andWhere('inv.itemType = :itemType', { itemType })
        .andWhere('inv.itemId = :itemId', { itemId })
        .andWhere('inv.quantity > 0')
        .orderBy('inv.expiryDate', 'ASC', 'NULLS LAST')
        .setLock('pessimistic_write')
        .getOne();
    }

    if (!inventory) {
      throw new BadRequestException(`No inventory found for this item in the specified location`);
    }

    if (Number(inventory.quantity) < quantity) {
      throw new BadRequestException(
        `Insufficient stock. Available: ${inventory.quantity} ${unit}, Requested: ${quantity} ${unit}`
      );
    }

    inventory.quantity = Number(inventory.quantity) - quantity;
    inventory.updatedBy = userId;

    if (inventory.quantity <= 0) {
      await repo.remove(inventory);
    } else {
      await repo.save(inventory);
    }
  }

  private async increaseInventory(
    repo: Repository<StorageInventory>,
    tenantId: string, locationId: string,
    itemType: StorageItemType, itemId: string,
    quantity: number, unit: string,
    lotNumber: string | undefined, expiryDate: Date | undefined,
    userId: string,
  ): Promise<void> {
    let inventory = await repo.findOne({
      where: {
        tenantId,
        storageLocationId: locationId,
        itemType,
        itemId,
        lotNumber: lotNumber ?? undefined,
      },
    });

    if (inventory) {
      inventory.quantity = Number(inventory.quantity) + quantity;
      inventory.updatedBy = userId;
      if (expiryDate) inventory.expiryDate = expiryDate;
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
        createdBy: userId,
        updatedBy: userId,
      });
      await repo.save(inventory);
    }
  }

  private async updateItemTotalQuantity(
    manager: any,
    itemType: StorageItemType, itemId: string, tenantId: string,
  ): Promise<void> {
    // Sum all inventory for this item
    const result = await manager.getRepository(StorageInventory)
      .createQueryBuilder('inv')
      .select('COALESCE(SUM(inv.quantity), 0)', 'total')
      .where('inv.itemType = :itemType', { itemType })
      .andWhere('inv.itemId = :itemId', { itemId })
      .andWhere('inv.tenantId = :tenantId', { tenantId })
      .getRawOne();

    const totalQuantity = parseFloat(result?.total || '0');

    switch (itemType) {
      case StorageItemType.FEED: {
        const feed = await manager.getRepository(Feed).findOne({ where: { id: itemId, tenantId } });
        if (feed) {
          feed.quantity = totalQuantity;
          if (totalQuantity <= 0) feed.status = 'out_of_stock';
          else if (totalQuantity <= Number(feed.minStock)) feed.status = 'low_stock';
          else feed.status = 'available';
          await manager.getRepository(Feed).save(feed);
        }
        break;
      }
      case StorageItemType.CHEMICAL: {
        const chem = await manager.getRepository(Chemical).findOne({ where: { id: itemId, tenantId } });
        if (chem) {
          chem.quantity = totalQuantity;
          chem.updateStockStatus();
          await manager.getRepository(Chemical).save(chem);
        }
        break;
      }
      case StorageItemType.CONSUMABLE: {
        const cons = await manager.getRepository(Consumable).findOne({ where: { id: itemId, tenantId } });
        if (cons) {
          cons.quantity = totalQuantity;
          cons.updateStockStatus();
          await manager.getRepository(Consumable).save(cons);
        }
        break;
      }
      case StorageItemType.HEALTHCARE: {
        // Healthcare products share the consumable entity table. Updating the
        // total quantity and stock status ensures the consumable record reflects
        // the aggregate across all storage locations, just like feeds and chemicals.
        const healthcare = await manager.getRepository(Consumable).findOne({
          where: { id: itemId, tenantId },
        });
        if (healthcare) {
          healthcare.quantity = totalQuantity;
          healthcare.updateStockStatus();
          await manager.getRepository(Consumable).save(healthcare);
        }
        break;
      }
    }
  }
}
