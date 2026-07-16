import type { JSONSchemaType } from 'ajv';
import { MORTALITY_REASONS, CULL_REASONS } from '../farm-events';
import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  UUID_SCHEMA,
  OPTIONAL_UUID_SCHEMA,
  MAX_FREE_TEXT_LENGTH,
  MAX_SHORT_CODE_LENGTH,
} from './common.schema';

/**
 * @module FarmEventSchemas
 *
 * JSON Schema definitions for the 10 farm domain events forwarded by
 * `FarmNatsBridgeService` to `FarmGateway`. The bridge validates
 * every inbound NATS payload against the matching schema before
 * dispatching to a broadcast method — any unknown field, malformed
 * UUID, or over-length free-text string causes the event to be
 * dropped with a warn log.
 *
 * # What this closes — H-3 "trusted-source XSS footgun"
 *
 * The comprehensive review flagged that the bridge forwarded event
 * payloads verbatim to the gateway, which then reflected them into
 * the React Query cache on the frontend. Fields like
 * `MortalityRecordedEvent.reason`, `CullRecordedEvent.detail`, and
 * `BatchClosedEvent.closeReason` were uncapped strings — safe today
 * because the frontend performs prefix invalidation (no raw HTML
 * rendering), but a footgun for the next hook iteration. A contributor
 * adding a `<div dangerouslySetInnerHTML>` would turn the same path
 * into a trusted-source XSS sink.
 *
 * The fix is not "trust the frontend to escape later" — the fix is
 * to validate at the bridge so the unsafe shape CANNOT reach the
 * frontend. Fail-closed at the earliest trust boundary.
 *
 * # Strict mode — additionalProperties: false
 *
 * Every schema has `additionalProperties: false`. This rejects any
 * field not declared in the schema, blocking a category of attacks
 * where a publisher adds a rogue field (e.g. `htmlPayload`) that the
 * gateway then forwards to clients unchanged.
 *
 * # Type inference
 *
 * AJV's `JSONSchemaType<T>` generic ties a schema to a TypeScript
 * type at compile time — if the schema drifts from the interface
 * (renamed field, type mismatch), tsc fails the build. This catches
 * the contract-drift class of bugs described in Phase 1A H-4 / H-7
 * of the review.
 *
 * @see common.schema.ts for shared fragments (BaseEvent, UUID, caps)
 * @see validator.ts for the compiled ajv factory
 */

// ============================================================================
// Inline wire-format interfaces
// ============================================================================
//
// Each event schema is tied to a local interface that mirrors the
// TypeScript contract from farm-events.ts with one correction:
// `timestamp` (and every Date-valued domain field) is `string` here,
// because after JSON.parse the wire format carries ISO 8601 strings,
// NOT Date objects. The application-layer contract lies about this
// (C3 in the review); the schema documents the truth.
//
// Optional fields declare `undefined` as a possible value so AJV's
// `JSONSchemaType` allows them in the generic, mirroring the `?:`
// optional syntax in the TypeScript contract.

interface WireBaseEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  tenantId: string;
  version: number;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
}

interface WireSetupBaseEvent extends WireBaseEvent {
  aggregateId: string;
  aggregateType: string;
}

interface WireBatchCreated extends WireBaseEvent {
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

interface WireBatchHarvested extends WireBaseEvent {
  eventType: 'BatchHarvested';
  batchId: string;
  farmId?: string;
  pondId?: string;
  siteId?: string;
  harvestedQuantity: number;
  harvestedAt: string;
  averageWeight?: number;
  totalWeight?: number;
  isFinal?: boolean;
}

interface WireBatchStatusChanged extends WireBaseEvent {
  eventType: 'BatchStatusChanged';
  batchId: string;
  farmId?: string;
  siteId?: string;
  previousStatus: string;
  newStatus: string;
  reason?: string;
}

interface WireBatchClosed extends WireBaseEvent {
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

interface WireBatchAllocatedToTank extends WireBaseEvent {
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

interface WireMortalityRecorded extends WireBaseEvent {
  eventType: 'MortalityRecorded';
  batchId: string;
  farmId?: string;
  siteId?: string;
  tankId?: string;
  quantity: number;
  reason: (typeof MORTALITY_REASONS)[number];
  mortalityDate: string;
  newTotalMortality: number;
  newMortalityRate: number;
}

interface WireCullRecorded extends WireBaseEvent {
  eventType: 'CullRecorded';
  batchId: string;
  farmId?: string;
  siteId?: string;
  tankId?: string;
  quantity: number;
  reason: (typeof CULL_REASONS)[number];
  detail?: string;
  culledAt: string;
  newCullCount: number;
  newCurrentQuantity: number;
}

interface WireBatchTransferred extends WireBaseEvent {
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

interface WireFeedingRecorded extends WireBaseEvent {
  eventType: 'FeedingRecorded';
  batchId: string;
  tankId?: string;
  feedId: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  feedingDate: string;
  feedingTime: string;
  variance: number;
  feedCost?: string;
  currency?: string;
  mealId?: string;
  pourIndex?: number;
  dayPlanId?: string;
  unitId?: string;
}

interface WireFeedInventoryLow extends WireBaseEvent {
  eventType: 'FeedInventoryLow';
  inventoryId: string;
  feedId: string;
  siteId: string;
  farmId?: string;
  currentQuantityKg: number;
  reorderPointKg: number;
  status: 'low_stock' | 'critical';
}

/**
 * Storage-ledger low-stock signal (stock SSoT Phase 1). Emitted by the
 * single inventory-mutation sink (`StockMovementService.recordMovement`)
 * whenever an OUT/WASTE movement leaves the item's aggregate quantity at
 * or below its `minStock` — regardless of which caller (manual movement,
 * feeding deduction, adjustment) triggered the movement. Successor of the
 * legacy `FeedInventoryLow` (which only fired from the feed_inventory
 * branch); both are bridged during the migration window.
 */
interface WireLowStockDetected extends WireBaseEvent {
  eventType: 'LowStockDetected';
  itemType: 'feed' | 'chemical' | 'consumable' | 'healthcare';
  itemId: string;
  itemName: string;
  currentQuantity: number;
  unit: string;
  minimumThreshold?: number;
  severity: 'low_stock' | 'out_of_stock';
}

interface WireFeedingProtocolAssigned extends WireBaseEvent {
  eventType: 'FeedingProtocolAssigned';
  userId?: string;
  assignmentId: string;
  unitId: string;
  unitType: 'tank' | 'pond' | 'cage';
  unitCode: string;
  siteId: string;
  protocolId: string;
  protocolName: string;
  replacedAssignmentId?: string;
  speciesMismatchReason?: string;
}

interface WireFeedingProtocolAssignmentPaused extends WireBaseEvent {
  eventType: 'FeedingProtocolAssignmentPaused';
  userId?: string;
  assignmentId: string;
  unitId: string;
  unitCode: string;
  protocolId: string;
  reason: 'protocol_archived' | 'operator_paused' | 'unit_emptied';
}

// ── Meal engine wire shapes (Faz 5 — plan §7/§10) ──────────────────────────

interface WireMealWindowEntry {
  unitId: string;
  unitCode: string;
  dayPlanId: string;
  mealId: string;
  mealIndex: number;
  scheduledAt: string;
  feedId: string;
  plannedKg: number;
  protocolId: string;
  minDissolvedOxygen?: number;
  lowOxygenReductionPercent?: number;
}

interface WireMealWindowUpcoming extends WireBaseEvent {
  eventType: 'MealWindowUpcoming';
  windowStart: string;
  windowEnd: string;
  leadMinutes: number;
  batchIndex: number;
  batchCount: number;
  meals: WireMealWindowEntry[];
}

interface WireMealFed extends WireBaseEvent {
  eventType: 'MealFed';
  unitId: string;
  mealId: string;
  dayPlanId: string;
  feedId: string;
  pourIndex: number;
  pourKg: number;
  actualKg: number;
  fedAt: string;
  feedingMethod?: string;
}

interface WireMealSkipped extends WireBaseEvent {
  eventType: 'MealSkipped';
  unitId: string;
  mealId: string;
  dayPlanId: string;
  reason: string;
  skippedAt: string;
}

interface WireMealUnderfed extends WireBaseEvent {
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

interface WireMealMissed extends WireBaseEvent {
  eventType: 'MealMissed';
  unitId: string;
  unitCode: string;
  mealId: string;
  dayPlanId: string;
  scheduledAt: string;
}

interface WireFeedTypeTransitioned extends WireBaseEvent {
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

interface WireUnfedUnitDetected extends WireBaseEvent {
  eventType: 'UnfedUnitDetected';
  unitId: string;
  unitCode: string;
  siteId: string;
  reason: 'no_assignment' | 'assignment_paused' | 'draft_protocol';
  fishCount: number;
  biomassKg: number;
}

/**
 * FCRAlert bugüne dek yalnız in-process yayılıyordu (doğrulandı — C-1);
 * 18:00 cron'u Faz 5'te İLK KEZ outbox'a yazar → tel şeması burada başlar.
 */
interface WireFCRAlert extends WireBaseEvent {
  eventType: 'FCRAlert';
  batchId: string;
  currentFCR: number;
  targetFCR: number;
  variancePercent: number;
  trend: 'improving' | 'stable' | 'declining';
  alertLevel: 'warning' | 'critical';
}

interface WireFeedingDailySummary extends WireBaseEvent {
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

// ── Harvest / mortality follow-up wire shapes ──────────────────────────────
// `recordedAt`/`harvestedAt`/`clearedAt`/`completedAt` are ISO strings on the
// wire (Date in the TS contract; JSON has no Date type — see file header).

interface WireMortalityAlertRaised extends WireBaseEvent {
  eventType: 'MortalityAlertRaised';
  batchId: string;
  tankId?: string;
  alertType: 'single_event' | 'daily_rate' | 'cumulative_rate';
  severity: 'warning' | 'critical';
  message: string;
  mortalityRate: number;
  reason: (typeof MORTALITY_REASONS)[number];
  recordedAt: string;
}

interface WireHarvestRegulatoryRecorded extends WireBaseEvent {
  eventType: 'HarvestRegulatoryRecorded';
  batchId: string;
  harvestedQuantity: number;
  totalWeight?: number;
  averageWeight?: number;
  harvestedAt: string;
  harvestedBy?: string;
  isFinal: boolean;
}

interface WireTankCleared extends WireBaseEvent {
  eventType: 'TankCleared';
  tankId: string;
  tankCode?: string;
  previousBatchId: string;
  clearedAt: string;
}

interface WireBatchProductionCompleted extends WireBaseEvent {
  eventType: 'BatchProductionCompleted';
  batchId: string;
  initialQuantity: number;
  harvestedQuantity: number;
  harvestedBiomassKg: number;
  avgWeightG: number;
  survivalRate: number;
  mortalityRate: number;
  daysInProduction: number;
  fcr: number;
  sgr: number;
  totalFeedConsumedKg: number;
  completedAt: string;
}

interface WireSiteCreated extends WireSetupBaseEvent {
  eventType: 'SiteCreated';
  siteId: string;
  name: string;
  code: string;
  country: string;
  region?: string;
  status: string;
}

interface WireSiteUpdated extends WireSetupBaseEvent {
  eventType: 'SiteUpdated';
  siteId: string;
  name?: string;
  code?: string;
  status?: string;
}

interface WireSiteDeleted extends WireSetupBaseEvent {
  eventType: 'SiteDeleted';
  siteId: string;
  name: string;
  code: string;
  deletedAt: string;
}

interface WireDepartmentCreated extends WireSetupBaseEvent {
  eventType: 'DepartmentCreated';
  departmentId: string;
  siteId: string;
  name: string;
  code: string;
  type: string;
}

interface WireDepartmentUpdated extends WireSetupBaseEvent {
  eventType: 'DepartmentUpdated';
  departmentId: string;
  siteId: string;
  name?: string;
}

interface WireDepartmentDeleted extends WireSetupBaseEvent {
  eventType: 'DepartmentDeleted';
  departmentId: string;
  siteId: string;
  name: string;
  code: string;
  deletedAt: string;
}

interface WireSystemCreated extends WireSetupBaseEvent {
  eventType: 'SystemCreated';
  systemId: string;
  siteId: string;
  departmentId?: string;
  name: string;
  code: string;
  type: string;
  status: string;
}

interface WireSystemUpdated extends WireSetupBaseEvent {
  eventType: 'SystemUpdated';
  systemId: string;
  siteId: string;
  name?: string;
  status?: string;
}

interface WireSystemDeleted extends WireSetupBaseEvent {
  eventType: 'SystemDeleted';
  systemId: string;
  siteId: string;
  name: string;
  code: string;
  deletedAt: string;
}

interface WireSiteContactsChanged extends WireSetupBaseEvent {
  eventType: 'SiteContactsChanged';
  siteId: string;
  previousContactCount: number;
  newContactCount: number;
  primaryContactChanged: boolean;
  changedBy: string;
}

interface WireTankCreated extends WireSetupBaseEvent {
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

interface WireTankUpdated extends WireSetupBaseEvent {
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

interface WireTankStatusChanged extends WireSetupBaseEvent {
  eventType: 'TankStatusChanged';
  tankId: string;
  previousStatus: string;
  newStatus: string;
  reason?: string;
  changedAt: string;
}

interface WireTankDeleted extends WireSetupBaseEvent {
  eventType: 'TankDeleted';
  tankId: string;
  departmentId: string;
  name: string;
  code: string;
  deletedAt: string;
}

interface WireEquipmentCreated extends WireSetupBaseEvent {
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

interface WireEquipmentUpdated extends WireSetupBaseEvent {
  eventType: 'EquipmentUpdated';
  equipmentId: string;
  siteId?: string;
  name?: string;
  status?: string;
}

interface WireEquipmentDeleted extends WireSetupBaseEvent {
  eventType: 'EquipmentDeleted';
  equipmentId: string;
  siteId?: string;
  name: string;
  code: string;
  deletedAt: string;
}

interface WireSubEquipmentCreated extends WireSetupBaseEvent {
  eventType: 'SubEquipmentCreated';
  subEquipmentId: string;
  parentEquipmentId: string;
  name: string;
  code: string;
  status: string;
}

interface WireSubEquipmentUpdated extends WireSetupBaseEvent {
  eventType: 'SubEquipmentUpdated';
  subEquipmentId: string;
  parentEquipmentId: string;
  name?: string;
  status?: string;
}

interface WireSubEquipmentDeleted extends WireSetupBaseEvent {
  eventType: 'SubEquipmentDeleted';
  subEquipmentId: string;
  parentEquipmentId: string;
  name: string;
  code: string;
  deletedAt: string;
}

interface WireSupplierApprovedSitesChanged extends WireSetupBaseEvent {
  eventType: 'SupplierApprovedSitesChanged';
  supplierId: string;
  previousSiteIds: string[];
  newSiteIds: string[];
  previousPreferredSiteId: string | null;
  newPreferredSiteId: string | null;
  changedBy: string;
}

interface WireFeederCalibrationsSaved extends WireSetupBaseEvent {
  eventType: 'FeederCalibrationsSaved';
  equipmentId: string;
  calibrationCount: number;
  feedSizeMm: number[];
  changedBy: string;
}

// ============================================================================
// Schemas
// ============================================================================

/**
 * Common schema options applied to every event schema via `...`.
 * Keeps `type: 'object'` and `additionalProperties: false` consistent
 * without repeating them in 10 places.
 */
const EVENT_OBJECT_OPTS = {
  type: 'object' as const,
  additionalProperties: false as const,
};

/**
 * Non-negative integer — used for `quantity`, `newTotalMortality`,
 * `newCullCount`, etc. 2^53 - 1 upper bound is the JS safe integer
 * ceiling; in practice these counts are <1e9.
 */
const NON_NEGATIVE_INT = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

/** Non-negative number (allows decimals) for kg weights, FCRs, rates. */
const NON_NEGATIVE_NUMBER = {
  type: 'number',
  minimum: 0,
} as const;

/** Short free-form string with a safe upper bound (reasons, detail). */
const FREE_TEXT = {
  type: 'string',
  maxLength: MAX_FREE_TEXT_LENGTH,
} as const;

const SHORT_CODE = {
  type: 'string',
  maxLength: MAX_SHORT_CODE_LENGTH,
} as const;

const NON_EMPTY_STRING = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_FREE_TEXT_LENGTH,
} as const;

const ISO_DATE_STRING = {
  type: 'string',
  format: 'date-time',
} as const;

const NULL_VALUE = {
  type: 'null',
  nullable: true,
} as const;

const NULLABLE_UUID = {
  anyOf: [UUID_SCHEMA, NULL_VALUE],
} as const;

const SETUP_EVENT_PROPERTIES = {
  ...BASE_EVENT_PROPERTIES,
  aggregateId: SHORT_CODE,
  aggregateType: SHORT_CODE,
} as const;

const SETUP_EVENT_REQUIRED = [...BASE_EVENT_REQUIRED, 'aggregateId', 'aggregateType'] as const;

const UUID_ARRAY = {
  type: 'array',
  items: UUID_SCHEMA,
  maxItems: 500,
} as const;

export const batchCreatedSchema: JSONSchemaType<WireBatchCreated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'BatchCreated' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    pondId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    tankIds: {
      type: 'array',
      items: UUID_SCHEMA,
      maxItems: 100,
      nullable: true,
    },
    name: NON_EMPTY_STRING,
    species: NON_EMPTY_STRING,
    quantity: NON_NEGATIVE_INT,
    stockedAt: ISO_DATE_STRING,
  },
  required: [...BASE_EVENT_REQUIRED, 'batchId', 'name', 'species', 'quantity', 'stockedAt'],
};

export const batchHarvestedSchema: JSONSchemaType<WireBatchHarvested> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'BatchHarvested' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    pondId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    harvestedQuantity: NON_NEGATIVE_INT,
    harvestedAt: ISO_DATE_STRING,
    averageWeight: { ...NON_NEGATIVE_NUMBER, nullable: true },
    totalWeight: { ...NON_NEGATIVE_NUMBER, nullable: true },
    // v2 additive (optional): in properties so a v2 event passes
    // additionalProperties:false, but NOT in `required` so v1 events
    // (no isFinal) still validate under this one schema.
    isFinal: { type: 'boolean', nullable: true },
  },
  required: [...BASE_EVENT_REQUIRED, 'batchId', 'harvestedQuantity', 'harvestedAt'],
};

export const batchStatusChangedSchema: JSONSchemaType<WireBatchStatusChanged> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'BatchStatusChanged' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    previousStatus: SHORT_CODE,
    newStatus: SHORT_CODE,
    reason: { ...FREE_TEXT, nullable: true },
  },
  required: [...BASE_EVENT_REQUIRED, 'batchId', 'previousStatus', 'newStatus'],
};

export const batchClosedSchema: JSONSchemaType<WireBatchClosed> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'BatchClosed' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    closeReason: FREE_TEXT,
    finalQuantity: NON_NEGATIVE_INT,
    finalBiomassKg: NON_NEGATIVE_NUMBER,
    finalFCR: NON_NEGATIVE_NUMBER,
    totalMortality: NON_NEGATIVE_INT,
    mortalityRate: NON_NEGATIVE_NUMBER,
    daysInProduction: NON_NEGATIVE_INT,
    closedAt: ISO_DATE_STRING,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'closeReason',
    'finalQuantity',
    'finalBiomassKg',
    'finalFCR',
    'totalMortality',
    'mortalityRate',
    'daysInProduction',
    'closedAt',
  ],
};

export const batchAllocatedToTankSchema: JSONSchemaType<WireBatchAllocatedToTank> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'BatchAllocatedToTank' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    tankId: UUID_SCHEMA,
    quantity: NON_NEGATIVE_INT,
    biomassKg: NON_NEGATIVE_NUMBER,
    allocationType: {
      type: 'string',
      enum: ['initial', 'transfer_in', 'split'],
    },
    allocationDate: ISO_DATE_STRING,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'tankId',
    'quantity',
    'biomassKg',
    'allocationType',
    'allocationDate',
  ],
};

export const mortalityRecordedSchema: JSONSchemaType<WireMortalityRecorded> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MortalityRecorded' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    tankId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    quantity: NON_NEGATIVE_INT,
    reason: {
      type: 'string',
      enum: [...MORTALITY_REASONS],
    },
    mortalityDate: ISO_DATE_STRING,
    newTotalMortality: NON_NEGATIVE_INT,
    newMortalityRate: NON_NEGATIVE_NUMBER,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'quantity',
    'reason',
    'mortalityDate',
    'newTotalMortality',
    'newMortalityRate',
  ],
};

export const cullRecordedSchema: JSONSchemaType<WireCullRecorded> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'CullRecorded' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    tankId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    quantity: NON_NEGATIVE_INT,
    reason: {
      type: 'string',
      enum: [...CULL_REASONS],
    },
    detail: { ...FREE_TEXT, nullable: true },
    culledAt: ISO_DATE_STRING,
    newCullCount: NON_NEGATIVE_INT,
    newCurrentQuantity: NON_NEGATIVE_INT,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'quantity',
    'reason',
    'culledAt',
    'newCullCount',
    'newCurrentQuantity',
  ],
};

export const batchTransferredSchema: JSONSchemaType<WireBatchTransferred> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'BatchTransferred' },
    batchId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    sourceTankId: UUID_SCHEMA,
    destinationTankId: UUID_SCHEMA,
    quantity: NON_NEGATIVE_INT,
    biomassKg: NON_NEGATIVE_NUMBER,
    transferDate: ISO_DATE_STRING,
    reason: { ...FREE_TEXT, nullable: true },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'sourceTankId',
    'destinationTankId',
    'quantity',
    'biomassKg',
    'transferDate',
  ],
};

export const feedingRecordedSchema: JSONSchemaType<WireFeedingRecorded> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeedingRecorded' },
    batchId: UUID_SCHEMA,
    tankId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    feedId: UUID_SCHEMA,
    plannedAmountKg: NON_NEGATIVE_NUMBER,
    actualAmountKg: NON_NEGATIVE_NUMBER,
    feedingDate: ISO_DATE_STRING,
    feedingTime: SHORT_CODE,
    variance: { type: 'number' },
    // Additive monetary fields (finance capability). String-encoded
    // decimal per HR-MEDIUM-001 — a wire `number` is rejected.
    feedCost: {
      type: 'string',
      pattern: '^\\d{1,13}(\\.\\d{1,2})?$',
      nullable: true,
    },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', nullable: true },
    // Öğün motoru v2 bağları (Faz 5, additive) — additionalProperties:false
    // olduğundan wire şemasına AÇIKÇA eklenir (C-13); upcaster gerekmez.
    mealId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    pourIndex: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, nullable: true },
    dayPlanId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    unitId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'feedId',
    'plannedAmountKg',
    'actualAmountKg',
    'feedingDate',
    'feedingTime',
    'variance',
  ],
};

export const feedInventoryLowSchema: JSONSchemaType<WireFeedInventoryLow> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeedInventoryLow' },
    inventoryId: UUID_SCHEMA,
    feedId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    farmId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    currentQuantityKg: NON_NEGATIVE_NUMBER,
    reorderPointKg: NON_NEGATIVE_NUMBER,
    status: { type: 'string', enum: ['low_stock', 'critical'] },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'inventoryId',
    'feedId',
    'siteId',
    'currentQuantityKg',
    'reorderPointKg',
    'status',
  ],
};

export const lowStockDetectedSchema: JSONSchemaType<WireLowStockDetected> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'LowStockDetected' },
    itemType: {
      type: 'string',
      enum: ['feed', 'chemical', 'consumable', 'healthcare'],
    },
    itemId: UUID_SCHEMA,
    itemName: FREE_TEXT,
    currentQuantity: NON_NEGATIVE_NUMBER,
    unit: SHORT_CODE,
    minimumThreshold: { ...NON_NEGATIVE_NUMBER, nullable: true },
    severity: { type: 'string', enum: ['low_stock', 'out_of_stock'] },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'itemType',
    'itemId',
    'itemName',
    'currentQuantity',
    'unit',
    'severity',
  ],
};

export const feedingProtocolAssignedSchema: JSONSchemaType<WireFeedingProtocolAssigned> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeedingProtocolAssigned' },
    userId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    assignmentId: UUID_SCHEMA,
    unitId: UUID_SCHEMA,
    unitType: { type: 'string', enum: ['tank', 'pond', 'cage'] },
    unitCode: SHORT_CODE,
    siteId: UUID_SCHEMA,
    protocolId: UUID_SCHEMA,
    protocolName: FREE_TEXT,
    replacedAssignmentId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    speciesMismatchReason: { ...FREE_TEXT, nullable: true },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'assignmentId',
    'unitId',
    'unitType',
    'unitCode',
    'siteId',
    'protocolId',
    'protocolName',
  ],
};

export const feedingProtocolAssignmentPausedSchema: JSONSchemaType<WireFeedingProtocolAssignmentPaused> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeedingProtocolAssignmentPaused' },
    userId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    assignmentId: UUID_SCHEMA,
    unitId: UUID_SCHEMA,
    unitCode: SHORT_CODE,
    protocolId: UUID_SCHEMA,
    reason: { type: 'string', enum: ['protocol_archived', 'operator_paused', 'unit_emptied'] },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'assignmentId',
    'unitId',
    'unitCode',
    'protocolId',
    'reason',
  ],
};

// ── Meal engine schemas (Faz 5 — hepsi farm→NATS trust boundary, C-13) ─────

/** Toplu pencere event'inin girdi cap'i (K-2 — şekil kararının parçası). */
const MEAL_WINDOW_MAX_ENTRIES = 500;

export const mealWindowUpcomingSchema: JSONSchemaType<WireMealWindowUpcoming> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MealWindowUpcoming' },
    windowStart: ISO_DATE_STRING,
    windowEnd: ISO_DATE_STRING,
    leadMinutes: NON_NEGATIVE_INT,
    batchIndex: NON_NEGATIVE_INT,
    batchCount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    meals: {
      type: 'array',
      maxItems: MEAL_WINDOW_MAX_ENTRIES,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          unitId: UUID_SCHEMA,
          unitCode: SHORT_CODE,
          dayPlanId: UUID_SCHEMA,
          mealId: UUID_SCHEMA,
          mealIndex: NON_NEGATIVE_INT,
          scheduledAt: ISO_DATE_STRING,
          feedId: UUID_SCHEMA,
          plannedKg: NON_NEGATIVE_NUMBER,
          protocolId: UUID_SCHEMA,
          minDissolvedOxygen: { ...NON_NEGATIVE_NUMBER, nullable: true },
          lowOxygenReductionPercent: { ...NON_NEGATIVE_NUMBER, nullable: true },
        },
        required: [
          'unitId',
          'unitCode',
          'dayPlanId',
          'mealId',
          'mealIndex',
          'scheduledAt',
          'feedId',
          'plannedKg',
          'protocolId',
        ],
      },
    },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'windowStart',
    'windowEnd',
    'leadMinutes',
    'batchIndex',
    'batchCount',
    'meals',
  ],
};

export const mealFedSchema: JSONSchemaType<WireMealFed> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MealFed' },
    unitId: UUID_SCHEMA,
    mealId: UUID_SCHEMA,
    dayPlanId: UUID_SCHEMA,
    feedId: UUID_SCHEMA,
    pourIndex: NON_NEGATIVE_INT,
    pourKg: NON_NEGATIVE_NUMBER,
    actualKg: NON_NEGATIVE_NUMBER,
    fedAt: ISO_DATE_STRING,
    feedingMethod: { ...SHORT_CODE, nullable: true },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'unitId',
    'mealId',
    'dayPlanId',
    'feedId',
    'pourIndex',
    'pourKg',
    'actualKg',
    'fedAt',
  ],
};

export const mealSkippedSchema: JSONSchemaType<WireMealSkipped> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MealSkipped' },
    unitId: UUID_SCHEMA,
    mealId: UUID_SCHEMA,
    dayPlanId: UUID_SCHEMA,
    reason: FREE_TEXT,
    skippedAt: ISO_DATE_STRING,
  },
  required: [...BASE_EVENT_REQUIRED, 'unitId', 'mealId', 'dayPlanId', 'reason', 'skippedAt'],
};

export const mealUnderfedSchema: JSONSchemaType<WireMealUnderfed> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MealUnderfed' },
    scope: { type: 'string', enum: ['meal', 'day'] },
    unitId: UUID_SCHEMA,
    unitCode: SHORT_CODE,
    dayPlanId: UUID_SCHEMA,
    mealId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    plannedKg: NON_NEGATIVE_NUMBER,
    actualKg: NON_NEGATIVE_NUMBER,
    variancePercent: { type: 'number' },
    thresholdPercent: NON_NEGATIVE_NUMBER,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'scope',
    'unitId',
    'unitCode',
    'dayPlanId',
    'plannedKg',
    'actualKg',
    'variancePercent',
    'thresholdPercent',
  ],
};

export const mealMissedSchema: JSONSchemaType<WireMealMissed> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MealMissed' },
    unitId: UUID_SCHEMA,
    unitCode: SHORT_CODE,
    mealId: UUID_SCHEMA,
    dayPlanId: UUID_SCHEMA,
    scheduledAt: ISO_DATE_STRING,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'unitId',
    'unitCode',
    'mealId',
    'dayPlanId',
    'scheduledAt',
  ],
};

export const feedTypeTransitionedSchema: JSONSchemaType<WireFeedTypeTransitioned> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeedTypeTransitioned' },
    unitId: UUID_SCHEMA,
    unitCode: SHORT_CODE,
    assignmentId: UUID_SCHEMA,
    fromFeedId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    toFeedId: UUID_SCHEMA,
    toFeedCode: SHORT_CODE,
    bandIndex: NON_NEGATIVE_INT,
    avgWeightG: NON_NEGATIVE_NUMBER,
    automatic: { type: 'boolean' },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'unitId',
    'unitCode',
    'assignmentId',
    'toFeedId',
    'toFeedCode',
    'bandIndex',
    'avgWeightG',
    'automatic',
  ],
};

export const unfedUnitDetectedSchema: JSONSchemaType<WireUnfedUnitDetected> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'UnfedUnitDetected' },
    unitId: UUID_SCHEMA,
    unitCode: SHORT_CODE,
    siteId: UUID_SCHEMA,
    reason: { type: 'string', enum: ['no_assignment', 'assignment_paused', 'draft_protocol'] },
    fishCount: NON_NEGATIVE_INT,
    biomassKg: NON_NEGATIVE_NUMBER,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'unitId',
    'unitCode',
    'siteId',
    'reason',
    'fishCount',
    'biomassKg',
  ],
};

export const fcrAlertSchema: JSONSchemaType<WireFCRAlert> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FCRAlert' },
    batchId: UUID_SCHEMA,
    currentFCR: NON_NEGATIVE_NUMBER,
    targetFCR: NON_NEGATIVE_NUMBER,
    variancePercent: { type: 'number' },
    trend: { type: 'string', enum: ['improving', 'stable', 'declining'] },
    alertLevel: { type: 'string', enum: ['warning', 'critical'] },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'currentFCR',
    'targetFCR',
    'variancePercent',
    'trend',
    'alertLevel',
  ],
};

export const feedingDailySummarySchema: JSONSchemaType<WireFeedingDailySummary> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeedingDailySummary' },
    planDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    unitsPlanned: NON_NEGATIVE_INT,
    unitsCompleted: NON_NEGATIVE_INT,
    unitsSkipped: NON_NEGATIVE_INT,
    plannedTotalKg: NON_NEGATIVE_NUMBER,
    actualTotalKg: NON_NEGATIVE_NUMBER,
    underfedUnitCount: NON_NEGATIVE_INT,
    missedMealCount: NON_NEGATIVE_INT,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'planDate',
    'unitsPlanned',
    'unitsCompleted',
    'unitsSkipped',
    'plannedTotalKg',
    'actualTotalKg',
    'underfedUnitCount',
    'missedMealCount',
  ],
};

// ── Harvest / mortality follow-up schemas ──────────────────────────────────

export const mortalityAlertRaisedSchema: JSONSchemaType<WireMortalityAlertRaised> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MortalityAlertRaised' },
    batchId: UUID_SCHEMA,
    tankId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    alertType: {
      type: 'string',
      enum: ['single_event', 'daily_rate', 'cumulative_rate'],
    },
    severity: { type: 'string', enum: ['warning', 'critical'] },
    message: FREE_TEXT,
    mortalityRate: NON_NEGATIVE_NUMBER,
    reason: { type: 'string', enum: [...MORTALITY_REASONS] },
    recordedAt: ISO_DATE_STRING,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'alertType',
    'severity',
    'message',
    'mortalityRate',
    'reason',
    'recordedAt',
  ],
};

export const harvestRegulatoryRecordedSchema: JSONSchemaType<WireHarvestRegulatoryRecorded> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'HarvestRegulatoryRecorded' },
      batchId: UUID_SCHEMA,
      harvestedQuantity: NON_NEGATIVE_INT,
      totalWeight: { ...NON_NEGATIVE_NUMBER, nullable: true },
      averageWeight: { ...NON_NEGATIVE_NUMBER, nullable: true },
      harvestedAt: ISO_DATE_STRING,
      // harvestedBy is the operator's user id (BaseEvent.userId on the trigger) —
      // a short opaque identifier, not a UUID in every auth backend, so SHORT_CODE.
      harvestedBy: { ...SHORT_CODE, nullable: true },
      isFinal: { type: 'boolean' },
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'batchId',
      'harvestedQuantity',
      'harvestedAt',
      'isFinal',
    ],
  };

export const tankClearedSchema: JSONSchemaType<WireTankCleared> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'TankCleared' },
    tankId: UUID_SCHEMA,
    tankCode: { ...SHORT_CODE, nullable: true },
    previousBatchId: UUID_SCHEMA,
    clearedAt: ISO_DATE_STRING,
  },
  required: [...BASE_EVENT_REQUIRED, 'tankId', 'previousBatchId', 'clearedAt'],
};

export const batchProductionCompletedSchema: JSONSchemaType<WireBatchProductionCompleted> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'BatchProductionCompleted' },
      batchId: UUID_SCHEMA,
      initialQuantity: NON_NEGATIVE_INT,
      harvestedQuantity: NON_NEGATIVE_INT,
      harvestedBiomassKg: NON_NEGATIVE_NUMBER,
      avgWeightG: NON_NEGATIVE_NUMBER,
      survivalRate: NON_NEGATIVE_NUMBER,
      mortalityRate: NON_NEGATIVE_NUMBER,
      daysInProduction: NON_NEGATIVE_INT,
      fcr: NON_NEGATIVE_NUMBER,
      sgr: NON_NEGATIVE_NUMBER,
      totalFeedConsumedKg: NON_NEGATIVE_NUMBER,
      completedAt: ISO_DATE_STRING,
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'batchId',
      'initialQuantity',
      'harvestedQuantity',
      'harvestedBiomassKg',
      'avgWeightG',
      'survivalRate',
      'mortalityRate',
      'daysInProduction',
      'fcr',
      'sgr',
      'totalFeedConsumedKg',
      'completedAt',
    ],
  };

export const siteCreatedSchema: JSONSchemaType<WireSiteCreated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SiteCreated' },
    siteId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    country: SHORT_CODE,
    region: { ...FREE_TEXT, nullable: true },
    status: SHORT_CODE,
  },
  required: [...SETUP_EVENT_REQUIRED, 'siteId', 'name', 'code', 'country', 'status'],
};

export const siteUpdatedSchema: JSONSchemaType<WireSiteUpdated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SiteUpdated' },
    siteId: UUID_SCHEMA,
    name: { ...NON_EMPTY_STRING, nullable: true },
    code: { ...SHORT_CODE, nullable: true },
    status: { ...SHORT_CODE, nullable: true },
  },
  required: [...SETUP_EVENT_REQUIRED, 'siteId'],
};

export const siteDeletedSchema: JSONSchemaType<WireSiteDeleted> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SiteDeleted' },
    siteId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    deletedAt: ISO_DATE_STRING,
  },
  required: [...SETUP_EVENT_REQUIRED, 'siteId', 'name', 'code', 'deletedAt'],
};

export const departmentCreatedSchema: JSONSchemaType<WireDepartmentCreated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'DepartmentCreated' },
    departmentId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    type: SHORT_CODE,
  },
  required: [...SETUP_EVENT_REQUIRED, 'departmentId', 'siteId', 'name', 'code', 'type'],
};

export const departmentUpdatedSchema: JSONSchemaType<WireDepartmentUpdated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'DepartmentUpdated' },
    departmentId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    name: { ...NON_EMPTY_STRING, nullable: true },
  },
  required: [...SETUP_EVENT_REQUIRED, 'departmentId', 'siteId'],
};

export const departmentDeletedSchema: JSONSchemaType<WireDepartmentDeleted> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'DepartmentDeleted' },
    departmentId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    deletedAt: ISO_DATE_STRING,
  },
  required: [...SETUP_EVENT_REQUIRED, 'departmentId', 'siteId', 'name', 'code', 'deletedAt'],
};

export const systemCreatedSchema: JSONSchemaType<WireSystemCreated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SystemCreated' },
    systemId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    departmentId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    type: SHORT_CODE,
    status: SHORT_CODE,
  },
  required: [...SETUP_EVENT_REQUIRED, 'systemId', 'siteId', 'name', 'code', 'type', 'status'],
};

export const systemUpdatedSchema: JSONSchemaType<WireSystemUpdated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SystemUpdated' },
    systemId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    name: { ...NON_EMPTY_STRING, nullable: true },
    status: { ...SHORT_CODE, nullable: true },
  },
  required: [...SETUP_EVENT_REQUIRED, 'systemId', 'siteId'],
};

export const systemDeletedSchema: JSONSchemaType<WireSystemDeleted> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SystemDeleted' },
    systemId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    deletedAt: ISO_DATE_STRING,
  },
  required: [...SETUP_EVENT_REQUIRED, 'systemId', 'siteId', 'name', 'code', 'deletedAt'],
};

export const siteContactsChangedSchema: JSONSchemaType<WireSiteContactsChanged> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SiteContactsChanged' },
    siteId: UUID_SCHEMA,
    previousContactCount: NON_NEGATIVE_INT,
    newContactCount: NON_NEGATIVE_INT,
    primaryContactChanged: { type: 'boolean' },
    changedBy: UUID_SCHEMA,
  },
  required: [
    ...SETUP_EVENT_REQUIRED,
    'siteId',
    'previousContactCount',
    'newContactCount',
    'primaryContactChanged',
    'changedBy',
  ],
};

export const tankCreatedSchema: JSONSchemaType<WireTankCreated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'TankCreated' },
    tankId: UUID_SCHEMA,
    departmentId: UUID_SCHEMA,
    systemId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    tankType: SHORT_CODE,
    status: SHORT_CODE,
    volume: NON_NEGATIVE_NUMBER,
    maxBiomass: NON_NEGATIVE_NUMBER,
  },
  required: [
    ...SETUP_EVENT_REQUIRED,
    'tankId',
    'departmentId',
    'name',
    'code',
    'tankType',
    'status',
    'volume',
    'maxBiomass',
  ],
};

export const tankUpdatedSchema: JSONSchemaType<WireTankUpdated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'TankUpdated' },
    tankId: UUID_SCHEMA,
    departmentId: UUID_SCHEMA,
    systemId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    name: { ...NON_EMPTY_STRING, nullable: true },
    tankType: { ...SHORT_CODE, nullable: true },
    status: { ...SHORT_CODE, nullable: true },
    volume: { ...NON_NEGATIVE_NUMBER, nullable: true },
    maxBiomass: { ...NON_NEGATIVE_NUMBER, nullable: true },
  },
  required: [...SETUP_EVENT_REQUIRED, 'tankId', 'departmentId'],
};

export const tankStatusChangedSchema: JSONSchemaType<WireTankStatusChanged> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'TankStatusChanged' },
    tankId: UUID_SCHEMA,
    previousStatus: SHORT_CODE,
    newStatus: SHORT_CODE,
    reason: { ...FREE_TEXT, nullable: true },
    changedAt: ISO_DATE_STRING,
  },
  required: [...SETUP_EVENT_REQUIRED, 'tankId', 'previousStatus', 'newStatus', 'changedAt'],
};

export const tankDeletedSchema: JSONSchemaType<WireTankDeleted> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'TankDeleted' },
    tankId: UUID_SCHEMA,
    departmentId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    deletedAt: ISO_DATE_STRING,
  },
  required: [...SETUP_EVENT_REQUIRED, 'tankId', 'departmentId', 'name', 'code', 'deletedAt'],
};

export const equipmentCreatedSchema: JSONSchemaType<WireEquipmentCreated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'EquipmentCreated' },
    equipmentId: UUID_SCHEMA,
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    systemId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    departmentId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    typeId: UUID_SCHEMA,
    category: SHORT_CODE,
    status: SHORT_CODE,
  },
  required: [
    ...SETUP_EVENT_REQUIRED,
    'equipmentId',
    'name',
    'code',
    'typeId',
    'category',
    'status',
  ],
} as const;

export const equipmentUpdatedSchema: JSONSchemaType<WireEquipmentUpdated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'EquipmentUpdated' },
    equipmentId: UUID_SCHEMA,
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    name: { ...NON_EMPTY_STRING, nullable: true },
    status: { ...SHORT_CODE, nullable: true },
  },
  required: [...SETUP_EVENT_REQUIRED, 'equipmentId'],
} as const;

export const equipmentDeletedSchema: JSONSchemaType<WireEquipmentDeleted> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'EquipmentDeleted' },
    equipmentId: UUID_SCHEMA,
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    deletedAt: ISO_DATE_STRING,
  },
  required: [...SETUP_EVENT_REQUIRED, 'equipmentId', 'name', 'code', 'deletedAt'],
} as const;

export const subEquipmentCreatedSchema: JSONSchemaType<WireSubEquipmentCreated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SubEquipmentCreated' },
    subEquipmentId: UUID_SCHEMA,
    parentEquipmentId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    status: SHORT_CODE,
  },
  required: [
    ...SETUP_EVENT_REQUIRED,
    'subEquipmentId',
    'parentEquipmentId',
    'name',
    'code',
    'status',
  ],
} as const;

export const subEquipmentUpdatedSchema: JSONSchemaType<WireSubEquipmentUpdated> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SubEquipmentUpdated' },
    subEquipmentId: UUID_SCHEMA,
    parentEquipmentId: UUID_SCHEMA,
    name: { ...NON_EMPTY_STRING, nullable: true },
    status: { ...SHORT_CODE, nullable: true },
  },
  required: [...SETUP_EVENT_REQUIRED, 'subEquipmentId', 'parentEquipmentId'],
} as const;

export const subEquipmentDeletedSchema: JSONSchemaType<WireSubEquipmentDeleted> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'SubEquipmentDeleted' },
    subEquipmentId: UUID_SCHEMA,
    parentEquipmentId: UUID_SCHEMA,
    name: NON_EMPTY_STRING,
    code: SHORT_CODE,
    deletedAt: ISO_DATE_STRING,
  },
  required: [
    ...SETUP_EVENT_REQUIRED,
    'subEquipmentId',
    'parentEquipmentId',
    'name',
    'code',
    'deletedAt',
  ],
} as const;

export const supplierApprovedSitesChangedSchema: JSONSchemaType<WireSupplierApprovedSitesChanged> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...SETUP_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'SupplierApprovedSitesChanged' },
      supplierId: UUID_SCHEMA,
      previousSiteIds: UUID_ARRAY,
      newSiteIds: UUID_ARRAY,
      previousPreferredSiteId: NULLABLE_UUID,
      newPreferredSiteId: NULLABLE_UUID,
      changedBy: UUID_SCHEMA,
    },
    required: [
      ...SETUP_EVENT_REQUIRED,
      'supplierId',
      'previousSiteIds',
      'newSiteIds',
      'previousPreferredSiteId',
      'newPreferredSiteId',
      'changedBy',
    ],
  };

export const feederCalibrationsSavedSchema: JSONSchemaType<WireFeederCalibrationsSaved> = {
  ...EVENT_OBJECT_OPTS,
  properties: {
    ...SETUP_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeederCalibrationsSaved' },
    equipmentId: UUID_SCHEMA,
    calibrationCount: NON_NEGATIVE_INT,
    feedSizeMm: {
      type: 'array',
      items: NON_NEGATIVE_NUMBER,
      maxItems: 100,
    },
    changedBy: UUID_SCHEMA,
  },
  required: [...SETUP_EVENT_REQUIRED, 'equipmentId', 'calibrationCount', 'feedSizeMm', 'changedBy'],
};

/**
 * Farm bridge event types discriminated by the `eventType` field on
 * the wire. Adding a new bridge event type requires:
 *   1. Defining the wire interface above.
 *   2. Adding the schema below.
 *   3. Adding the type here.
 *   4. Adding the NATS subject to `FARM_SUBJECTS` in the bridge.
 *
 * The contract drift from skipping any step is caught by the bridge
 * at runtime: it falls through to the "unknown event type" branch
 * and drops the event with a warn log.
 */
export type FarmEventType =
  | 'BatchCreated'
  | 'BatchHarvested'
  | 'BatchStatusChanged'
  | 'BatchClosed'
  | 'BatchAllocatedToTank'
  | 'MortalityRecorded'
  | 'CullRecorded'
  | 'BatchTransferred'
  | 'FeedingRecorded'
  | 'FeedInventoryLow'
  | 'LowStockDetected'
  | 'FeedingProtocolAssigned'
  | 'FeedingProtocolAssignmentPaused'
  | 'MealWindowUpcoming'
  | 'MealFed'
  | 'MealSkipped'
  | 'MealUnderfed'
  | 'MealMissed'
  | 'FeedTypeTransitioned'
  | 'UnfedUnitDetected'
  | 'FeedingDailySummary'
  | 'FCRAlert'
  | 'SiteCreated'
  | 'SiteUpdated'
  | 'SiteDeleted'
  | 'DepartmentCreated'
  | 'DepartmentUpdated'
  | 'DepartmentDeleted'
  | 'SystemCreated'
  | 'SystemUpdated'
  | 'SystemDeleted'
  | 'SiteContactsChanged'
  | 'TankCreated'
  | 'TankUpdated'
  | 'TankStatusChanged'
  | 'TankDeleted'
  | 'EquipmentCreated'
  | 'EquipmentUpdated'
  | 'EquipmentDeleted'
  | 'SubEquipmentCreated'
  | 'SubEquipmentUpdated'
  | 'SubEquipmentDeleted'
  | 'SupplierApprovedSitesChanged'
  | 'FeederCalibrationsSaved'
  | 'MortalityAlertRaised'
  | 'HarvestRegulatoryRecorded'
  | 'TankCleared'
  | 'BatchProductionCompleted';

/**
 * Map from event type discriminator to its compiled schema. Consumed
 * by `validator.ts` to build a single AJV instance with per-type
 * compiled validators.
 *
 * The type annotation is an explicit `Record<FarmEventType, object>`
 * — NOT inferred — because AJV's `JSONSchemaType<T>` emits extremely
 * deep generic trees that exceed TypeScript's inference budget when
 * composed into a single `const` object (TS7056). A coarser type
 * here keeps the validator file compile-friendly while the per-event
 * `JSONSchemaType<T>` annotations on each individual schema still
 * enforce contract-to-schema drift at the definition site.
 */
export const FARM_EVENT_SCHEMAS: Record<FarmEventType, object> = {
  BatchCreated: batchCreatedSchema,
  BatchHarvested: batchHarvestedSchema,
  BatchStatusChanged: batchStatusChangedSchema,
  BatchClosed: batchClosedSchema,
  BatchAllocatedToTank: batchAllocatedToTankSchema,
  MortalityRecorded: mortalityRecordedSchema,
  CullRecorded: cullRecordedSchema,
  BatchTransferred: batchTransferredSchema,
  FeedingRecorded: feedingRecordedSchema,
  FeedInventoryLow: feedInventoryLowSchema,
  LowStockDetected: lowStockDetectedSchema,
  FeedingProtocolAssigned: feedingProtocolAssignedSchema,
  FeedingProtocolAssignmentPaused: feedingProtocolAssignmentPausedSchema,
  MealWindowUpcoming: mealWindowUpcomingSchema,
  MealFed: mealFedSchema,
  MealSkipped: mealSkippedSchema,
  MealUnderfed: mealUnderfedSchema,
  MealMissed: mealMissedSchema,
  FeedTypeTransitioned: feedTypeTransitionedSchema,
  UnfedUnitDetected: unfedUnitDetectedSchema,
  FeedingDailySummary: feedingDailySummarySchema,
  FCRAlert: fcrAlertSchema,
  SiteCreated: siteCreatedSchema,
  SiteUpdated: siteUpdatedSchema,
  SiteDeleted: siteDeletedSchema,
  DepartmentCreated: departmentCreatedSchema,
  DepartmentUpdated: departmentUpdatedSchema,
  DepartmentDeleted: departmentDeletedSchema,
  SystemCreated: systemCreatedSchema,
  SystemUpdated: systemUpdatedSchema,
  SystemDeleted: systemDeletedSchema,
  SiteContactsChanged: siteContactsChangedSchema,
  TankCreated: tankCreatedSchema,
  TankUpdated: tankUpdatedSchema,
  TankStatusChanged: tankStatusChangedSchema,
  TankDeleted: tankDeletedSchema,
  EquipmentCreated: equipmentCreatedSchema,
  EquipmentUpdated: equipmentUpdatedSchema,
  EquipmentDeleted: equipmentDeletedSchema,
  SubEquipmentCreated: subEquipmentCreatedSchema,
  SubEquipmentUpdated: subEquipmentUpdatedSchema,
  SubEquipmentDeleted: subEquipmentDeletedSchema,
  SupplierApprovedSitesChanged: supplierApprovedSitesChangedSchema,
  FeederCalibrationsSaved: feederCalibrationsSavedSchema,
  MortalityAlertRaised: mortalityAlertRaisedSchema,
  HarvestRegulatoryRecorded: harvestRegulatoryRecordedSchema,
  TankCleared: tankClearedSchema,
  BatchProductionCompleted: batchProductionCompletedSchema,
};
