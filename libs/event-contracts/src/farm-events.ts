import { BaseEvent } from './base-event';

// ====================================================================
// Shared enum codes — single source of truth for backend, frontend,
// NATS payloads, GraphQL schema, and DB columns. SCREAMING_SNAKE_CASE
// matches PostgreSQL enum types and GraphQL Federation conventions.
// ====================================================================

/**
 * Mortality cause codes.
 *
 * Mirror of the PostgreSQL `mortality_reason_enum` and the GraphQL
 * `MortalityReason` enum. Frontend mutation inputs and backend domain
 * events MUST use these exact values — case-sensitive.
 */
export const MORTALITY_REASONS = [
  'DISEASE',
  'WATER_QUALITY',
  'STRESS',
  'HANDLING',
  'TEMPERATURE',
  'OXYGEN',
  'PREDATION',
  'CANNIBALISM',
  'UNKNOWN',
  'OTHER',
] as const;
export type MortalityReasonCode = typeof MORTALITY_REASONS[number];

/**
 * Cull reason codes.
 *
 * Mirror of the PostgreSQL `cull_reason_enum` and the GraphQL
 * `CullReason` enum. Used by `CullRecordedEvent.reason`.
 */
export const CULL_REASONS = [
  'SMALL_SIZE',
  'DEFORMED',
  'SICK',
  'POOR_GROWTH',
  'GRADING',
  'QUALITY',
  'OTHER',
] as const;
export type CullReasonCode = typeof CULL_REASONS[number];

/**
 * Farm Created Event
 */
export interface FarmCreatedEvent extends BaseEvent {
  eventType: 'FarmCreated';
  farmId: string;
  name: string;
  location: { lat: number; lng: number };
  address?: string;
  contactPerson?: string;
}

/**
 * Farm Updated Event
 */
export interface FarmUpdatedEvent extends BaseEvent {
  eventType: 'FarmUpdated';
  farmId: string;
  name?: string;
  location?: { lat: number; lng: number };
  address?: string;
  contactPerson?: string;
  isActive?: boolean;
}

/**
 * Pond Created Event
 */
export interface PondCreatedEvent extends BaseEvent {
  eventType: 'PondCreated';
  pondId: string;
  farmId: string;
  name: string;
  capacity: number;
  waterType: 'freshwater' | 'saltwater' | 'brackish';
}

/**
 * Batch Created Event
 *
 * Note: `farmId` and `pondId` are optional because the domain model
 * has evolved to tank-based allocation. Use `tankIds` for current schema.
 */
export interface BatchCreatedEvent extends BaseEvent {
  eventType: 'BatchCreated';
  batchId: string;
  farmId?: string;
  pondId?: string;
  tankIds?: string[];
  name: string;
  species: string;
  quantity: number;
  stockedAt: Date;
}

/**
 * Batch Harvested Event
 */
export interface BatchHarvestedEvent extends BaseEvent {
  eventType: 'BatchHarvested';
  batchId: string;
  farmId?: string;
  pondId?: string;
  siteId?: string;
  harvestedQuantity: number;
  harvestedAt: Date;
  averageWeight?: number;
  totalWeight?: number;
}

/**
 * Batch Status Changed Event
 */
export interface BatchStatusChangedEvent extends BaseEvent {
  eventType: 'BatchStatusChanged';
  batchId: string;
  farmId?: string;
  siteId?: string;
  previousStatus: string;
  newStatus: string;
  reason?: string;
}

/**
 * Mortality Recorded Event
 */
export interface MortalityRecordedEvent extends BaseEvent {
  eventType: 'MortalityRecorded';
  batchId: string;
  farmId?: string;
  siteId?: string;
  tankId?: string;
  quantity: number;
  reason: MortalityReasonCode;
  mortalityDate: Date;
  newTotalMortality: number;
  newMortalityRate: number;
}

/**
 * Cull Recorded Event
 *
 * Emitted when a cull operation removes fish from a batch (e.g. for
 * grading, undersized fish, or quality control). Distinct from mortality:
 * culls are intentional removals, mortality is unintended loss.
 *
 * Downstream consumers (read-models, dashboards, AI insights) use
 * `newCurrentQuantity` and `newCullCount` to update their projections
 * without re-querying the source-of-truth `Batch` aggregate.
 */
export interface CullRecordedEvent extends BaseEvent {
  eventType: 'CullRecorded';
  batchId: string;
  farmId?: string;
  siteId?: string;
  tankId?: string;
  quantity: number;
  reason: CullReasonCode;
  detail?: string;
  culledAt: Date;
  newCullCount: number;
  newCurrentQuantity: number;
}

/**
 * Feed Inventory Received Event
 *
 * Emitted when a feed lot lands in a site's inventory — either a
 * brand-new `feed_inventory` row is created or an existing row for
 * the same `(feedId, siteId, lotNumber)` has additional quantity
 * folded in.
 *
 * This is the primary lot-traceability anchor. Food-safety audits
 * (FDA 21 CFR 507 / EU 183/2005 Art 5) require the ability to
 * reconstruct "which lot arrived at which site on which date from
 * which supplier" — without an always-fire receive event, the
 * trail lives only in the DB row and becomes invisible to every
 * downstream consumer (regulatory reporting, supplier-performance
 * analytics, AI inventory projections).
 */
export interface FeedInventoryReceivedEvent extends BaseEvent {
  eventType: 'FeedInventoryReceived';
  inventoryId: string;
  feedId: string;
  siteId: string;
  departmentId?: string;
  lotNumber?: string;
  quantityKg: number;
  /** Running total AFTER this receipt (for lot-roll-up projections). */
  newTotalQuantityKg: number;
  manufacturingDate?: Date;
  expiryDate?: Date;
  receivedDate: Date;
  unitPricePerKg?: number;
  currency?: string;
  /** True when a new row was created; false when an existing row absorbed the receipt. */
  isNewLotRow: boolean;
}

/**
 * Cleaner Fish Batch Created Event
 *
 * Lifecycle-start partner to `CleanerFishDeployed` / `…Mortality` /
 * `…Transferred` / `…Removed`. Emitted when a new cleaner-fish
 * batch is registered in the system — a batch lives BEFORE any
 * deploy happens (the fish exist in the batch pool awaiting
 * deployment). Making this moment an event lets AI / analytics
 * services build the full lifecycle timeline from the first row.
 *
 * Carries the `sourceType` discriminator (farmed vs wild_caught)
 * because regulatory exports (Mattilsynet Cleaner Fish Report)
 * split the two sources at report-level; downstream consumers
 * that project per-source summaries don't have to re-read the
 * Batch aggregate.
 */
export interface CleanerFishBatchCreatedEvent extends BaseEvent {
  eventType: 'CleanerFishBatchCreated';
  cleanerBatchId: string;
  batchNumber: string;
  speciesId: string;
  speciesName: string;
  sourceType: 'farmed' | 'wild_caught';
  sourceLocation?: string;
  supplierId?: string;
  initialQuantity: number;
  initialAvgWeightG: number;
  initialBiomassKg: number;
  stockedAt: Date;
}

/**
 * Cleaner Fish Transferred Event
 *
 * Emitted when cleaner fish move from one tank to another within the
 * same cleaner-fish batch. Completes the cleaner-fish lifecycle event
 * quartet (deploy → transfer → mortality → remove).
 *
 * Distinct from `BatchTransferredEvent` (salmon-side) because the
 * cleaner-fish-in-tank state is tracked on `TankBatch.cleanerFishDetails`
 * JSONB and on `Batch.cleanerFishDetails` rather than on the main
 * batch-location table. Downstream consumers projecting a cleaner-
 * fish per-tank timeline need both `source` and `destination`
 * post-operation snapshots to patch state atomically.
 */
export interface CleanerFishTransferredEvent extends BaseEvent {
  eventType: 'CleanerFishTransferred';
  cleanerBatchId: string;
  sourceTankId: string;
  destinationTankId: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  reason?: string;
  transferredAt: Date;
  /** Source tank-batch cleaner-fish stock AFTER the transfer. */
  newSourceTankCleanerFishQuantity: number;
  newSourceTankCleanerFishBiomassKg: number;
  /** Destination tank-batch cleaner-fish stock AFTER the transfer. */
  newDestinationTankCleanerFishQuantity: number;
  newDestinationTankCleanerFishBiomassKg: number;
  newDestinationTankDensityKgM3: number;
}

/**
 * Cleaner Fish Mortality Recorded Event
 *
 * Emitted when cleaner fish (lumpfish / wrasse) die in a tank. The
 * salmon-side analogue is `MortalityRecordedEvent`; these are
 * published as a SEPARATE event type so welfare dashboards and
 * Mattilsynet compliance tooling can filter cleaner-fish mortality
 * without walking every mortality row's associated batch to check
 * `batchType`.
 *
 * Downstream consumers use the `newCleanerBatchTotalMortality` /
 * `newCleanerBatchMortalityRate` fields to patch dashboards without
 * re-reading the Batch aggregate. Welfare-alert engines watch
 * `newCleanerBatchMortalityRate` against the species-specific
 * threshold (lumpfish: 5% / wrasse: 8%) and trigger operator
 * review when crossed.
 */
export interface CleanerFishMortalityRecordedEvent extends BaseEvent {
  eventType: 'CleanerFishMortalityRecorded';
  cleanerBatchId: string;
  tankId: string;
  speciesName: string;
  quantity: number;
  biomassKg: number;
  /** Uppercase normalised reason — matches `MortalityReasonCode`. */
  reason: MortalityReasonCode;
  detail?: string;
  observedAt: Date;
  /** Tank-batch cleaner-fish stock AFTER the mortality is applied. */
  newTankCleanerFishQuantity: number;
  newTankCleanerFishBiomassKg: number;
  /** Cleaner-batch cumulative totals AFTER this death. */
  newCleanerBatchTotalMortality: number;
  newCleanerBatchMortalityRate: number;
}

/**
 * Cleaner Fish Deployed Event
 *
 * Emitted when cleaner fish (lumpfish / wrasse) are placed into a
 * tank from a cleaner-fish batch. Mirror event of
 * `CleanerFishRemoved`; together they form the deploy / remove life-
 * cycle pair that sea-lice-control dashboards project against a
 * tank timeline.
 *
 * Downstream consumers (welfare dashboards, tank-density alerting,
 * AI insights, stock-movement read models) use the post-operation
 * snapshot fields to patch their projections without re-reading the
 * TankBatch + Batch aggregates. `isOverCapacity` reflects the
 * TankCapacityService decision at deploy time — a true flag signals
 * a welfare-regulation edge (stocking above `maxDensity`) that
 * historically triggered an operator override or an audit-review
 * workflow downstream.
 */
export interface CleanerFishDeployedEvent extends BaseEvent {
  eventType: 'CleanerFishDeployed';
  cleanerBatchId: string;
  targetTankId: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  deployedAt: Date;
  /** Tank-batch cleaner-fish stock AFTER the deploy is applied. */
  newTankCleanerFishQuantity: number;
  newTankCleanerFishBiomassKg: number;
  newTankDensityKgM3: number;
  /** Cleaner-batch running stock AFTER the deploy (decremented by quantity). */
  newCleanerBatchCurrentQuantity: number;
  /** True when the deploy pushed total tank biomass past the welfare density gate. */
  isOverCapacity: boolean;
}

/**
 * Cleaner Fish Removed Event
 *
 * Emitted when cleaner fish (lumpfish / wrasse) are taken out of a
 * tank — at end of cycle, as part of a harvest, or relocated to
 * another deployment. Separate from `CullRecorded` because cleaner
 * fish are tracked as their OWN batch with its own `currentQuantity`
 * (they live alongside salmon but count independently); a `relocation`
 * removal actually returns quantity to the cleaner-batch stock
 * (the fish move, they are not destroyed).
 *
 * `CleanerFishRemovalReasonCode` mirrors
 * `apps/farm-service/src/batch/commands/remove-cleaner-fish.command.ts`
 * exactly — the command-layer enum is this contract's vocabulary so
 * consumers don't have to know about server-side representation
 * choices. Adding a new enum value is a backwards-compatible change
 * (consumers with narrowing on the existing values keep working).
 */
export type CleanerFishRemovalReasonCode =
  | 'end_of_cycle'
  | 'harvest'
  | 'relocation'
  | 'other';

export interface CleanerFishRemovedEvent extends BaseEvent {
  eventType: 'CleanerFishRemoved';
  cleanerBatchId: string;
  tankId: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  reason: CleanerFishRemovalReasonCode;
  detail?: string;
  removedAt: Date;
  /** Tank-batch cleaner-fish stock AFTER the removal is applied. */
  newTankCleanerFishQuantity: number;
  newTankCleanerFishBiomassKg: number;
  /** Cleaner-batch running stock AFTER the removal (only changes on `relocation`). */
  newCleanerBatchCurrentQuantity: number;
}

/**
 * Batch Transferred Event
 *
 * Represents an atomic transfer of fish between tanks.
 * Used for history and audit. See also `BatchAllocatedToTankEvent`
 * which represents the resultant allocation state update.
 */
export interface BatchTransferredEvent extends BaseEvent {
  eventType: 'BatchTransferred';
  batchId: string;
  farmId?: string;
  siteId?: string;
  sourceTankId: string;
  destinationTankId: string;
  quantity: number;
  biomassKg: number;
  transferDate: Date;
  reason?: string;
}

/**
 * Batch Allocated to Tank Event
 *
 * Represents the resultant allocation state after a batch movement.
 * Used for current-state queries. See also `BatchTransferredEvent`.
 */
export interface BatchAllocatedToTankEvent extends BaseEvent {
  eventType: 'BatchAllocatedToTank';
  batchId: string;
  farmId?: string;
  siteId?: string;
  tankId: string;
  quantity: number;
  biomassKg: number;
  allocationType: 'initial' | 'transfer_in' | 'split';
  allocationDate: Date;
}

/**
 * Growth Sample Recorded Event
 *
 * `performance` classification is based on percentage deviation from target weight:
 * - excellent: >= +10% above target
 * - good: +0% to +10% above target
 * - average: -5% to 0% of target
 * - below_average: -15% to -5% of target
 * - poor: < -15% below target
 */
export interface GrowthSampleRecordedEvent extends BaseEvent {
  eventType: 'GrowthSampleRecorded';
  batchId: string;
  measurementId: string;
  sampleSize: number;
  averageWeightG: number;
  weightCV: number;
  measurementDate: Date;
  performance?: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

/**
 * Feeding Recorded Event
 */
export interface FeedingRecordedEvent extends BaseEvent {
  eventType: 'FeedingRecorded';
  batchId: string;
  tankId?: string;
  feedId: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  feedingDate: Date;
  feedingTime: string;
  variance: number;
}

/**
 * Tank Density Alert Event
 */
export interface TankDensityAlertEvent extends BaseEvent {
  eventType: 'TankDensityAlert';
  tankId: string;
  tankCode: string;
  currentDensityKgM3: number;
  maxDensityKgM3: number;
  alertLevel: 'warning' | 'critical';
  recommendation: string;
}

/**
 * FCR Alert Event
 */
export interface FCRAlertEvent extends BaseEvent {
  eventType: 'FCRAlert';
  batchId: string;
  currentFCR: number;
  targetFCR: number;
  variancePercent: number;
  trend: 'improving' | 'stable' | 'declining';
  alertLevel: 'warning' | 'critical';
}

/**
 * Batch Closed Event
 */
export interface BatchClosedEvent extends BaseEvent {
  eventType: 'BatchClosed';
  batchId: string;
  farmId?: string;
  siteId?: string;
  closeReason: string;
  finalQuantity: number;
  finalBiomassKg: number;
  finalFCR: number;
  totalMortality: number;
  mortalityRate: number;
  daysInProduction: number;
  closedAt: Date;
}

// ==================== Site Events ====================

/**
 * Site Created Event
 */
export interface SiteCreatedEvent extends BaseEvent {
  eventType: 'SiteCreated';
  siteId: string;
  name: string;
  code: string;
  country: string;
  region?: string;
  status: string;
}

/**
 * Site Updated Event
 */
export interface SiteUpdatedEvent extends BaseEvent {
  eventType: 'SiteUpdated';
  siteId: string;
  name?: string;
  code?: string;
  status?: string;
}

/**
 * Site Deleted Event
 */
export interface SiteDeletedEvent extends BaseEvent {
  eventType: 'SiteDeleted';
  siteId: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== Department Events ====================

/**
 * Department Created Event
 */
export interface DepartmentCreatedEvent extends BaseEvent {
  eventType: 'DepartmentCreated';
  departmentId: string;
  siteId: string;
  name: string;
  code: string;
  type: string;
}

/**
 * Department Updated Event
 */
export interface DepartmentUpdatedEvent extends BaseEvent {
  eventType: 'DepartmentUpdated';
  departmentId: string;
  siteId: string;
  name?: string;
}

/**
 * Department Deleted Event
 */
export interface DepartmentDeletedEvent extends BaseEvent {
  eventType: 'DepartmentDeleted';
  departmentId: string;
  siteId: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== System Events ====================

/**
 * System Created Event
 */
export interface SystemCreatedEvent extends BaseEvent {
  eventType: 'SystemCreated';
  systemId: string;
  siteId: string;
  departmentId?: string;
  name: string;
  code: string;
  type: string;
  status: string;
}

/**
 * System Updated Event
 */
export interface SystemUpdatedEvent extends BaseEvent {
  eventType: 'SystemUpdated';
  systemId: string;
  siteId: string;
  name?: string;
  status?: string;
}

/**
 * System Deleted Event
 */
export interface SystemDeletedEvent extends BaseEvent {
  eventType: 'SystemDeleted';
  systemId: string;
  siteId: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== Equipment Events ====================

/**
 * Equipment Created Event
 */
export interface EquipmentCreatedEvent extends BaseEvent {
  eventType: 'EquipmentCreated';
  equipmentId: string;
  siteId: string;
  systemId?: string;
  departmentId?: string;
  name: string;
  code: string;
  typeId: string;
  category: string;
  status: string;
}

/**
 * Equipment Updated Event
 */
export interface EquipmentUpdatedEvent extends BaseEvent {
  eventType: 'EquipmentUpdated';
  equipmentId: string;
  siteId?: string;
  name?: string;
  status?: string;
}

/**
 * Equipment Deleted Event
 */
export interface EquipmentDeletedEvent extends BaseEvent {
  eventType: 'EquipmentDeleted';
  equipmentId: string;
  siteId?: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== Feed Inventory Events ====================

/**
 * Feeding Record Updated Event
 *
 * Emitted when an existing feeding record's actual / waste / cost /
 * behaviour / environment fields are corrected post-hoc. Critical
 * because FCR (Feed Conversion Ratio) and batch running feed-cost
 * totals project off these values — an untracked correction would
 * leave downstream aggregates out of sync with the source of truth.
 *
 * The `amountDiffKg` and `costDiff` fields let consumers patch
 * their rolling aggregates without fetching the pre/post rows and
 * recomputing the delta locally.
 */
export interface FeedingRecordUpdatedEvent extends BaseEvent {
  eventType: 'FeedingRecordUpdated';
  feedingRecordId: string;
  batchId: string;
  /** Previous `actualAmount` (kg) BEFORE the edit. */
  previousActualAmountKg: number;
  /** New `actualAmount` (kg) AFTER the edit. */
  newActualAmountKg: number;
  /** New minus previous. Positive = over-reported last time, negative = under-reported. */
  amountDiffKg: number;
  previousFeedCost: number;
  newFeedCost: number;
  costDiff: number;
  updatedAt: Date;
}

/**
 * Feed Inventory Adjusted Event
 *
 * Emitted on every manual correction of a feed lot's running
 * quantity — whether an operator increases (found extra bags),
 * decreases (damage / theft write-off), or sets a new absolute
 * quantity (reconciliation against a physical count). This is the
 * audit-trail-critical event; without it, lot discrepancies between
 * expected and physical inventory leave no wire-visible record.
 *
 * Downstream consumers (audit / reconciliation dashboards, AI
 * inventory-variance detection) use `adjustmentType` + `reason` to
 * categorise the adjustment and the post-op `newQuantityKg` to
 * patch projections.
 */
export interface FeedInventoryAdjustedEvent extends BaseEvent {
  eventType: 'FeedInventoryAdjusted';
  inventoryId: string;
  feedId: string;
  siteId: string;
  /**
   * Mirror of the command-layer `AdjustmentType` enum:
   * `increase | decrease | set_quantity`. Lower-snake on the wire.
   */
  adjustmentType: string;
  /** THIS operation's input magnitude — positive regardless of direction. */
  adjustmentQuantityKg: number;
  /** Stock BEFORE the adjustment. */
  previousQuantityKg: number;
  /** Stock AFTER the adjustment. */
  newQuantityKg: number;
  /** Operator-supplied reason for the adjustment (free text, audit-grade). */
  reason: string;
  notes?: string;
  adjustedAt: Date;
}

/**
 * Feed Inventory Consumed Event
 *
 * Always-fire partner to `FeedInventoryReceived`. Every withdrawal
 * from a feed lot — whether used for feeding, spilled, or written
 * off as expired — emits this event. Food-safety traceability
 * demands a complete input/output ledger per lot; without an
 * always-fire consumption event, `FeedInventoryLow` (the alert-
 * derivative) was the only signal and it only fired on the edge
 * where running stock dropped into the LOW_STOCK band. Every other
 * withdrawal was invisible.
 */
export interface FeedInventoryConsumedEvent extends BaseEvent {
  eventType: 'FeedInventoryConsumed';
  inventoryId: string;
  feedId: string;
  siteId: string;
  /**
   * Reason code — mirrors the command-layer `ConsumptionReason` enum
   * (FEEDING / WASTE / SPILLAGE / EXPIRED / OTHER). Lower-snake on
   * the wire so downstream consumers don't need to know server-side
   * enum representation.
   */
  reason: string;
  quantityKg: number;
  /** Running stock AFTER this consumption (for lot-depletion projections). */
  newQuantityKg: number;
  newStatus: string;
  consumedAt: Date;
}

/**
 * Feed Inventory Low Event
 *
 * Location hierarchy: Farm > Site > Department > System > Equipment.
 * `siteId` identifies the site where inventory is tracked.
 * `farmId` is provided when the site maps to a known farm.
 */
export interface FeedInventoryLowEvent extends BaseEvent {
  eventType: 'FeedInventoryLow';
  inventoryId: string;
  feedId: string;
  siteId: string;
  farmId?: string;
  currentQuantityKg: number;
  reorderPointKg: number;
  status: 'low_stock' | 'critical';
}

// ==================== Type Union ====================

/**
 * Union type for all farm events
 */
export type FarmEvent =
  | FarmCreatedEvent
  | FarmUpdatedEvent
  | PondCreatedEvent
  | BatchCreatedEvent
  | BatchHarvestedEvent
  | BatchStatusChangedEvent
  | MortalityRecordedEvent
  | CullRecordedEvent
  | CleanerFishDeployedEvent
  | CleanerFishRemovedEvent
  | CleanerFishMortalityRecordedEvent
  | CleanerFishTransferredEvent
  | CleanerFishBatchCreatedEvent
  | FeedInventoryReceivedEvent
  | FeedInventoryConsumedEvent
  | FeedInventoryAdjustedEvent
  | FeedingRecordUpdatedEvent
  | BatchTransferredEvent
  | BatchAllocatedToTankEvent
  | GrowthSampleRecordedEvent
  | FeedingRecordedEvent
  | TankDensityAlertEvent
  | FCRAlertEvent
  | BatchClosedEvent
  | SiteCreatedEvent
  | SiteUpdatedEvent
  | SiteDeletedEvent
  | DepartmentCreatedEvent
  | DepartmentUpdatedEvent
  | DepartmentDeletedEvent
  | SystemCreatedEvent
  | SystemUpdatedEvent
  | SystemDeletedEvent
  | EquipmentCreatedEvent
  | EquipmentUpdatedEvent
  | EquipmentDeletedEvent
  | FeedInventoryLowEvent;
