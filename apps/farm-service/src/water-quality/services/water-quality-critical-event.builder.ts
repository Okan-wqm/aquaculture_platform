import { createBaseEvent, type WaterQualityCriticalEvent } from '@platform/event-contracts';

import {
  ParameterStatus,
  type WaterQualityMeasurement,
} from '../entities/water-quality-measurement.entity';

/**
 * Builds the life-safety `WaterQualityCritical` event for a saved measurement —
 * the ONE place its shape is decided (the single and the batch create path used
 * to carry two hand-kept copies).
 *
 * WHY the site and the actor (ALERT-MEDIUM-007): the alarm escalates to the
 * people assigned to the measured unit's site, and the report names who
 * recorded the reading. The site is the one DERIVED from the measured unit for
 * site authorization (`resolveMeasuredUnitSite`), so the event and the
 * authorization decision can never name two different sites. The actor rides
 * on `BaseEvent.userId` and is the AUTHENTICATED caller (V-S1b-5) — never the
 * `measuredBy` data field, which is client-supplied.
 *
 * Returns null when no parameter is in a CRITICAL band — nothing to raise.
 */
export function buildWaterQualityCriticalEvent(input: {
  tenantId: string;
  measurement: WaterQualityMeasurement;
  siteId: string | null;
  /** The authenticated caller that recorded the measurement (JWT `sub`). */
  actorId: string;
}): WaterQualityCriticalEvent | null {
  const { tenantId, measurement, siteId, actorId } = input;
  if (!measurement.hasAlarm || !measurement.summary?.evaluations) {
    return null;
  }

  const criticalParams = measurement.summary.evaluations
    .filter(
      (e) =>
        e.status === ParameterStatus.CRITICAL_LOW || e.status === ParameterStatus.CRITICAL_HIGH,
    )
    .map((e) => ({
      code: e.parameter,
      name: e.parameter,
      value: e.value,
      threshold:
        e.status === ParameterStatus.CRITICAL_LOW ? (e.criticalMin ?? 0) : (e.criticalMax ?? 0),
      direction: (e.status === ParameterStatus.CRITICAL_LOW ? 'below' : 'above') as
        | 'above'
        | 'below',
      unit: e.unit,
    }));

  if (criticalParams.length === 0) {
    return null;
  }

  return {
    ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', tenantId, {
      userId: actorId,
      aggregateId: measurement.id,
      aggregateType: 'WaterQualityMeasurement',
    }),
    measurementId: measurement.id,
    equipmentId: measurement.equipmentId ?? null,
    tankId: measurement.tankId ?? null,
    // ARCH-C01: variable-structure array serialized to keep the contract flat.
    criticalParametersJson: JSON.stringify(criticalParams),
    criticalParameterCount: criticalParams.length,
    measuredAt: measurement.measuredAt.toISOString(),
    ...(siteId === null ? {} : { siteId }),
  };
}
