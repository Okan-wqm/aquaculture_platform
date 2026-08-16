import type { JSONSchemaType } from 'ajv';
import { BASE_EVENT_PROPERTIES, BASE_EVENT_REQUIRED, UUID_PATTERN } from './common.schema';

/**
 * @module SensorEventSchemas
 *
 * JSON Schema definitions for sensor-domain events that cross a
 * trust boundary — currently `SensorMetricIngested`, the event the
 * Rust ingestion sidecar (`apps/sensor-ingestion`, ADR-025) publishes
 * onto NATS for the NestJS `NatsIngestionConsumerService` to consume.
 *
 * # Why a JSON Schema validator on top of Rust's `deny_unknown_fields`
 *
 * The Rust struct `event_contracts_rs::SensorMetricIngestedEvent`
 * already rejects unknown fields at deserialisation time — sender-side
 * shape drift fails fast in the producer's own process. The NestJS
 * consumer relies on TypeScript narrowing on the static interface
 * (`SensorMetricIngestedEvent` in `sensor-events.ts`), which catches
 * compile-time drift in same-codebase callers.
 *
 * Neither catches the case the schema closes:
 *   - A FUTURE producer (a different language, a different team's
 *     test harness, a malicious actor with NATS publish rights to
 *     `events.<tenant>.SensorMetricIngested`) emits a payload with
 *     extra fields, missing required fields, or a wrong-type value.
 *   - The TS side does `JSON.parse` and trusts the static type, so
 *     extra fields silently flow into BatchProcessorService.enqueue
 *     and then into the typed re-emit. That's exactly the H-3
 *     trusted-source XSS footgun this validator class closes for the
 *     farm domain.
 *
 * Same posture as `farm-events.schema.ts`: every schema has
 * `additionalProperties: false`, every Optional field declares
 * `nullable: true` so AJV's `JSONSchemaType<T>` accepts the `?:`
 * TypeScript syntax, every string identifier carries the platform
 * UUID pattern.
 *
 * # Strict mode — additionalProperties: false
 *
 * Required because the Rust producer's `deny_unknown_fields` is
 * promised wire-equivalent to the TS contract (ADR-006 flat pattern).
 * If a future schema bump adds a field, the schema here MUST be
 * updated in lockstep — the unit tests in this file pin that
 * invariant by serialising a Rust-shaped payload and round-tripping
 * it through `validateSensorEvent`.
 */

// ============================================================================
// Inline wire-format interface — exactly the on-wire JSON shape
// ============================================================================
//
// `timestamp` is `string` (ISO 8601), not `Date`, because after
// `JSON.parse` the wire carries the string form (same correction the
// farm schema documents in its module-level comment).
//
// `producerTs` is `number` (ms since epoch). Bounds 1_704_067_200_000
// (2024-01-01) and 4_102_444_800_000 (2100-01-01) match the
// validator the Rust sidecar enforces in `payload.rs::PRODUCER_TS_MIN_MS`
// and `PRODUCER_TS_MAX_MS`. Schema validation is the LAST line of
// defence; producer + consumer + persistence all narrow the same
// range.

interface WireSensorMetricIngested {
  eventId: string;
  eventType: 'SensorMetricIngested';
  timestamp: string;
  tenantId: string;
  version: number;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
  sensorId: string;
  channelId: string;
  rawValue: number;
  value: number;
  qualityCode: number;
  producerTs: number;
  farmId?: string;
  pondId?: string;
}

interface WireFeedingWindowReadinessVerdictV1 {
  unitId: string;
  unitCode: string;
  mealId: string;
  dayPlanId: string;
  scheduledAt: string;
  status: 'ready' | 'low_oxygen' | 'no_reading' | 'not_instrumented';
  minDissolvedOxygen: number;
  observedDissolvedOxygen?: number;
  observedAt?: string;
  lowOxygenReductionPercent?: number;
}

interface WireFeedingWindowReadinessV1 {
  eventId: string;
  eventType: 'FeedingWindowReadiness';
  timestamp: string;
  tenantId: string;
  version: number;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
  schemaVersion: 'feeding-window-readiness/v1';
  sourceWindowEventId: string;
  windowStart: string;
  windowEnd: string;
  evaluatedAt: string;
  batchIndex: number;
  batchCount: number;
  verdicts: WireFeedingWindowReadinessVerdictV1[];
}

const PRODUCER_TS_MIN_MS = 1_704_067_200_000; // 2024-01-01T00:00:00Z
const PRODUCER_TS_MAX_MS = 4_102_444_800_000; // 2100-01-01T00:00:00Z

const SENSOR_METRIC_INGESTED_SCHEMA: JSONSchemaType<WireSensorMetricIngested> = {
  type: 'object',
  properties: {
    ...BASE_EVENT_PROPERTIES,
    // BaseEvent's `eventType` is `^[A-Z][A-Za-z0-9]+$`. We narrow to
    // the exact discriminator so a payload with `"SomethingElse"`
    // is rejected even though the BaseEvent shape would have allowed
    // it.
    eventType: { type: 'string', const: 'SensorMetricIngested' } as const,
    sensorId: { type: 'string', pattern: UUID_PATTERN } as const,
    channelId: { type: 'string', pattern: UUID_PATTERN } as const,
    rawValue: { type: 'number' } as const,
    value: { type: 'number' } as const,
    qualityCode: { type: 'integer', minimum: 0, maximum: 3 } as const,
    producerTs: {
      type: 'integer',
      minimum: PRODUCER_TS_MIN_MS,
      maximum: PRODUCER_TS_MAX_MS,
    } as const,
    farmId: { type: 'string', pattern: UUID_PATTERN, nullable: true } as const,
    pondId: { type: 'string', pattern: UUID_PATTERN, nullable: true } as const,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'sensorId',
    'channelId',
    'rawValue',
    'value',
    'qualityCode',
    'producerTs',
  ],
  additionalProperties: false,
} as JSONSchemaType<WireSensorMetricIngested>;

const FEEDING_WINDOW_READINESS_SCHEMA: JSONSchemaType<WireFeedingWindowReadinessV1> = {
  type: 'object',
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'FeedingWindowReadiness' } as const,
    schemaVersion: {
      type: 'string',
      const: 'feeding-window-readiness/v1',
    } as const,
    sourceWindowEventId: { type: 'string', pattern: UUID_PATTERN } as const,
    windowStart: { type: 'string', format: 'date-time' } as const,
    windowEnd: { type: 'string', format: 'date-time' } as const,
    evaluatedAt: { type: 'string', format: 'date-time' } as const,
    batchIndex: { type: 'integer', minimum: 0, maximum: 9999 } as const,
    batchCount: { type: 'integer', minimum: 1, maximum: 10000 } as const,
    verdicts: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        properties: {
          unitId: { type: 'string', pattern: UUID_PATTERN } as const,
          unitCode: { type: 'string', minLength: 1, maxLength: 64 } as const,
          mealId: { type: 'string', pattern: UUID_PATTERN } as const,
          dayPlanId: { type: 'string', pattern: UUID_PATTERN } as const,
          scheduledAt: { type: 'string', format: 'date-time' } as const,
          status: {
            type: 'string',
            enum: ['ready', 'low_oxygen', 'no_reading', 'not_instrumented'],
          } as const,
          minDissolvedOxygen: { type: 'number', minimum: 0, maximum: 20 } as const,
          observedDissolvedOxygen: {
            type: 'number',
            minimum: 0,
            maximum: 20,
            nullable: true,
          } as const,
          observedAt: { type: 'string', format: 'date-time', nullable: true } as const,
          lowOxygenReductionPercent: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            nullable: true,
          } as const,
        },
        required: [
          'unitId',
          'unitCode',
          'mealId',
          'dayPlanId',
          'scheduledAt',
          'status',
          'minDissolvedOxygen',
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'schemaVersion',
    'sourceWindowEventId',
    'windowStart',
    'windowEnd',
    'evaluatedAt',
    'batchIndex',
    'batchCount',
    'verdicts',
  ],
  additionalProperties: false,
} as JSONSchemaType<WireFeedingWindowReadinessV1>;

/**
 * Map of every sensor event type with a governed runtime wire contract.
 * `FeedingWindowReadiness` crosses service boundaries and is persisted as a
 * farm projection, so consumers validate the same contract instead of
 * maintaining local envelope allowlists.
 *
 * Adding a new sensor event to this map is the workflow that wires
 * it into runtime validation; the validator dispatcher (`validator.ts`)
 * iterates over the map at module load to compile every entry.
 */
export const SENSOR_EVENT_SCHEMAS = {
  SensorMetricIngested: SENSOR_METRIC_INGESTED_SCHEMA,
  FeedingWindowReadiness: FEEDING_WINDOW_READINESS_SCHEMA,
} as const;

export type SensorEventType = keyof typeof SENSOR_EVENT_SCHEMAS;
