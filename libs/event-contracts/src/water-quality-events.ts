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
 *
 * ACTOR (ALERT-MEDIUM-007): the person who recorded the measurement rides on
 * the inherited `BaseEvent.userId` (absent for sensor-derived measurements), so
 * no second actor field is invented next to it.
 */
export interface WaterQualityCriticalEvent extends BaseEvent {
  eventType: 'WaterQualityCritical';
  measurementId: string;
  equipmentId: string | null;
  tankId: string | null;
  criticalParametersJson: string;
  criticalParameterCount: number;
  measuredAt: string;
  /**
   * Site of the measured unit (ALERT-MEDIUM-007) — resolved by the producer
   * through the one unit→site resolver (Department.siteId). Absent when the
   * measurement resolves to no site (pond-only, or a site-less department) and
   * on events published before the field existed; the alert escalation then
   * widens site-scoped recipients to the whole tenant rather than dropping them.
   */
  siteId?: string;
}

// ==================== Type Union ====================

/**
 * Union type for all water quality events
 */
export type WaterQualityEvent =
  | WaterQualityMeasurementCreatedEvent
  | WaterQualityCriticalEvent;
