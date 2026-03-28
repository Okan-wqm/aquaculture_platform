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
 */
export interface WaterQualityCriticalEvent extends BaseEvent {
  eventType: 'WaterQualityCritical';
  measurementId: string;
  equipmentId: string | null;
  tankId: string | null;
  criticalParameters: Array<{
    code: string;
    name: string;
    value: number;
    threshold: number;
    direction: 'above' | 'below';
    unit: string;
  }>;
  measuredAt: string;
}

// ==================== Type Union ====================

/**
 * Union type for all water quality events
 */
export type WaterQualityEvent =
  | WaterQualityMeasurementCreatedEvent
  | WaterQualityCriticalEvent;
