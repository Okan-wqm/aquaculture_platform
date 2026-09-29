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
 * ACTOR (ALERT-MEDIUM-007): the AUTHENTICATED caller who recorded the
 * measurement rides on the inherited `BaseEvent.userId` — never the
 * client-supplied `measuredBy` data field, which a caller could point at
 * somebody else. Absent for sensor-derived measurements.
 *
 * SITE: `siteId` is the site of {@link waterQualityMeasuredUnit}, resolved by
 * the producer from that unit — never a site the caller named.
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

/**
 * The ONE rule for "which unit did this measurement measure" (V-S1a-10).
 *
 * WHY: the farm write path resolves the measurement's site from a unit, and
 * alert-engine keys the incident (`water:equipment:{id}`) by a unit. When the
 * two picked different units (farm tank-first, alert equipment-first) a reading
 * naming a tank and a probe in two places could be authorized on one site and
 * paged on another. Both sides call this function, so they cannot disagree.
 *
 * WHAT: the measured equipment when there is one (the write contract requires
 * it — the equipment's parameter mappings validate the values), else the legacy
 * tank id. Null only for a measurement that names neither.
 */
export function waterQualityMeasuredUnit(ref: {
  readonly equipmentId?: string | null;
  readonly tankId?: string | null;
}): string | null {
  if (ref.equipmentId) return ref.equipmentId;
  if (ref.tankId) return ref.tankId;
  return null;
}

// ==================== Type Union ====================

/**
 * Union type for all water quality events
 */
export type WaterQualityEvent =
  | WaterQualityMeasurementCreatedEvent
  | WaterQualityCriticalEvent;
