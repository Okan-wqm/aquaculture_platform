export { EventUpcasterRegistry } from './event-upcaster';
// EventUpcaster is an interface — `export type` under isolatedModules.
export type { EventUpcaster } from './event-upcaster';
export { sensorReadingUpcaster } from './sensor-reading.upcaster';
export { sensorReadingV2ToV3Upcaster } from './sensor-reading-v2-to-v3.upcaster';
export { alertTriggeredUpcaster } from './alert-triggered.upcaster';
export { alertTriggeredV2ToV3Upcaster } from './alert-triggered-v2-to-v3.upcaster';
export {
  alertEscalatedUpcaster,
  LEGACY_EVENT_SHAPE_MARKER,
} from './alert-escalated-legacy.upcaster';
export { batchHarvestedUpcaster } from './batch-harvested-v1-to-v2.upcaster';
export { createTimestampUpcaster } from './timestamp-to-string.upcaster';

import { EventUpcasterRegistry } from './event-upcaster';
import { sensorReadingUpcaster } from './sensor-reading.upcaster';
import { sensorReadingV2ToV3Upcaster } from './sensor-reading-v2-to-v3.upcaster';
import { alertTriggeredUpcaster } from './alert-triggered.upcaster';
import { alertTriggeredV2ToV3Upcaster } from './alert-triggered-v2-to-v3.upcaster';
import { alertEscalatedUpcaster } from './alert-escalated-legacy.upcaster';
import { batchHarvestedUpcaster } from './batch-harvested-v1-to-v2.upcaster';
import { createTimestampUpcaster } from './timestamp-to-string.upcaster';

/**
 * Event types that underwent schema changes requiring version bump.
 *
 * - SensorReading: v1→v2 (nested readings → flat fields) — existing upcaster
 * - AlertTriggered: v1→v2 (nested triggeringData → flat fields) — existing upcaster
 *
 * The following events had fields added (aggregateId) or types changed (timestamp),
 * warranting a version bump from 1→2. The timestamp upcaster normalizes Date → string.
 *
 * @see DATA-MEDIUM-006 (missing aggregateId)
 * @see DATA-MEDIUM-007 (version not bumped)
 * @see DATA-MEDIUM-011 (timestamp Date → string)
 */
const TIMESTAMP_BUMP_EVENTS = [
  'BatchStatusChanged',
  'SensorCalibrated',
  'AlertEscalated',
  'ModuleRemovedFromTenant',
] as const;

/**
 * Create a registry pre-loaded with all platform event upcasters.
 * Used by NatsEventBus and any raw NATS consumers (e.g., gateway-api).
 */
export function createDefaultRegistry(): EventUpcasterRegistry {
  const registry = new EventUpcasterRegistry();

  // Existing structural upcasters (nested → flat)
  registry.register(sensorReadingUpcaster);
  // Scope B Phase S1.1 — additive optional federation correlation
  // axes (tankId, parameter, unit, relatedWaterQualityMeasurementId).
  // Pure version bump; chains after the v1→v2 rename so v1 events pick
  // up both transforms.
  registry.register(sensorReadingV2ToV3Upcaster);
  registry.register(alertTriggeredUpcaster);
  // Decision 7: v3 names the incident (external-target delivery key).
  registry.register(alertTriggeredV2ToV3Upcaster);
  // V-S1a-11: the pre-delivery AlertEscalated shape ends here (terminal).
  registry.register(alertEscalatedUpcaster);
  registry.register(batchHarvestedUpcaster);

  // Timestamp + aggregateId version bump upcasters (v1→v2)
  for (const eventType of TIMESTAMP_BUMP_EVENTS) {
    registry.register(createTimestampUpcaster(eventType, 1, 2));
  }

  return registry;
}
