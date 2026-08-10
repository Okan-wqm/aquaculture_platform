import type { JSONSchemaType } from 'ajv';
import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  UUID_PATTERN,
} from './common.schema';

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

/**
 * Wire shape of a drive asking what it is wired to.
 *
 * WHY it is validated on the FARM side: this event makes another service go
 * looking through a tenant's equipment on the strength of two ids that arrived
 * over the bus. A malformed id has no business reaching that lookup, and an
 * unexpected extra field has no business being carried into the answer.
 */
interface WireVfdDriveBindingAttestationRequested {
  eventId: string;
  eventType: 'VfdDriveBindingAttestationRequested';
  timestamp: string;
  tenantId: string;
  version: number;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
  vfdDeviceId: string;
  drivenEquipmentId: string;
}

export const VFD_DRIVE_BINDING_ATTESTATION_REQUESTED_SCHEMA = {
  type: 'object',
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'VfdDriveBindingAttestationRequested' } as const,
    vfdDeviceId: { type: 'string', pattern: UUID_PATTERN } as const,
    drivenEquipmentId: { type: 'string', pattern: UUID_PATTERN } as const,
  },
  required: [...BASE_EVENT_REQUIRED, 'vfdDeviceId', 'drivenEquipmentId'],
  additionalProperties: false,
} as JSONSchemaType<WireVfdDriveBindingAttestationRequested>;

/**
 * Map of every sensor event type the validator knows about: the Rust sidecar's
 * `SensorMetricIngested`, and the drive's attestation request that farm-service
 * answers. Both cross a service boundary and are believed only after this map's
 * schema says so.
 *
 * The typed `SensorReadingEvent` is NOT here — it is published by the NestJS
 * consumer AFTER it has already passed the schema-equivalent shape check via
 * `createBaseEvent` + the typed interface, so it does not cross an untrusted
 * boundary the same way.
 *
 * Adding a new sensor event to this map is the workflow that wires
 * it into runtime validation; the validator dispatcher (`validator.ts`)
 * iterates over the map at module load to compile every entry.
 */
export const SENSOR_EVENT_SCHEMAS = {
  SensorMetricIngested: SENSOR_METRIC_INGESTED_SCHEMA,
  VfdDriveBindingAttestationRequested: VFD_DRIVE_BINDING_ATTESTATION_REQUESTED_SCHEMA,
} as const;

export type SensorEventType = keyof typeof SENSOR_EVENT_SCHEMAS;
