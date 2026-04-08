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
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'name',
    'species',
    'quantity',
    'stockedAt',
  ],
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
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'harvestedQuantity',
    'harvestedAt',
  ],
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
  required: [
    ...BASE_EVENT_REQUIRED,
    'batchId',
    'previousStatus',
    'newStatus',
  ],
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

export const batchAllocatedToTankSchema: JSONSchemaType<WireBatchAllocatedToTank> =
  {
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
  | 'FeedInventoryLow';

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
};
