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
export type MortalityReasonCode = (typeof MORTALITY_REASONS)[number];

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
export type CullReasonCode = (typeof CULL_REASONS)[number];

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
  stockedAt: string;
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
  harvestedAt: string;
  averageWeight?: number;
  totalWeight?: number;
  /**
   * v2 (optional, additive): true when this harvest emptied the batch
   * (currentQuantity reached 0) — the FINAL harvest, distinct from a
   * partial one. It is a SIGNAL for a downstream batch-closure consumer;
   * it does NOT itself close the batch (final FCR/mortality/days-in-
   * production are frozen only by the separate CloseBatchCommand).
   *
   * TOLERANT READER (mandatory): a missing/undefined value MUST be read
   * as `false` (treat unknown as partial). Defaulting to `true` would
   * auto-close batches on replayed v1 events — a lifecycle-integrity
   * hazard. v1 events legitimately lack this field; finality cannot be
   * derived retroactively from a v1 payload.
   */
  isFinal?: boolean;
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
  mortalityDate: string;
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
  culledAt: string;
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
  manufacturingDate?: string;
  expiryDate?: string;
  receivedDate: string;
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
  stockedAt: string;
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
  transferredAt: string;
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
  observedAt: string;
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
  deployedAt: string;
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
export type CleanerFishRemovalReasonCode = 'end_of_cycle' | 'harvest' | 'relocation' | 'other';

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
  removedAt: string;
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
  transferDate: string;
  reason?: string;
}

/**
 * Batch Graded Event (FARM-MEDIUM-117)
 *
 * Summary record of a first-class grading operation: fish from one
 * source tank sorted into size classes and distributed across
 * destination tanks. Each individual movement is also recorded as a
 * `BatchTransferred` event with reason 'grading' — this event carries
 * the operation-level view (all outputs together).
 */
export interface BatchGradedOutput {
  destinationTankId: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  sizeClass?: string;
}

/**
 * BatchGraded — operation-level SUMMARY of a grading run.
 *
 * FARM-LOW-146: this event intentionally has NO delta-applying backend consumer.
 * A grading run is composed of one TransferBatchCommand per output, and each of
 * those already emits a BatchTransferred event carrying the authoritative stock
 * deltas that the farm read-model projection applies. BatchGraded exists only as
 * an operation-level audit/summary record (and a future FE realtime-bridge
 * surface), mirroring how WaterQualityMeasurementCreated is treated — wiring a
 * consumer that re-applied its totals would double-count. Do not add a
 * delta-applying consumer.
 */
export interface BatchGradedEvent extends BaseEvent {
  eventType: 'BatchGraded';
  batchId: string;
  sourceTankId: string;
  totalQuantity: number;
  totalBiomassKg: number;
  gradedDate: string;
  outputs: BatchGradedOutput[];
  notes?: string;
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
  allocationDate: string;
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
  /**
   * Unit the sample re-based (additive, v1-compatible). A weighing moves the
   * tank's avgWeightG / totalBiomassKg, so the farm-stock read model must
   * refresh that container — without this field the consumer cannot tell which
   * one changed. Absent when the batch is in no unit (pond-held/unallocated).
   */
  tankId?: string;
  measurementId: string;
  sampleSize: number;
  averageWeightG: number;
  weightCV: number;
  measurementDate: string;
  performance?: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

/**
 * Feeding Recorded Event
 *
 * `feedCost`/`currency` (additive, v1-compatible) carry the monetary
 * cost of the feeding so finance projections (future finance-service)
 * can aggregate feed spend without querying farm-service. Monetary
 * value is a string-encoded decimal per HR-MEDIUM-001 — NEVER a
 * JavaScript `number`.
 */
export interface FeedingRecordedEvent extends BaseEvent {
  eventType: 'FeedingRecorded';
  batchId: string;
  tankId?: string;
  feedId: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  feedingDate: string;
  feedingTime: string;
  variance: number;
  /** String-encoded decimal cost of this feeding (e.g. "123.45"). */
  feedCost?: string;
  /** ISO 4217 currency code for feedCost. */
  currency?: string;
  // ── Öğün motoru v2 bağları (Faz 5, additive — C-13 wire şeması güncel) ──
  /** Döküm hangi öğüne ait (v2 motoru; manuel kayıtta boş). */
  mealId?: string;
  pourIndex?: number;
  dayPlanId?: string;
  /** Equipment.id — kanonik ünite kimliği (tankId ile aynı değer taşır). */
  unitId?: string;
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
  closedAt: string;
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
  deletedAt: string;
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
  deletedAt: string;
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
  deletedAt: string;
}

// ==================== Tank Events ====================

export interface TankCreatedEvent extends BaseEvent {
  eventType: 'TankCreated';
  tankId: string;
  departmentId: string;
  systemId?: string;
  name: string;
  code: string;
  tankType: string;
  status: string;
  volume: number;
  maxBiomass: number;
}

export interface TankUpdatedEvent extends BaseEvent {
  eventType: 'TankUpdated';
  tankId: string;
  departmentId: string;
  systemId?: string;
  name?: string;
  tankType?: string;
  status?: string;
  volume?: number;
  maxBiomass?: number;
}

export interface TankStatusChangedEvent extends BaseEvent {
  eventType: 'TankStatusChanged';
  tankId: string;
  previousStatus: string;
  newStatus: string;
  reason?: string;
  changedAt: string;
}

export interface TankDeletedEvent extends BaseEvent {
  eventType: 'TankDeleted';
  tankId: string;
  departmentId: string;
  name: string;
  code: string;
  deletedAt: string;
}

// ==================== Equipment Events ====================

/**
 * Equipment Created Event
 */
export interface EquipmentCreatedEvent extends BaseEvent {
  eventType: 'EquipmentCreated';
  equipmentId: string;
  siteId?: string;
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
  deletedAt: string;
}

export interface SubEquipmentCreatedEvent extends BaseEvent {
  eventType: 'SubEquipmentCreated';
  subEquipmentId: string;
  parentEquipmentId: string;
  name: string;
  code: string;
  status: string;
}

export interface SubEquipmentUpdatedEvent extends BaseEvent {
  eventType: 'SubEquipmentUpdated';
  subEquipmentId: string;
  parentEquipmentId: string;
  name?: string;
  status?: string;
}

export interface SubEquipmentDeletedEvent extends BaseEvent {
  eventType: 'SubEquipmentDeleted';
  subEquipmentId: string;
  parentEquipmentId: string;
  name: string;
  code: string;
  deletedAt: string;
}

/**
 * Feeder Calibrations Saved Event
 *
 * Emitted when the complete calibration set for one feeder-capable
 * equipment row is replaced. The event is intentionally aggregate-level:
 * consumers that need row details can reload by equipmentId, while replay
 * and invalidation only need to know which equipment's calibration set
 * changed and how many rows are now authoritative.
 */
/**
 * Birleşik protokol bir üniteye atandığında (feeding-protocol SSoT Faz 3).
 * Audit + gelecekteki analytics tüketicileri için; atama transaction'ında
 * outbox'a yazılır.
 */
export interface FeedingProtocolAssignedEvent extends BaseEvent {
  eventType: 'FeedingProtocolAssigned';
  userId?: string;
  assignmentId: string;
  unitId: string;
  unitType: 'tank' | 'pond' | 'cage';
  unitCode: string;
  siteId: string;
  protocolId: string;
  protocolName: string;
  /** Değiştirme semantiği: önceki aktif atamanın id'si (tarihçe). */
  replacedAssignmentId?: string;
  /** Tür uyumsuzluğunda operatörün bilinçli-devam gerekçesi (audit). */
  speciesMismatchReason?: string;
}

/**
 * Aktif bir atama otomatik/operatör kararıyla duraklatıldığında — protokol
 * arşivi (D-10), boş ünite (Faz 5) veya operatör pause'u. Ünitenin plansız
 * kaldığının görünür sinyali.
 */
export interface FeedingProtocolAssignmentPausedEvent extends BaseEvent {
  eventType: 'FeedingProtocolAssignmentPaused';
  userId?: string;
  assignmentId: string;
  unitId: string;
  unitCode: string;
  protocolId: string;
  reason: 'protocol_archived' | 'operator_paused' | 'unit_emptied';
}

/** Bir ünitenin AKTİF yemleyici atamasındaki tek bir satırın özeti. */
export interface UnitFeederShareEntry {
  assignmentId: string;
  feederEquipmentId: string;
  feederCode: string;
  /** Günlük dozdaki pay (%); aktif girdilerin toplamı tam 100'dür. */
  doseSharePercent: number;
}

/**
 * Bir ünitenin yemleyici kümesi değiştiğinde (ekleme, çıkarma, pay değişimi).
 *
 * Event ÜNİTE düzeyindedir, satır düzeyinde değil: bir ünitenin payları ancak
 * birlikte anlamlıdır (toplamları 100'dür), dolayısıyla tek bir satırın
 * değiştiğini duyurmak tüketiciye eksik bilgi verir. `feeders` değişiklik
 * sonrasındaki TAM aktif küme, `endedAssignmentIds` ise aynı işlemde tarihçeye
 * inen satırlardır.
 */
export interface UnitFeederAssignmentsChangedEvent extends BaseEvent {
  eventType: 'UnitFeederAssignmentsChanged';
  userId?: string;
  unitId: string;
  unitType: 'tank' | 'pond' | 'cage';
  unitCode: string;
  siteId: string;
  feeders: UnitFeederShareEntry[];
  endedAssignmentIds: string[];
}

// ==================== Meal Engine Events (Faz 5 — plan §7/§10) ====================

/**
 * MealWindowUpcoming toplu girdisi — sensor-service'in aeratör ön-takviyesi
 * (otomasyon kancası) için gereken her şeyi taşır.
 */
export interface MealWindowEntry {
  unitId: string;
  unitCode: string;
  dayPlanId: string;
  mealId: string;
  mealIndex: number;
  /** ISO timestamptz — site saat diliminden maddileşmiş mutlak an (D-4). */
  scheduledAt: string;
  feedId: string;
  plannedKg: number;
  protocolId: string;
  minDissolvedOxygen?: number;
  lowOxygenReductionPercent?: number;
}

/**
 * Yaklaşan öğün penceresi — (tenant, cron-tick) başına TOPLU kanonik şekil
 * (K-2): 500 girdi/event cap + devam event'leri (batchIndex/batchCount).
 * 15dk cron üretir; `windowNotifiedAt` idempotency damgasıdır.
 */
export interface MealWindowUpcomingEvent extends BaseEvent {
  eventType: 'MealWindowUpcoming';
  windowStart: string;
  windowEnd: string;
  leadMinutes: number;
  batchIndex: number;
  batchCount: number;
  meals: MealWindowEntry[];
}

/** Bir döküm kaydedildi (öğün başına değil DÖKÜM başına — D-8 granülü). */
export interface MealFedEvent extends BaseEvent {
  eventType: 'MealFed';
  unitId: string;
  mealId: string;
  dayPlanId: string;
  feedId: string;
  pourIndex: number;
  pourKg: number;
  /** Kümülatif gerçekleşen (Σ pours). */
  actualKg: number;
  fedAt: string;
  feedingMethod?: string;
}

export interface MealSkippedEvent extends BaseEvent {
  eventType: 'MealSkipped';
  unitId: string;
  mealId: string;
  dayPlanId: string;
  reason: string;
  skippedAt: string;
}

/**
 * Az-atım: öğün finalize'ında (scope=meal) veya 20:00 gün-seviyesi
 * süpürmesinde (scope=day, D-16 — öğün başına eşik altı kalan kronik açık).
 */
export interface MealUnderfedEvent extends BaseEvent {
  eventType: 'MealUnderfed';
  scope: 'meal' | 'day';
  unitId: string;
  unitCode: string;
  dayPlanId: string;
  mealId?: string;
  plannedKg: number;
  actualKg: number;
  variancePercent: number;
  thresholdPercent: number;
}

/** Penceresi geçmiş, hiç döküm görmemiş öğün (05:30 süpürmesi işaretler). */
export interface MealMissedEvent extends BaseEvent {
  eventType: 'MealMissed';
  unitId: string;
  unitCode: string;
  mealId: string;
  dayPlanId: string;
  scheduledAt: string;
}

/** Ağırlık bandı geçişi — otomatik (histerezisli) veya manuel (P-12). */
export interface FeedTypeTransitionedEvent extends BaseEvent {
  eventType: 'FeedTypeTransitioned';
  unitId: string;
  unitCode: string;
  assignmentId: string;
  fromFeedId?: string;
  toFeedId: string;
  toFeedCode: string;
  bandIndex: number;
  avgWeightG: number;
  automatic: boolean;
}

/**
 * Balıklı ama etkin planı olmayan ünite (D-5 — sessiz aç kalma imkânsız):
 * atamasız / balıklı-paused / DRAFT protokollü. 06:00 üretimi tespit eder.
 */
export interface UnfedUnitDetectedEvent extends BaseEvent {
  eventType: 'UnfedUnitDetected';
  unitId: string;
  unitCode: string;
  siteId: string;
  reason: 'no_assignment' | 'assignment_paused' | 'draft_protocol';
  fishCount: number;
  biomassKg: number;
}

/**
 * FeedStockoutForecast tüketicilerinin PAYLAŞTIĞI önem eşiği (plan §6):
 * `daysOfCover <= FEED_STOCKOUT_CRITICAL_DAYS` → critical; `<= tedarik süresi`
 * → warning; ötesi aksiyon penceresi dışıdır (incident/rozet üretilmez).
 * alert-engine incident önemi ve warehouse-summary `coverageStatus` AYNI
 * sabiti okur — kod-ikizi eşik yasak (tek sahip, event'in yanında yaşar).
 */
export const FEED_STOCKOUT_CRITICAL_DAYS = 3;

/**
 * 07:00 kapsama süpürmesi (Faz 7, plan §5): ufuk içinde tükeniş öngörülen
 * yem — alert-engine ≤3 gün critical / ≤leadTime warning üretir.
 */
export interface FeedStockoutForecastEvent extends BaseEvent {
  eventType: 'FeedStockoutForecast';
  /** Site UUID'si ya da belgeli tenant-geneli fallback için 'tenant' (D-9). */
  siteScopeKey: string;
  feedId: string;
  feedCode: string;
  daysOfCover: number;
  stockoutDate: string;
  reorderDate?: string;
  procurementLeadTimeDays: number;
}

/**
 * Yaklaşan yem geçişi (+ varsa kapsama açığı) — "Tank 1 X gün sonra B'ye
 * geçecek, B stoğu Y gün yeter" sinyalinin durable taşıyıcısı.
 */
export interface FeedTransitionUpcomingEvent extends BaseEvent {
  eventType: 'FeedTransitionUpcoming';
  siteScopeKey: string;
  unitId: string;
  unitCode: string;
  fromFeedId: string;
  toFeedId: string;
  estimatedDate: string;
  daysFromNow: number;
  /** Hedef yemin geçiş sonrası kapsama açığı (gün) — yoksa kapsama yeterli. */
  shortfallDays?: number;
}

/** Günlük yemleme özeti — 20:00 cron, outbox → notification-service (K-8c). */
export interface FeedingDailySummaryEvent extends BaseEvent {
  eventType: 'FeedingDailySummary';
  planDate: string;
  unitsPlanned: number;
  unitsCompleted: number;
  unitsSkipped: number;
  plannedTotalKg: number;
  actualTotalKg: number;
  underfedUnitCount: number;
  missedMealCount: number;
}

export interface FeederCalibrationsSavedEvent extends BaseEvent {
  eventType: 'FeederCalibrationsSaved';
  equipmentId: string;
  calibrationCount: number;
  feedSizeMm: number[];
  changedBy: string;
}

// ==================== Feed Inventory Events ====================

/**
 * Batch Metadata Updated Event
 *
 * Emitted when batch descriptive / target fields (name, description,
 * strain, targetFCR, expectedHarvestDate, notes) are edited. Separate
 * from `BatchStatusChangedEvent` because status transitions have
 * their own event with its own semantics (active → harvesting → etc.).
 *
 * Carries `changedFields[]` so downstream consumers can narrow
 * re-projection scope. A notes-only edit doesn't warrant a dashboard
 * re-render; a `targetFCR` edit does trigger FCR-drift recalculation.
 */
export interface BatchMetadataUpdatedEvent extends BaseEvent {
  eventType: 'BatchMetadataUpdated';
  batchId: string;
  /** List of changed top-level field names — audit-grade. */
  changedFields: string[];
  /** Carried for convenience on the hottest consumer path (FCR projections). */
  newTargetFCR?: number;
  newExpectedHarvestDate?: string;
  updatedAt: string;
}

/**
 * Harvest Record Cancelled Event
 *
 * Emitted when a harvest record is soft-deleted (status flipped to
 * `CANCELLED`). NOT called "deleted" because the row persists for
 * audit — the status is the source of truth, and the cascade
 * reverses batch + tank-batch + tank biomass/quantity projections.
 *
 * The event carries the reversed quantities so downstream consumers
 * know the exact numerical delta to apply to their projections
 * without re-reading the aggregates (the harvest record has the
 * pre-reversal values; consumers patching after the event need the
 * delta direction).
 *
 * Not emitted on dispatched / delivered records — those cannot be
 * cancelled (enforced at the handler level).
 */
export interface HarvestRecordCancelledEvent extends BaseEvent {
  eventType: 'HarvestRecordCancelled';
  harvestRecordId: string;
  batchId: string;
  tankId?: string;
  /** Quantity that was reversed on the batch (added back to currentQuantity). */
  reversedQuantity: number;
  /** Biomass (kg) that was reversed on the tank + tank-batch. */
  reversedBiomassKg: number;
  cancelledAt: string;
}

/**
 * Harvest Record Updated Event
 *
 * Emitted when an existing harvest record's regulatory / financial /
 * quantity fields are corrected post-hoc. Harvest records feed the
 * Mattilsynet Slakterapport and downstream customer traceability —
 * any edit must be audit-visible so the regulatory export reconciles
 * to the same numbers the live dashboard shows.
 *
 * Carries the list of field paths that changed so downstream
 * consumers can narrow their re-projection scope (a notes-only edit
 * doesn't require re-sending the Slakterapport).
 */
export interface HarvestRecordUpdatedEvent extends BaseEvent {
  eventType: 'HarvestRecordUpdated';
  harvestRecordId: string;
  batchId: string;
  /** List of field names that changed on this update — audit-grade. */
  changedFields: string[];
  /** New `quantityHarvested` — carried for convenience of the hottest projection path. */
  newQuantityHarvested: number;
  newTotalBiomass: number;
  newStatus: string;
  updatedAt: string;
}

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
  updatedAt: string;
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
  adjustedAt: string;
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
  consumedAt: string;
}

/**
 * Feed Inventory Low Event
 *
 * Location hierarchy: Farm > Site > Department > System > Equipment.
 * `siteId` identifies the site where inventory is tracked.
 * `farmId` is provided when the site maps to a known farm.
 */
/**
 * Legacy Farm Data Migrated Event
 *
 * Emitted by the `farm-service migrate-legacy-farm --execute` CLI
 * once per tenant schema after legacy `farms` / `ponds` rows have
 * been copied into the canonical `sites` / `tanks` tables. The
 * event is audit-grade — consumers (observability, compliance
 * export, read-model rebuilders) use the counts to verify that the
 * expected tenant-level migration actually landed.
 *
 * Scope 1 of the 2026-04-24 deferred-items plan (Phase 4.3.0 /
 * 4.3.2). One event per tenant per CLI run — NOT per legacy row.
 * Per-row replay granularity is unnecessary because cross-service
 * consumers were migrated off `farm.farms` / `farm.ponds` before
 * this CLI existed.
 */
export interface LegacyFarmDataMigratedEvent extends BaseEvent {
  eventType: 'LegacyFarmDataMigrated';
  /**
   * Tenant schema that was processed (e.g. `tenant_9f83a2b1c4d5e6f7`).
   * Redundant with BaseEvent.tenantId but carried explicitly for
   * audit dashboards that want to filter by the physical schema
   * without re-deriving it from the UUID.
   */
  tenantSchemaName: string;
  /** How many legacy `farms` rows were inserted into `sites` during this run. */
  farmsMigrated: number;
  /** How many legacy `farms` rows were skipped (already migrated, idempotent re-run). */
  farmsSkipped: number;
  /** How many legacy `ponds` rows were inserted into `tanks` during this run. */
  pondsMigrated: number;
  /** How many legacy `ponds` rows were skipped. */
  pondsSkipped: number;
  /**
   * How many synthetic `Department` rows were created to satisfy the
   * `tanks.departmentId` NOT NULL constraint (see plan Q2). One per
   * migrated site that had at least one pond.
   */
  syntheticDepartmentsCreated: number;
  /** Identity of the operator who ran the CLI (from --operator-id flag). */
  operatorId: string;
  /** When the CLI started, ISO-8601. */
  migrationStartedAt: string;
  /** When the CLI finished for THIS tenant, ISO-8601. */
  migrationCompletedAt: string;
}

/**
 * Legacy Farm Table Converted Event
 *
 * Emitted once per tenant schema per conversion-step for the legacy
 * `farms` and `ponds` TABLES as they progress through the retirement
 * lifecycle:
 *
 *   `table-to-view`  — Phase 4.3.3 swaps each TABLE for a compat VIEW
 *                      projecting from `sites` / `tanks`. Row counts
 *                      preserved; writes now fail ("cannot insert into
 *                      view") which is the intended fail-closed posture.
 *   `view-dropped`   — Phase 4.3.5 drops the VIEW entirely after the
 *                      retention window. Read-side callers that
 *                      survived the 90-day grace see a hard error now.
 *
 * One event per tenant per table per phase. Consumers (compliance
 * export, deprecation dashboards) use the `phase` discriminator to
 * track progress without re-running inventory queries.
 */
export interface LegacyFarmTableConvertedEvent extends BaseEvent {
  eventType: 'LegacyFarmTableConverted';
  /** Tenant schema where the conversion ran. */
  tenantSchemaName: string;
  /** Which legacy table this event concerns. */
  table: 'farms' | 'ponds';
  /** Conversion phase — see the docstring above for semantics. */
  phase: 'table-to-view' | 'view-dropped';
  /**
   * Row count at conversion time (for `table-to-view`: rows in the
   * legacy TABLE before conversion; for `view-dropped`: 0 — there
   * are no rows to report, VIEW is being removed).
   */
  rowCount: number;
  /** When the conversion ran, ISO-8601. */
  convertedAt: string;
}

/**
 * SupplierApprovedSitesChanged — emitted when an operator updates the
 * set of sites a supplier is approved to deliver to (Scope A Phase
 * 4.4.2). The event carries the BEFORE and AFTER site-id sets so
 * downstream consumers (audit log, procurement-policy enforcement,
 * site-onboarding workflows) can detect deltas without re-querying.
 *
 * Why both `previousSiteIds` and `newSiteIds`:
 *   - `previousSiteIds` is the snapshot at the start of the
 *     transactional `setSupplierApprovedSites` handler (before delete).
 *   - `newSiteIds` is what the row set looks like after the insert.
 * The diff (added/removed sites) is computable on the consumer side;
 * shipping both lists keeps the event self-contained for replay.
 *
 * `preferredSiteId` is included because operators may flip the
 * preferred site for an unchanged set of approved sites — the diff
 * alone wouldn't surface that change.
 *
 * One event per setSupplierApprovedSites call (per supplier). Tenant
 * isolation is via `tenantId` on the BaseEvent.
 */
export interface SupplierApprovedSitesChangedEvent extends BaseEvent {
  eventType: 'SupplierApprovedSitesChanged';
  supplierId: string;
  previousSiteIds: string[];
  newSiteIds: string[];
  previousPreferredSiteId: string | null;
  newPreferredSiteId: string | null;
  /** Operator who triggered the change (resolver `user.sub`). */
  changedBy: string;
}

/**
 * SiteContactsChanged — emitted when an operator upserts the contact
 * list for a site (Scope A Phase 4.4.3). Carries before/after lists
 * so downstream consumers (audit log, notification preferences,
 * tenant erasure workflows) get a self-contained record.
 *
 * Contacts are PII, so the event intentionally does not ship names,
 * email addresses, phone numbers, or role labels. The authoritative
 * details remain in `site_contacts` plus the fail-closed audit log;
 * realtime consumers only need invalidation-safe aggregate metadata.
 */
export interface SiteContactsChangedEvent extends BaseEvent {
  eventType: 'SiteContactsChanged';
  siteId: string;
  previousContactCount: number;
  newContactCount: number;
  primaryContactChanged: boolean;
  /** Operator who triggered the change (resolver `user.sub`). */
  changedBy: string;
}

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

// ====================================================================
// Immediate Mattilsynet "varsling" reports (welfare / escape / disease)
// ====================================================================
//
// WHY a separate event family — these three reports are NOT part of the
// Mattilsynet `innrapportering-api` (Maskinporten REST) surface. That API
// covers exactly lakselus / rensefisk / settefisk / slakt. Welfare events,
// escapes, and notifiable-disease outbreaks are legally-immediate
// "varsling" notifications that the regulation routes to
// varsling.akva@mattilsynet.no (escapes additionally to
// Fiskeridirektoratet). The real submission channel is therefore email,
// already implemented in notification-service EmailService
// (sendWelfareEventEmail / sendEscapeReportEmail / sendDiseaseOutbreakEmail).
//
// WHAT — farm-service emits one of these events transactionally via the
// outbox; notification-service consumes them and dispatches the urgent
// email. The event carries the full Mattilsynet identity block
// (organisasjonsnummer, lokalitetsnummer, kontaktperson) plus the
// report-specific payload the email template renders, so the consumer
// needs no callback into farm-service.

/**
 * Contact person block carried on immediate regulatory varsling events.
 * Mirrors the Mattilsynet `Kontaktperson` object required on every report.
 */
export interface RegulatoryContactPerson {
  navn: string;
  epost: string;
  telefonnummer?: string;
}

/**
 * Welfare event reported to Mattilsynet (varsling).
 *
 * Emitted when an operator submits a welfare incident (mortality
 * threshold breach, equipment failure affecting welfare, or a
 * general welfare-impact event). Consumed by notification-service,
 * which renders + sends the urgent welfare email to Mattilsynet.
 */
export interface WelfareEventReportedEvent extends BaseEvent {
  eventType: 'WelfareEventReported';
  /** Client reference echoed in the email subject for traceability. */
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  siteId: string;
  siteName: string;
  siteCode?: string;
  kontaktperson: RegulatoryContactPerson;
  /** Site-manager CC recipient, when configured. */
  siteManagerEmail?: string;
  detectedAt: string;
  reportedBy: string;
  welfareEventType: 'mortality_threshold' | 'equipment_failure' | 'welfare_impact';
  severity: 'high' | 'critical';
  mortalityRate?: number;
  mortalityPeriod?: string;
  affectedBatches?: string[];
  description: string;
  immediateActions: string[];
}

/**
 * Fish escape reported to Mattilsynet + Fiskeridirektoratet (varsling).
 *
 * Emitted when an operator submits an escape incident. Consumed by
 * notification-service, which renders + sends the urgent escape email.
 */
export interface EscapeReportedEvent extends BaseEvent {
  eventType: 'EscapeReported';
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  siteId: string;
  siteName: string;
  siteCode?: string;
  kontaktperson: RegulatoryContactPerson;
  siteManagerEmail?: string;
  detectedAt: string;
  reportedBy: string;
  estimatedCount: number;
  species: string;
  avgWeightG: number;
  totalBiomassKg: number;
  cause: string;
  affectedUnits: string[];
  recoveryOngoing: boolean;
}

/**
 * Operational escape incident recorded (distinct from EscapeReported, which
 * is the varsling SUBMISSION event). Emitted when a field operator records
 * that an escape happened; consumed by notification-service to remind the
 * responsible manager that the romming varsling is legally immediate.
 */
export interface EscapeIncidentRecordedEvent extends BaseEvent {
  eventType: 'EscapeIncidentRecorded';
  incidentId: string;
  siteId: string;
  tankId?: string;
  speciesId: string;
  estimatedCount: number;
  cause: string;
  detectedAt: string;
  recordedBy: string;
}

/**
 * Notifiable disease outbreak reported to Mattilsynet (varsling).
 *
 * Emitted when an operator submits a Liste A/C/F disease outbreak.
 * Consumed by notification-service, which renders + sends the urgent
 * disease email.
 */
export interface DiseaseOutbreakReportedEvent extends BaseEvent {
  eventType: 'DiseaseOutbreakReported';
  klientReferanse: string;
  organisasjonsnummer: string;
  lokalitetsnummer: number;
  siteId: string;
  siteName: string;
  siteCode?: string;
  kontaktperson: RegulatoryContactPerson;
  siteManagerEmail?: string;
  detectedAt: string;
  reportedBy: string;
  diseaseCategory: 'A' | 'C' | 'F';
  diseaseName: string;
  confirmation: 'suspected' | 'confirmed';
  affectedCount: number;
  affectedPercentage: number;
  clinicalSigns: string[];
  veterinarianNotified: boolean;
  veterinarianName?: string;
}

// ====================================================================
// Harvest / mortality FOLLOW-UP events (dead-listeners produce-side cure)
// ====================================================================
//
// WHY this family exists — these four events are emitted by the farm-service
// event listeners AFTER they consume a trigger event (BatchHarvested /
// MortalityRecorded). The pre-cure code published them as INLINE objects that
// REUSED the trigger's `eventId`. Because NatsEventBus stamps `msgID =
// event.eventId` on a single `events.>` stream with a 2-minute
// `duplicate_window`, every follow-up collided with the still-resident trigger
// msgID and was SILENTLY DROPPED — the whole follow-up chain was dead on the
// wire. The cure mints a FRESH identity per follow-up with `createBaseEvent`
// (branded EventId — see base-event.ts), threading `causationId = trigger
// eventId` and `correlationId = trigger correlationId` so the chain stays
// traceable. Promoting them to FIRST-CLASS flat contracts is what makes the
// inline-construction footgun a compile error going forward (CLAUDE.md rule 4).
//
// FLAT per ADR-006 — no nested `performance` / `production` wrappers.
// BatchProductionCompleted is flattened to top-level `final*` fields.
//
// CONSUMERS (wired in the same change-set):
//   - MortalityAlertRaised      → alert-engine (creates a real AlertIncident)
//   - HarvestRegulatoryRecorded → notification-service (traceability record)
//   - TankCleared               → gateway-api FarmNatsBridge → tenant room
//   - BatchProductionCompleted  → gateway-api FarmNatsBridge → tenant room

/**
 * Mortality alert raised by the farm-service mortality listener when a recorded
 * mortality breaches a configured threshold (single-event count, daily rate, or
 * cumulative rate). Distinct from the alert-engine-owned `AlertTriggered`: a farm
 * producer cannot supply `alertId` / `ruleId` / `channels` / `recipients`, so it
 * raises THIS lighter signal and the alert-engine converts it into a real alert.
 */
export interface MortalityAlertRaisedEvent extends BaseEvent {
  eventType: 'MortalityAlertRaised';
  batchId: string;
  tankId?: string;
  alertType: 'single_event' | 'daily_rate' | 'cumulative_rate';
  severity: 'warning' | 'critical';
  message: string;
  mortalityRate: number;
  reason: MortalityReasonCode;
  recordedAt: string;
}

/**
 * Harvest regulatory / traceability record emitted on every harvest (partial or
 * final). Food-safety recall chains (FDA 21 CFR 123 / EU 853/2004) require a
 * per-harvest traceability anchor; this is the wire-visible record consumed by
 * notification-service for the traceability log + operator confirmation.
 */
export interface HarvestRegulatoryRecordedEvent extends BaseEvent {
  eventType: 'HarvestRegulatoryRecorded';
  batchId: string;
  harvestedQuantity: number;
  totalWeight?: number;
  averageWeight?: number;
  harvestedAt: string;
  /** Operator who performed the harvest (BaseEvent.userId on the trigger). */
  harvestedBy?: string;
  /** True when this harvest emptied the batch (mirrors BatchHarvested.isFinal). */
  isFinal: boolean;
}

/**
 * A Mattilsynet submission failed PERMANENTLY (RPT-018) — a 400/valideringsfeil
 * that retrying would only re-reject. Consumed by notification-service to alert
 * the operator that manual correction + resubmit is required; the retry sweep
 * never touches a PERMANENT row. TRANSIENT failures do NOT raise this event
 * (they self-heal via backoff replay).
 */
export interface RegulatoryReportSubmissionFailedEvent extends BaseEvent {
  eventType: 'RegulatoryReportSubmissionFailed';
  reportId: string;
  reportType: string;
  klientReferanse: string;
  siteId?: string;
  lokalitetsnummer: number;
  feilmelding: string;
  attemptCount: number;
}

/**
 * A scheduled regulatory report draft is approaching (or past) its official
 * Mattilsynet deadline (RPT-003). Raised by the daily deadline sweep once per
 * bucket transition (APPROACHING → DUE_SOON → DUE → OVERDUE), deduped by the
 * draft's deadlineNotifiedBucket + the outbox idempotencyKey
 * `deadline:{draftId}:{bucket}`. Consumed by notification-service to remind the
 * operator to review + approve the draft before the deadline.
 */
export interface RegulatoryReportDeadlineApproachingEvent extends BaseEvent {
  eventType: 'RegulatoryReportDeadlineApproaching';
  draftId: string;
  reportType: string;
  siteId: string;
  reportYear: number;
  reportWeek?: number;
  reportMonth?: number;
  /** Official deadline (Oslo calendar date, ISO yyyy-mm-dd). */
  dueAt: string;
  /** APPROACHING | DUE_SOON | DUE | OVERDUE. */
  bucket: string;
  /** Whole Oslo-calendar days until the deadline (negative when overdue). */
  daysUntilDue: number;
}

/**
 * Tank cleared — emitted when a final harvest empties the last batch out of a
 * tank, so the tank is now free for re-stocking. A dashboard/read-model signal:
 * consumed by the gateway FarmNatsBridge and broadcast into the tenant room so
 * the tank-occupancy view updates in real time.
 */
export interface TankClearedEvent extends BaseEvent {
  eventType: 'TankCleared';
  tankId: string;
  tankCode?: string;
  previousBatchId: string;
  clearedAt: string;
}

/**
 * Batch production completed — emitted on a final, fully-emptied harvest. Carries
 * the frozen production + performance summary (flattened to `final*` fields per
 * ADR-006) so a dashboard/read-model consumer can render the batch-cycle outcome
 * without re-reading the Batch aggregate. This is a lifecycle SIGNAL only; the
 * authoritative batch closure (final FCR/mortality freeze) is the separate
 * CloseBatchCommand → BatchClosedEvent.
 */
export interface BatchProductionCompletedEvent extends BaseEvent {
  eventType: 'BatchProductionCompleted';
  batchId: string;
  // ── Production (flattened from the former nested `production` object) ──
  initialQuantity: number;
  harvestedQuantity: number;
  harvestedBiomassKg: number;
  avgWeightG: number;
  survivalRate: number;
  mortalityRate: number;
  // ── Performance (flattened from the former nested `performance` object) ──
  daysInProduction: number;
  fcr: number;
  sgr: number;
  totalFeedConsumedKg: number;
  completedAt: string;
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
  | HarvestRecordUpdatedEvent
  | HarvestRecordCancelledEvent
  | BatchMetadataUpdatedEvent
  | LegacyFarmDataMigratedEvent
  | LegacyFarmTableConvertedEvent
  | SupplierApprovedSitesChangedEvent
  | SiteContactsChangedEvent
  | BatchTransferredEvent
  | BatchGradedEvent
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
  | TankCreatedEvent
  | TankUpdatedEvent
  | TankStatusChangedEvent
  | TankDeletedEvent
  | EquipmentCreatedEvent
  | EquipmentUpdatedEvent
  | EquipmentDeletedEvent
  | SubEquipmentCreatedEvent
  | SubEquipmentUpdatedEvent
  | SubEquipmentDeletedEvent
  | FeederCalibrationsSavedEvent
  | FeedingProtocolAssignedEvent
  | FeedingProtocolAssignmentPausedEvent
  | UnitFeederAssignmentsChangedEvent
  | MealWindowUpcomingEvent
  | MealFedEvent
  | MealSkippedEvent
  | MealUnderfedEvent
  | FeedStockoutForecastEvent
  | FeedTransitionUpcomingEvent
  | MealMissedEvent
  | FeedTypeTransitionedEvent
  | UnfedUnitDetectedEvent
  | FeedingDailySummaryEvent
  | FeedInventoryLowEvent
  | WelfareEventReportedEvent
  | EscapeReportedEvent
  | EscapeIncidentRecordedEvent
  | DiseaseOutbreakReportedEvent
  | MortalityAlertRaisedEvent
  | HarvestRegulatoryRecordedEvent
  | RegulatoryReportSubmissionFailedEvent
  | RegulatoryReportDeadlineApproachingEvent
  | TankClearedEvent
  | BatchProductionCompletedEvent;
