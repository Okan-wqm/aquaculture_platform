import type { BaseEvent } from './base-event';

export type TelemetryCapacityActivationState =
  | 'PENDING_CAPACITY'
  | 'RESERVED'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'RELEASED'
  | 'EXPIRED';

/**
 * Immutable telemetry-capacity decision published by the admin admission
 * authority. Consumers project the exact approved version; they never infer
 * capacity from the tenant plan or from a later envelope revision.
 */
export interface TelemetryCapacityEntitlementChangedEvent extends BaseEvent {
  eventType: 'TelemetryCapacityEntitlementChanged';
  operationId: string;
  reservationId: string;
  entitlementId: string;
  entitlementVersion: number;
  activationState: TelemetryCapacityActivationState;
  effectiveAt: string;
  capacityEnvelopeVersion: number;
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;
}

export type TelemetryCapacityEvent = TelemetryCapacityEntitlementChangedEvent;
