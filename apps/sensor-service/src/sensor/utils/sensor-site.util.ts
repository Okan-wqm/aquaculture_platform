/**
 * The site a sensor's readings belong to — a site UUID or nothing
 * (ALERT-MEDIUM-013).
 *
 * WHY: `sensors.site_id` is a varchar column (SENSOR-MEDIUM-187), but every
 * reader of a sensor's site outside sensor-service stores or compares it as a
 * uuid: alert-engine's `alert_history.site_id`, the FeedingWindowReadiness
 * wire schema. A label that is not a UUID failed alert-engine's alarm insert
 * after its cooldown had been claimed, so the alarm was lost. Each
 * SensorReading builder and the pre-meal oxygen guard read the site here, so a
 * value that is not a site never leaves this service. Once the column is
 * uuid (SENSOR-MEDIUM-187) the parse reduces to the column's own type.
 *
 * WHAT: the sensor's `siteId` when it is a UUID; undefined for a sensor bound
 * to no site or to a label, so the event's optional field stays absent.
 */
import { isValidUUID } from '@aquaculture/backend-common/database';

export function siteOfSensor(sensor: { readonly siteId?: string | null }): string | undefined {
  const { siteId } = sensor;
  return typeof siteId === 'string' && isValidUUID(siteId) ? siteId : undefined;
}
