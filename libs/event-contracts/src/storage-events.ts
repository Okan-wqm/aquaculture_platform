import { BaseEvent } from './base-event';

// ==================== Storage & Inventory Events ====================
// These events enable cross-module integration for the storage bounded context.
// The storage module manages feed, chemical, and consumable inventory across
// multiple physical locations within a multi-tenant aquaculture farm.
//
// Consumers:
//   - notification-service: sends low-stock alerts to farm managers
//   - alert-engine: evaluates threshold rules and triggers automated reorder workflows
//   - feeding module: tracks feed consumption against feeding plans
//   - billing module: computes inventory valuation for cost-of-goods-sold reporting
//   - audit-trail: provides regulatory compliance evidence (EU 178/2002 traceability)

/**
 * Emitted after any stock movement is persisted (IN, OUT, WASTE, ADJUSTMENT, RETURN).
 *
 * This is the primary storage domain event. Every physical or logical change to
 * inventory quantity flows through the stock movement handler, making this event
 * the single integration point for downstream consumers.
 *
 * Subscribers:
 *   - notification-service: triggers real-time dashboard updates
 *   - alert-engine: evaluates post-movement threshold rules
 *   - billing module: updates inventory valuation ledger
 *   - feeding module: correlates feed OUT movements with feeding records
 */
export interface StockMovementRecordedEvent extends BaseEvent {
  /** Literal discriminator for event routing and type narrowing */
  eventType: 'StockMovementRecorded';

  /** UUID of the persisted StockMovement entity — the source of truth */
  movementId: string;

  /** Direction of stock change: in, out, waste, adjustment, return */
  movementType: string;

  /** Category of the item being moved: feed, chemical, consumable */
  itemType: string;

  /** UUID of the specific item (Feed, Chemical, or Consumable entity) */
  itemId: string;

  /** Human-readable item name for display in notifications without re-querying */
  itemName: string;

  /** Absolute quantity moved (always positive; direction is encoded in movementType) */
  quantity: number;

  /** Unit of measure (kg, L, pcs, etc.) for consistent downstream calculations */
  unit: string;

  /** Source location UUID — present for OUT, WASTE, TRANSFER, ADJUSTMENT movements */
  fromLocationId?: string;

  /** Destination location UUID — present for IN, RETURN, TRANSFER, ADJUSTMENT movements */
  toLocationId?: string;

  /**
   * Lot/batch number for regulatory traceability.
   * Required by EU 178/2002 Article 18, BAP certification, and HACCP compliance.
   */
  lotNumber?: string;
}

/**
 * Emitted when a purchase order delivery is received and inventory is updated.
 *
 * This event captures the business-significant moment when ordered goods arrive
 * at a storage location. It differs from a generic IN movement because it carries
 * purchase order context needed for procurement and financial reconciliation.
 *
 * Subscribers:
 *   - billing module: matches delivery to PO for accounts payable processing
 *   - notification-service: alerts procurement team of received goods
 *   - supplier module: updates supplier delivery performance metrics
 */
export interface DeliveryReceivedEvent extends BaseEvent {
  /** Literal discriminator for event routing and type narrowing */
  eventType: 'DeliveryReceived';

  /** UUID of the purchase order that authorized this delivery */
  purchaseOrderId: string;

  /** UUID of the storage location where goods were received */
  locationId: string;

  /** Human-readable location name for notification display */
  locationName: string;

  /** UUID of the supplier who fulfilled the delivery */
  supplierId: string;

  /** Human-readable supplier name for notification display */
  supplierName: string;

  /**
   * Line items received in this delivery.
   * Each entry maps to a PO line item with the actual quantity received,
   * which may differ from the ordered quantity (partial deliveries are common).
   */
  items: Array<{
    /** UUID of the specific item received */
    itemId: string;
    /** Category of the item: feed, chemical, consumable */
    itemType: string;
    /** Human-readable item name */
    itemName: string;
    /** Quantity actually received (may differ from ordered quantity) */
    quantityReceived: number;
    /** Unit of measure */
    unit: string;
    /** Lot number assigned to received goods for traceability */
    lotNumber?: string;
  }>;

  /** ISO date string of when the delivery physically arrived at the location */
  receivedAt: string;

  /** UUID of the user who processed and confirmed the delivery */
  receivedBy: string;
}

/**
 * Current wire version of `LowStockDetected`.
 *
 * WHY: v2 added the stock tier (`level`, `siteId`, `onOrderQuantity`, plan K8).
 * v1 events still in flight are lifted by `lowStockDetectedUpcaster`.
 * WHAT: producers pass this to `createBaseEvent(..., { version })`.
 */
export const LOW_STOCK_DETECTED_VERSION = 2;

/**
 * Stock categories a `LowStockDetected` names — the storage ledger's
 * `item_type` vocabulary (the wire schema enforces the same closed set).
 */
export type LowStockItemType = 'feed' | 'chemical' | 'consumable' | 'healthcare' | 'spare_part';

/**
 * Fields every `LowStockDetected` tier carries.
 *
 * The event is EDGE-triggered: the farm ledger emits it only when a movement
 * makes a tier cross into a worse stock band (ok → low → out), never on every
 * movement that leaves stock already low.
 */
interface LowStockDetectedFields extends BaseEvent {
  /** Literal discriminator for event routing and type narrowing */
  eventType: 'LowStockDetected';

  /** Storage item category (closed set, see `LowStockItemType`). */
  itemType: LowStockItemType;

  /** UUID of the specific item that is running low */
  itemId: string;

  /** Human-readable item name for alert messages */
  itemName: string;

  /**
   * Physical on-hand quantity of the tier, read from the storage ledger:
   * the site's locations for `level: 'site'`, every location of the tenant
   * for `level: 'pool'`. Never the denormalized catalog quantity.
   */
  currentQuantity: number;

  /** Unit of measure for display in alerts */
  unit: string;

  /**
   * The threshold the tier was compared against: the site policy's minStock
   * for `level: 'site'`, the catalog reorder threshold for `level: 'pool'`.
   * Absent when the tier has no positive threshold and the event reports a
   * physical stock-out only.
   */
  minimumThreshold?: number;

  /**
   * Severity classification for alert prioritization:
   * - 'low_stock': the compared quantity is at or below the threshold, on-hand above zero
   * - 'out_of_stock': physical on-hand has reached zero — immediate action required
   */
  severity: 'low_stock' | 'out_of_stock';
}

/**
 * Tier 1 (distribution): one site fell below its `storage_item_site_policies`
 * minimum. The action is a transfer or a site purchase at THAT site.
 */
export interface SiteLowStockDetectedEvent extends LowStockDetectedFields {
  level: 'site';
  /** Site whose locations were summed. */
  siteId: string;
  /** Pool-only field: a site event never carries it (the compiler rejects it). */
  onOrderQuantity?: never;
}

/**
 * Tier 2 (procurement): the tenant pool's inventory position
 * (`currentQuantity` + `onOrderQuantity`) fell to the catalog reorder threshold.
 * The action is a purchase for the tenant.
 */
export interface PoolLowStockDetectedEvent extends LowStockDetectedFields {
  level: 'pool';
  siteId?: undefined;
  /**
   * Outstanding quantity on open purchase-order lines (SUBMITTED, APPROVED,
   * ORDERED, PARTIALLY_RECEIVED). `null` only on a v1 event lifted by the
   * upcaster: v1 never measured it, so the value is unknown, not zero.
   */
  onOrderQuantity: number | null;
}

/**
 * Emitted when a stock tier crosses into a worse band (low or out of stock).
 *
 * This is a critical operational event for aquaculture farms where running out
 * of feed or treatment chemicals can cause fish mortality. A discriminated
 * union on `level`: a site event always names its site, a pool event never
 * does, and the compiler rejects any other shape.
 *
 * Subscribers:
 *   - alert-engine: opens a low-stock incident
 *   - gateway-api: live dashboard broadcast
 */
export type LowStockDetectedEvent = SiteLowStockDetectedEvent | PoolLowStockDetectedEvent;

/**
 * Emitted after a successful location-to-location stock transfer.
 *
 * Transfers are a compound operation (decrease at source + increase at destination)
 * executed within a single database transaction. This event is emitted only after
 * the transaction commits, guaranteeing that both sides of the transfer succeeded.
 *
 * Subscribers:
 *   - notification-service: informs location managers of incoming/outgoing stock
 *   - audit-trail: records chain-of-custody for regulatory compliance
 *   - billing module: may trigger inter-site cost allocation
 */
export interface StockTransferCompletedEvent extends BaseEvent {
  /** Literal discriminator for event routing and type narrowing */
  eventType: 'StockTransferCompleted';

  /** UUID of the stock movement record representing this transfer */
  movementId: string;

  /** Category of the item transferred: feed, chemical, consumable */
  itemType: string;

  /** UUID of the specific item transferred */
  itemId: string;

  /** Human-readable item name for notification display */
  itemName: string;

  /** Quantity transferred between locations */
  quantity: number;

  /** Unit of measure */
  unit: string;

  /** UUID of the source storage location */
  fromLocationId: string;

  /** Human-readable name of the source location */
  fromLocationName: string;

  /** UUID of the destination storage location */
  toLocationId: string;

  /** Human-readable name of the destination location */
  toLocationName: string;

  /** Lot number preserved during transfer for traceability */
  lotNumber?: string;
}

// ==================== Type Union ====================

/**
 * Union type for all storage domain events.
 * Used by generic event handlers, middleware, and the platform-wide AnyPlatformEvent union.
 */
export type StorageEvent =
  | StockMovementRecordedEvent
  | DeliveryReceivedEvent
  | LowStockDetectedEvent
  | StockTransferCompletedEvent;
