/**
 * FeedingStorageEventHandler
 *
 * Listens to FeedingRecordedEvent events published by the feeding module and
 * automatically creates a stock OUT movement in the storage inventory system.
 *
 * This closes the loop between farm operations and inventory management:
 * when a worker records 50kg of feed used on Tank A, the corresponding feed
 * stock is automatically reduced in storage — no manual OUT movement needed.
 *
 * This is what differentiates aquaculture-specific inventory from generic WMS:
 * - AKVA Group's FiizK: links feeding plans to feed silos
 * - InnovaSea: auto-deducts feed consumption from warehouse stock
 * - Our implementation: event-driven, loosely coupled via NATS
 *
 * IMPORTANT: The feeding module already deducts from FeedInventory (the legacy
 * per-feed stock entity). This handler creates the corresponding StockMovement
 * record in the storage module for full audit trail and location-level tracking.
 * The two mechanisms are complementary:
 * - FeedInventory: quick feed-level stock (used by feeding UI)
 * - StorageInventory + StockMovement: location-level tracking + regulatory audit trail
 *
 * The handler queries storage_inventory to find the correct storage location
 * for the feed item. If multiple locations stock the same feed, it uses
 * FEFO (First Expired First Out) ordering via the existing decreaseInventory logic.
 */
import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { CommandBus } from '@platform/cqrs';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { FeedingRecordedEvent } from '@platform/event-contracts';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { RecordStockMovementInput } from '../dto/record-stock-movement.input';
import { MovementType } from '../entities/stock-movement.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';

// UUID v4 regex for tenant ID validation (security: prevent cross-tenant operations)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class FeedingStorageEventHandler
  implements IEventHandler<FeedingRecordedEvent>, OnModuleInit
{
  private readonly logger = new Logger(FeedingStorageEventHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    @InjectRepository(StorageInventory)
    private readonly inventoryRepository: Repository<StorageInventory>,
    // EVENT_BUS is provided globally by EventBusModule (@Global).
    // @Optional() ensures the handler still works in test environments
    // or when NATS is unavailable — subscription is best-effort.
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — FeedingRecordedEvent subscription skipped. ' +
        'Storage auto-deduction from feeding events will not work.',
      );
      return;
    }

    // WHAT — `subscribeWildcard` builds the 3-segment subject
    // `events.*.FeedingRecorded`, matching the publisher's
    // `events.{tenantId}.FeedingRecorded` for every tenant.
    // WHY explicit wildcard — storage auto-deduction is a cross-tenant
    // platform feature; making the wildcard explicit at the call site
    // matches the ORPHAN-013 contract that publisher and subscriber agree
    // on segment count by construction (Tier-1 "make it impossible").
    await this.eventBus.subscribeWildcard('FeedingRecorded', this);
    this.logger.log('Subscribed to FeedingRecorded events for automatic storage deduction (cross-tenant wildcard)');
  }

  getEventType(): string {
    return 'FeedingRecorded';
  }

  /**
   * Handle FeedingRecordedEvent by creating an OUT stock movement.
   *
   * The handler is deliberately fault-tolerant: if the storage deduction fails
   * (e.g., no inventory found for this feed in any storage location), the feeding
   * record is NOT affected. This is intentional because:
   * 1. Not all feeds are tracked in storage locations (small farms may skip storage setup)
   * 2. Feeding is operationally critical — fish must be fed regardless of inventory state
   * 3. Discrepancies can be reconciled during periodic inventory counts
   */
  async handle(event: FeedingRecordedEvent): Promise<void> {
    // SECURITY: Validate tenantId format to ensure data isolation
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        'FeedingRecordedEvent has invalid or missing tenantId. ' +
        'Skipping to prevent cross-tenant storage deduction.',
      );
      return;
    }

    if (!event.feedId || !event.actualAmountKg || event.actualAmountKg <= 0) {
      this.logger.warn(
        `FeedingRecordedEvent skipped: feedId=${event.feedId}, actualAmountKg=${event.actualAmountKg}. ` +
        'Missing or invalid required fields.',
      );
      return;
    }

    this.logger.log(
      `Processing FeedingRecordedEvent: feed=${event.feedId}, amount=${event.actualAmountKg}kg, ` +
      `batch=${event.batchId}, tenant=${event.tenantId.substring(0, 8)}...`,
    );

    try {
      // Find a storage location that has this feed in inventory.
      // FEFO lot selection for the OUT movement, with the same three
      // compliance guarantees enforced by RecordStockMovementHandler:
      //
      //   1. Deterministic tiebreak (expiryDate, receivedDate, lotNumber)
      //   2. Expired-lot exclusion (picking an expired feed for a
      //      fish-feeding event is a welfare risk)
      //   3. As-of scoping — the event's `occurredAt` scopes the query
      //      to lots that were actually in inventory at the feeding
      //      instant, not lots that arrived afterwards. This is what
      //      makes retroactively-logged feeding events (user enters
      //      yesterday's meal today) pick from the correct lot rather
      //      than a fresher arrival.
      //
      // This query does NOT lock — the RecordStockMovementHandler below
      // applies pessimistic_write inside its own transaction to guard
      // the actual decrement.
      // `feedingDate` is the authoritative operational event date on
      // FeedingRecordedEvent (defined in libs/event-contracts/src/farm-events.ts).
      // When the feeding record was logged retroactively, feedingDate
      // is in the past and lots received after that date must NOT be
      // consumed. Fallback to BaseEvent.timestamp, then to now, so the
      // handler still works for legacy events that might lack the field.
      const asOf = event.feedingDate
        ? new Date(event.feedingDate)
        : event.timestamp
          ? new Date(event.timestamp)
          : new Date();
      const today = new Date();

      const inventory = await this.inventoryRepository
        .createQueryBuilder('inv')
        .where('inv.tenantId = :tenantId', { tenantId: event.tenantId })
        .andWhere('inv.itemType = :itemType', { itemType: StorageItemType.FEED })
        .andWhere('inv.itemId = :itemId', { itemId: event.feedId })
        .andWhere('inv.quantity > 0')
        .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :today)', { today })
        .andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', { asOf })
        .orderBy('inv.expiryDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.receivedDate', 'ASC', 'NULLS LAST')
        .addOrderBy('inv.lotNumber', 'ASC')
        .getOne();

      if (!inventory) {
        // No storage inventory found for this feed. This is acceptable:
        // the farm may not have set up storage locations yet, or the feed
        // was already depleted via manual OUT movements. Log and move on.
        this.logger.debug(
          `No storage inventory found for feed=${event.feedId} in tenant=${event.tenantId.substring(0, 8)}. ` +
          'Skipping automatic storage deduction — feeding record is unaffected.',
        );
        return;
      }

      // Build the stock movement input. We use the RecordStockMovementCommand
      // to go through the same validation and business logic as manual movements.
      // This ensures consistent inventory updates, event publishing, and low-stock
      // detection — no duplication of business rules.
      const movementInput: RecordStockMovementInput = Object.assign(
        new RecordStockMovementInput(),
        {
          movementType: MovementType.OUT,
          itemType: StorageItemType.FEED,
          itemId: event.feedId,
          quantity: event.actualAmountKg,
          fromLocationId: inventory.storageLocationId,
          reference: `FEEDING: ${event.batchId}`,
          reason: `Auto-deducted from feeding record. Batch: ${event.batchId}, Tank: ${event.tankId ?? 'N/A'}`,
          lotNumber: inventory.lotNumber,
          // Idempotency: use the feeding event ID to prevent duplicate deductions
          // in case the event is redelivered (NATS at-least-once semantics).
          idempotencyKey: `feeding-deduct-${event.eventId}`,
          // Carry the event timestamp so the RecordStockMovementHandler's
          // own FEFO query (if it re-scopes for any reason) also uses
          // as-of semantics matching the event instant.
          movementDate: asOf,
        },
      );

      const command = new RecordStockMovementCommand(
        movementInput,
        event.tenantId,
        event.userId ?? 'system',
        'Auto (Feeding)',
      );

      await this.commandBus.execute(command);

      this.logger.log(
        `Storage auto-deduction completed: feed=${event.feedId}, amount=${event.actualAmountKg}kg, ` +
        `from location=${inventory.storageLocationId}, batch=${event.batchId}`,
      );
    } catch (error) {
      // Feeding must NEVER fail due to storage issues. Log the error and move on.
      // The discrepancy will surface during the next inventory count cycle.
      // Common failure reasons:
      // - Insufficient stock in storage (already deducted by another process)
      // - Storage location deleted between query and command execution
      // - Database connectivity issue (transient)
      this.logger.warn(
        `Failed to auto-deduct storage for FeedingRecordedEvent: ${(error as Error).message}. ` +
        `Feed=${event.feedId}, amount=${event.actualAmountKg}kg, batch=${event.batchId}. ` +
        'Feeding record is unaffected — manual stock adjustment may be needed.',
      );
    }
  }
}
