/**
 * Build the durable `LowStockDetected` event for one tier crossing (plan K8).
 *
 * WHY a factory: the discriminated contract (site names its site, pool carries
 * its open-order remainder) is assembled in one place from the evaluator's
 * reading, so the sink cannot mix the two shapes.
 */
import {
  createBaseEvent,
  LOW_STOCK_DETECTED_VERSION,
  type LowStockDetectedEvent,
  type PoolLowStockDetectedEvent,
  type SiteLowStockDetectedEvent,
} from '@platform/event-contracts';
import type { OutboxPublisher } from '@platform/outbox';
import type { EntityManager } from 'typeorm';

import type { LowStockCrossing } from './low-stock.types';

/** Catalog facts the alert text needs. */
export interface LowStockItemLabel {
  name: string;
  unit: string;
}

/**
 * WHY: one event per crossed tier; WHAT: maps the reading onto the v2 contract.
 * `minimumThreshold` is omitted when the pool is not reorder-controlled (the
 * event then reports a physical stock-out only).
 *
 * `causationId` is the record whose change crossed the tier — the stock
 * movement, or the site policy / catalog item / purchase order / site whose
 * command moved a tier without moving stock — and the stock item is the
 * aggregate: one change may emit a site AND a pool event, and a consumer links
 * the pair back to that one cause through these fields.
 */
export function buildLowStockDetectedEvent(
  tenantId: string,
  crossing: LowStockCrossing,
  label: LowStockItemLabel,
  causingMovementId: string,
): LowStockDetectedEvent {
  const { reading, severity } = crossing;
  const envelope = {
    version: LOW_STOCK_DETECTED_VERSION,
    aggregateId: reading.itemId,
    aggregateType: 'StorageItem',
    causationId: causingMovementId,
  };
  const common = {
    itemType: reading.itemType,
    itemId: reading.itemId,
    itemName: label.name,
    currentQuantity: reading.onHand,
    unit: label.unit,
    severity,
  };
  if (reading.level === 'site') {
    const event: SiteLowStockDetectedEvent = {
      ...createBaseEvent<SiteLowStockDetectedEvent>('LowStockDetected', tenantId, envelope),
      ...common,
      level: 'site',
      siteId: reading.siteId,
      minimumThreshold: reading.threshold,
    };
    return event;
  }
  const event: PoolLowStockDetectedEvent = {
    ...createBaseEvent<PoolLowStockDetectedEvent>('LowStockDetected', tenantId, envelope),
    ...common,
    level: 'pool',
    onOrderQuantity: reading.onOrder,
    ...(reading.threshold > 0 ? { minimumThreshold: reading.threshold } : {}),
  };
  return event;
}

/**
 * THE low-stock sink: enqueue one durable `LowStockDetected` per crossed tier
 * on the caller's transactional manager.
 * WHY one function: a stock movement (StockMovementService) and a command that
 * moves a tier without moving stock (StockTierWatch) must emit the identical
 * event through the identical outbox write, so neither can drift into a second
 * shape or a second delivery path.
 * INVARIANT: called inside the transaction that made the change; if violated →
 * an event for a change that rolled back, or a change whose event is lost.
 */
export async function enqueueLowStockCrossings(
  outboxPublisher: OutboxPublisher,
  manager: EntityManager,
  tenantId: string,
  crossings: readonly LowStockCrossing[],
  label: LowStockItemLabel,
  causationId: string,
): Promise<void> {
  for (const crossing of crossings) {
    await outboxPublisher.enqueue(
      buildLowStockDetectedEvent(tenantId, crossing, label, causationId),
      manager,
    );
  }
}
