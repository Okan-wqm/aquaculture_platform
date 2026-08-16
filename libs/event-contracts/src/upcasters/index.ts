export { EventUpcasterRegistry } from './event-upcaster';
// EventUpcaster is an interface — `export type` under isolatedModules.
export type { EventUpcaster } from './event-upcaster';
export { sensorReadingUpcaster } from './sensor-reading.upcaster';
export { sensorReadingV2ToV3Upcaster } from './sensor-reading-v2-to-v3.upcaster';
export { alertTriggeredUpcaster } from './alert-triggered.upcaster';
export { batchHarvestedUpcaster } from './batch-harvested-v1-to-v2.upcaster';
export { createTimestampUpcaster } from './timestamp-to-string.upcaster';
export { farmRemovalProvenanceUpcasters } from './farm-removal-provenance-v1-to-v2.upcaster';

import { EventUpcasterRegistry } from './event-upcaster';
import { sensorReadingUpcaster } from './sensor-reading.upcaster';
import { sensorReadingV2ToV3Upcaster } from './sensor-reading-v2-to-v3.upcaster';
import { alertTriggeredUpcaster } from './alert-triggered.upcaster';
import { batchHarvestedUpcaster } from './batch-harvested-v1-to-v2.upcaster';
import { createTimestampUpcaster } from './timestamp-to-string.upcaster';
import { farmRemovalProvenanceUpcasters } from './farm-removal-provenance-v1-to-v2.upcaster';

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
  registry.register(batchHarvestedUpcaster);
  for (const upcaster of farmRemovalProvenanceUpcasters) {
    registry.register(upcaster);
  }

  // Timestamp + aggregateId version bump upcasters (v1→v2)
  for (const eventType of TIMESTAMP_BUMP_EVENTS) {
    registry.register(createTimestampUpcaster(eventType, 1, 2));
  }

  return registry;
}
