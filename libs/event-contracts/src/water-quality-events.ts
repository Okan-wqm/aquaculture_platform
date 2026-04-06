import { BaseEvent } from './base-event';

// ==================== Water Quality Events ====================

/**
 * Emitted when a new water quality measurement is created (manual, sensor, or lab)
 */
export interface WaterQualityMeasurementCreatedEvent extends BaseEvent {
  eventType: 'WaterQualityMeasurementCreated';
  measurementId: string;
  equipmentId: string | null;
  tankId: string | null;
  source: string;
  overallStatus: string;
  hasAlarm: boolean;
  measuredBy: string | null;
  measuredAt: string;
  parameterCount: number;
}

/**
 * Emitted when a measurement has critical parameters — high priority for alert-service
 *
 * ARCH-C01: criticalParameters serialized as JSON string — array of complex objects
 * with variable structure makes flat-field mapping impractical.
 * criticalParameterCount provides quick access without deserializing.
 */
export interface WaterQualityCriticalEvent extends BaseEvent {
  eventType: 'WaterQualityCritical';
  measurementId: string;
  equipmentId: string | null;
  tankId: string | null;
  criticalParametersJson: string;
  criticalParameterCount: number;
  measuredAt: string;
}

// ==================== Type Union ====================

/**
 * Union type for all water quality events
 */
export type WaterQualityEvent =
  | WaterQualityMeasurementCreatedEvent
  | WaterQualityCriticalEvent;
