import { randomUUID } from 'crypto';

import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { NotFoundException, Logger, BadRequestException, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { tenantManagerRepo, TenantScopedRepository } from '@aquaculture/backend-common';
import type { StockMovementRecordedEvent, LowStockDetectedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed, FeedStatus } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { ConditionWarning } from '../dto/stock-movement.response';
import { LotMixService } from '../services/lot-mix.service';

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
    private readonly lotMixService: LotMixService,
    // EVENT_BUS is provided globally by EventBusModule (@Global).
    // @Optional() ensures the handler still works in test environments
    // or when NATS is unavailable — event emission is best-effort, not mandatory.
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: RecordStockMovementCommand): Promise<StockMovement & { warnings?: ConditionWarning[] }> {
    const { input, tenantId, userId, userName } = command;
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

    // Execute inventory mutations and movement creation in a single transaction.
    // Domain events are emitted AFTER the transaction commits (not inside it)
    // to prevent phantom events if the transaction rolls back. This follows the
    // Outbox Pattern principle: only publish events for data that is confirmed
    // persisted. NATS JetStream handles retry/DLQ for delivery failures.
    const { saved, currentTotal } = await this.dataSource.transaction(async (manager) => {
      const inventoryRepo = tenantManagerRepo(manager, StorageInventory, tenantId);
      const movementRepo = tenantManagerRepo(manager, StockMovement, tenantId);

      // Update inventory based on movement type.
      // asOfDate carries the operational event timestamp so FEFO picks
      // from lots that were ALREADY in inventory at that instant — a
      // retroactively-logged feeding event cannot deduct from a lot
      // that arrived after the event occurred. `movementDate` on the
      // input is the authoritative event moment (default: now) for
      // manual movements; for event-driven flows the caller sets
      // `input.movementDate` to the domain event's occurredAt.
      const asOfDate =
        input.movementDate instanceof Date
          ? input.movementDate
          : input.movementDate
            ? new Date(input.movementDate)
            : undefined;

      if (fromLocation) {
        await this.decreaseInventory(
          inventoryRepo, tenantId, fromLocation.id,
          itemType as StorageItemType, itemId, quantity, itemDetails.unit,
          input.lotNumber, userId, asOfDate,
        );
      }

      // Lot-mix detection — must run BEFORE increaseInventory so the
      // service sees the resident lots as "other" and not yet summed
      // with the incoming quantity. The detector no-ops when the
      // incoming lot is the first lot in the location. When it does
      // fire, the returned `effectiveLotNumber` is stamped on the
      // movement record below so downstream trace queries surface the
      // composite identifier from the moment the mix occurred.
      let effectiveLotNumber: string | null = null;
      if (toLocation && input.lotNumber) {
        const mixOutcome = await this.lotMixService.detect({
          tenantId,
          storageLocationId: toLocation.id,
          itemType: itemType as StorageItemType,
          itemId,
          incomingLotNumber: input.lotNumber,
          incomingQuantityKg: quantity,
          manufacturer: itemDetails.manufacturer ?? null,
          incomingExpiryDate: input.expiryDate ?? null,
          userId,
          manager,
        });
        effectiveLotNumber = mixOutcome.effectiveLotNumber;
      }

      if (toLocation) {
        await this.increaseInventory(
          inventoryRepo, tenantId, toLocation.id,
          itemType as StorageItemType, itemId, quantity, itemDetails.unit,
          input.lotNumber, input.expiryDate, userId,
        );
      }

      // Update item total quantity and sync stock status back to source entity
      await this.updateItemTotalQuantity(manager, itemType as StorageItemType, itemId, tenantId);

      // Create immutable movement record (audit trail)
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
        // When a lot mix was detected the effectiveLotNumber (composite
        // "MIX-<lot1>-<lot2>-..." identifier) is recorded on the movement
        // so the ledger reflects the physical reality of the mixed container.
        lotNumber: effectiveLotNumber ?? input.lotNumber,
        expiryDate: input.expiryDate,
        // Idempotency key for at-most-once delivery guarantee on retries.
        idempotencyKey: input.idempotencyKey,
        performedBy: userId,
        performedByName: userName,
        performedAt: new Date(),
      });

      const txSaved = await movementRepo.save(movement);

      // Query aggregate quantity for low-stock detection (inside transaction
      // to read the post-update state before commit).
      let txCurrentTotal = 0;
      if (fromLocation && (movementType === MovementType.OUT || movementType === MovementType.WASTE)) {
        const stockResult = await tenantManagerRepo(manager, StorageInventory, tenantId)
          .createQueryBuilder('inv')
          .select('COALESCE(SUM(inv.quantity), 0)', 'total')
          .where('inv.itemType = :itemType', { itemType })
          .andWhere('inv.itemId = :itemId', { itemId })
          .getRawOne();
        txCurrentTotal = parseFloat(stockResult?.total || '0');
      }

      return { saved: txSaved, currentTotal: txCurrentTotal };
    });

    // --- Domain Events (emitted AFTER transaction commit) ---
    // Events are published outside the transaction to guarantee that only
    // committed data triggers downstream consumers. If the transaction had
    // rolled back, no events would be sent — preventing phantom notifications.
    if (this.eventBus) {
      // StockMovementRecorded: universal event for every stock change
      try {
        const movementEvent: StockMovementRecordedEvent = {
          ...createBaseEvent<StockMovementRecordedEvent>('StockMovementRecorded', tenantId),
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
        // Best-effort delivery: the movement record is the source of truth.
        // NATS JetStream handles retry; DLQ captures persistent failures.
        this.logger.warn(
          `Failed to emit StockMovementRecorded event for movement ${saved.id}: ${(eventError as Error).message}`,
        );
      }

      // LowStockDetected: proactive alerting for stock-reducing movements
      if (fromLocation && (movementType === MovementType.OUT || movementType === MovementType.WASTE)) {
        try {
          let severity: 'low_stock' | 'out_of_stock' | null = null;
          let minimumThreshold: number | undefined;

          if (currentTotal <= 0) {
            severity = 'out_of_stock';
          } else if (itemType === StorageItemType.FEED) {
            // Feed entities have an explicit minStock field for threshold comparison
            const feed = await this.feedRepository.findOne({ where: { id: itemId, tenantId } });
            if (feed && feed.minStock > 0 && currentTotal <= Number(feed.minStock)) {
              severity = 'low_stock';
              minimumThreshold = Number(feed.minStock);
            }
          }

          if (severity) {
            const lowStockEvent: LowStockDetectedEvent = {
              ...createBaseEvent<LowStockDetectedEvent>('LowStockDetected', tenantId),
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
          this.logger.warn(`Failed to check/emit low stock event: ${(lowStockError as Error).message}`);
        }
      }
    }

    // Return with condition warnings (temperature/humidity mismatches)
    return Object.assign(saved, { warnings: warnings.length > 0 ? warnings : undefined });
  }

  private async getItemDetails(
    itemType: StorageItemType, itemId: string, tenantId: string,
  ): Promise<{ name: string; unit: string; manufacturer?: string; storageTempMin?: number; storageTempMax?: number; storageHumidityMin?: number; storageHumidityMax?: number } | null> {
    switch (itemType) {
      case StorageItemType.FEED: {
        const feed = await this.feedRepository.findOne({ where: { id: itemId, tenantId } });
        return feed ? { name: feed.name, unit: feed.unit, manufacturer: feed.manufacturer, storageTempMin: feed.storageTempMin, storageTempMax: feed.storageTempMax, storageHumidityMin: feed.storageHumidityMin, storageHumidityMax: feed.storageHumidityMax } : null;
      }
      case StorageItemType.CHEMICAL: {
        const chem = await this.chemicalRepository.findOne({ where: { id: itemId, tenantId } });
        // Chemical entity has storage condition fields added by migration 1771000000000.
        // Previously used (chem as any) casts which are unnecessary — the entity is properly typed.
        return chem
          ? {
              name: chem.name,
              unit: chem.unit,
              storageTempMin: chem.storageTempMin,
              storageTempMax: chem.storageTempMax,
              storageHumidityMin: chem.storageHumidityMin,
              storageHumidityMax: chem.storageHumidityMax,
            }
          : null;
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
    repo: TenantScopedRepository<StorageInventory>,
    tenantId: string, locationId: string,
    itemType: StorageItemType, itemId: string,
    quantity: number, unit: string,
    lotNumber: string | undefined, userId: string,
    asOfDate?: Date,
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
      // No lot specified — FEFO (First-Expiring-First-Out) with three
      // compliance-driven guarantees that earlier single-column ordering
      // did not provide:
      //
      //   1. Deterministic tiebreak. Two lots with the exact same
      //      expiryDate (common when a bulk receipt gets split into
      //      parallel bin positions) used to produce implementation-
      //      defined ordering. Now the chain is
      //        expiryDate ASC NULLS LAST, receivedDate ASC, lotNumber ASC
      //      so the oldest received lot wins, and if receivedDate also
      //      matches, lot_number lexicographic wins. Two runs against
      //      the same table see identical picks.
      //
      //   2. Expired-lot exclusion. A lot whose expiryDate is in
      //      the past MUST NOT be picked. Consuming expired feed is a
      //      fish-health risk; consuming expired medicine is a legal
      //      violation. NULL expiryDate is acceptable (non-perishable
      //      consumables).
      //
      //   3. As-of scoping (backdating safety). `asOfDate` scopes the
      //      query to lots received ON OR BEFORE the operational event
      //      date. Feeding events logged retroactively therefore cannot
      //      deduct from a lot that arrived after the event occurred.
      //      Defaults to "now" for real-time movements.
      const effectiveAsOf = asOfDate ?? new Date();
      inventory = await repo
        .createQueryBuilder('inv')
        .where('inv.tenantId = :tenantId', { tenantId })
        .andWhere('inv.storageLocationId = :locationId', { locationId })
        .andWhere('inv.itemType = :itemType', { itemType })
        .andWhere('inv.itemId = :itemId', { itemId })
        .andWhere('inv.quantity > 0')
        .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :today)', {
          today: new Date(),
        })
        .andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', {
          asOf: effectiveAsOf,
        })
        .orderBy('inv.expiryDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.receivedDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.lotNumber', 'ASC')
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
    repo: TenantScopedRepository<StorageInventory>,
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
      // Do NOT refresh `receivedDate` on restock — the original
      // arrival date is the FEFO tiebreaker and must stay stable
      // across top-ups of the same lot.
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
        // Stamp `receivedDate` on the initial insert so the FEFO
        // ORDER BY (expiryDate, receivedDate, lotNumber) has a real
        // timestamp to compare. Older rows that predate the
        // 1787100000000 migration get a default from the DB.
        receivedDate: new Date(),
        createdBy: userId,
        updatedBy: userId,
      });
      await repo.save(inventory);
    }
  }

  private async updateItemTotalQuantity(
    manager: EntityManager,
    itemType: StorageItemType, itemId: string, tenantId: string,
  ): Promise<void> {
    // Sum all inventory for this item
    const result = await tenantManagerRepo(manager, StorageInventory, tenantId)
      .createQueryBuilder('inv')
      .select('COALESCE(SUM(inv.quantity), 0)', 'total')
      .where('inv.itemType = :itemType', { itemType })
      .andWhere('inv.itemId = :itemId', { itemId })
      .getRawOne();

    const totalQuantity = parseFloat(result?.total || '0');

    switch (itemType) {
      case StorageItemType.FEED: {
        const feedRepo = tenantManagerRepo(manager, Feed, tenantId);
        const feed = await feedRepo.findOne({ where: { id: itemId, tenantId } });
        if (feed) {
          feed.quantity = totalQuantity;
          // Use the FeedStatus enum to ensure type-safe status assignment.
          // String literals cause TS2322 in production webpack builds (strict mode).
          if (totalQuantity <= 0) feed.status = FeedStatus.OUT_OF_STOCK;
          else if (totalQuantity <= Number(feed.minStock)) feed.status = FeedStatus.LOW_STOCK;
          else feed.status = FeedStatus.AVAILABLE;
          await feedRepo.save(feed);
        }
        break;
      }
      case StorageItemType.CHEMICAL: {
        const chemRepo = tenantManagerRepo(manager, Chemical, tenantId);
        const chem = await chemRepo.findOne({ where: { id: itemId, tenantId } });
        if (chem) {
          chem.quantity = totalQuantity;
          chem.updateStockStatus();
          await chemRepo.save(chem);
        }
        break;
      }
      case StorageItemType.CONSUMABLE: {
        const consRepo = tenantManagerRepo(manager, Consumable, tenantId);
        const cons = await consRepo.findOne({ where: { id: itemId, tenantId } });
        if (cons) {
          cons.quantity = totalQuantity;
          cons.updateStockStatus();
          await consRepo.save(cons);
        }
        break;
      }
      case StorageItemType.HEALTHCARE: {
        // Healthcare products share the consumable entity table. Updating the
        // total quantity and stock status ensures the consumable record reflects
        // the aggregate across all storage locations, just like feeds and chemicals.
        const healthcareRepo = tenantManagerRepo(manager, Consumable, tenantId);
        const healthcare = await healthcareRepo.findOne({
          where: { id: itemId, tenantId },
        });
        if (healthcare) {
          healthcare.quantity = totalQuantity;
          healthcare.updateStockStatus();
          await healthcareRepo.save(healthcare);
        }
        break;
      }
    }
  }
}
