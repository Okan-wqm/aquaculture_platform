import { TENANT_ID_REGEX } from '@aquaculture/backend-common/constants';

/**
 * The NATS subject of a sensor reading: `telemetry.{tenantId}.SensorReading` (SENSOR-HIGH-092
 * routed SensorReading to the telemetry root).
 */
export const SENSOR_READING_SUBJECT = 'telemetry.*.SensorReading';

/**
 * The tenant a sensor reading belongs to, read from its NATS subject (SEC-CRITICAL-207; CR-1).
 *
 * WHY: the readings bridge built its socket rooms from `event.tenantId`, a payload field the
 * publisher controls, while the subject is stamped at publish time by
 * `NatsEventBus.deriveSubject()` and carried by the broker. A publisher that set another tenant in
 * its payload could otherwise route a reading into that tenant's sensor rooms. The farm bridge
 * already routes by the subject alone (farm-nats-bridge.service.ts, "Tenant routing"); this is the
 * same rule for readings.
 *
 * WHAT: the tenant token of a `telemetry.{tenant}.SensorReading` subject when it is a canonical
 * tenant id (`TENANT_ID_REGEX`), else null — a malformed or non-tenant token (`system`) names no
 * room and the reading is dropped.
 */
export function sensorReadingSubjectTenant(subject: string): string | null {
  const tokens = subject.split('.');
  const [root, tenantId, eventType] = tokens;
  if (tokens.length !== 3 || root !== 'telemetry' || eventType !== 'SensorReading') return null;
  if (tenantId === undefined || !TENANT_ID_REGEX.test(tenantId)) return null;
  return tenantId;
}
