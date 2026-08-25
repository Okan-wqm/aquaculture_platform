import { BASE_EVENT_PROPERTIES, BASE_EVENT_REQUIRED, UUID_SCHEMA } from './common.schema';

export type TelemetryCapacityEventType = 'TelemetryCapacityEntitlementChanged';

export const TELEMETRY_CAPACITY_EVENT_SCHEMAS = {
  TelemetryCapacityEntitlementChanged: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { const: 'TelemetryCapacityEntitlementChanged' },
      operationId: UUID_SCHEMA,
      reservationId: UUID_SCHEMA,
      entitlementId: UUID_SCHEMA,
      entitlementVersion: { type: 'integer', minimum: 1 },
      activationState: {
        type: 'string',
        enum: ['PENDING_CAPACITY', 'RESERVED', 'ACTIVE', 'SUPERSEDED', 'RELEASED', 'EXPIRED'],
      },
      effectiveAt: { type: 'string', format: 'date-time' },
      capacityEnvelopeVersion: { type: 'integer', minimum: 1 },
      sustainedIngressMessagesPerSecond: {
        type: 'number',
        exclusiveMinimum: 0,
      },
      sustainedMetricRowsPerMinute: {
        type: 'number',
        exclusiveMinimum: 0,
      },
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'operationId',
      'reservationId',
      'entitlementId',
      'entitlementVersion',
      'activationState',
      'effectiveAt',
      'capacityEnvelopeVersion',
      'sustainedIngressMessagesPerSecond',
      'sustainedMetricRowsPerMinute',
    ],
  },
} as const;
