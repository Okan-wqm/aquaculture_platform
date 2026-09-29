import type { JSONSchemaType } from 'ajv';

import type { BaseEvent } from '../base-event';
import type { WaterQualityCriticalEvent } from '../water-quality-events';
import { BASE_EVENT_PROPERTIES, BASE_EVENT_REQUIRED, UUID_SCHEMA } from './common.schema';

/**
 * Trust-boundary schema for the life-safety water-quality alarm
 * (ALERT-MEDIUM-007).
 *
 * WHY: `WaterQualityCritical` is what turns a crashing oxygen reading into an
 * incident and a page, and it had no schema at all — so the bus handed
 * alert-engine whatever arrived, and the new `siteId` (which now decides WHO is
 * paged) would have crossed the boundary unchecked. Registered in the bus-level
 * `validateEventBySubject` registry (validator.ts), so every consumer of the
 * subject is covered without calling anything itself.
 *
 * WHAT: `WireWaterQualityCritical` is DERIVED from the contract interface (its
 * own fields, with the wire base event), and the schema is typed
 * `JSONSchemaType<WireWaterQualityCritical>` — a field added to or removed from
 * `WaterQualityCriticalEvent` without the schema following is a compile error
 * here (tier 1), not a dead-lettered alarm in production.
 *
 * INVARIANT: the one producer (farm-service `buildWaterQualityCriticalEvent`)
 * always satisfies this schema; `water-quality-critical-event.builder.spec.ts`
 * proves it on the wire shape. If violated → the bus dead-letters a critical
 * reading and nobody is paged.
 */

/** Base-event fields as they travel on the wire (JSON, no branded id). */
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

type WireWaterQualityCritical = WireBaseEvent &
  Omit<WaterQualityCriticalEvent, keyof BaseEvent> & {
    eventType: WaterQualityCriticalEvent['eventType'];
  };

/**
 * Upper bound on the serialized critical-parameter list. One entry is ~150
 * characters; this admits several hundred parameters, far past any real
 * measurement, while keeping an unbounded string off the alarm path.
 */
export const WATER_QUALITY_CRITICAL_PARAMETERS_JSON_MAX_LENGTH = 65_536;

/** A required `string | null` id (the unit fields: one of them may be absent). */
const UUID_OR_NULL = { anyOf: [UUID_SCHEMA, { type: 'null', nullable: true }] } as const;

/** An optional id (`siteId?: string`): absent, or a uuid. */
const OPTIONAL_UUID = { ...UUID_SCHEMA, nullable: true } as const;

export const waterQualityCriticalSchema: JSONSchemaType<WireWaterQualityCritical> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'WaterQualityCritical' },
    measurementId: UUID_SCHEMA,
    equipmentId: UUID_OR_NULL,
    tankId: UUID_OR_NULL,
    criticalParametersJson: {
      type: 'string',
      minLength: 2,
      maxLength: WATER_QUALITY_CRITICAL_PARAMETERS_JSON_MAX_LENGTH,
    },
    criticalParameterCount: { type: 'integer', minimum: 1, maximum: 1000 },
    measuredAt: { type: 'string', format: 'date-time' },
    // ALERT-MEDIUM-007: optional — events published before the field existed,
    // and measurements whose unit resolves to no site, carry none.
    siteId: OPTIONAL_UUID,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'measurementId',
    'equipmentId',
    'tankId',
    'criticalParametersJson',
    'criticalParameterCount',
    'measuredAt',
  ],
};

export type WaterQualityEventType = WaterQualityCriticalEvent['eventType'];

/**
 * Water-quality events with a compiled trust-boundary schema. Typed coarsely
 * (as FARM_EVENT_SCHEMAS is) so the validator can compile the map uniformly;
 * each value's precise `JSONSchemaType` annotation lives at its definition.
 */
export const WATER_QUALITY_EVENT_SCHEMAS: Record<WaterQualityEventType, object> = {
  WaterQualityCritical: waterQualityCriticalSchema,
};
