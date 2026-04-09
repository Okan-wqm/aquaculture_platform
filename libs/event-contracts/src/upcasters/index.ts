export { EventUpcaster, EventUpcasterRegistry } from './event-upcaster';
export { sensorReadingUpcaster } from './sensor-reading.upcaster';
export { alertTriggeredUpcaster } from './alert-triggered.upcaster';
export { createTimestampUpcaster } from './timestamp-to-string.upcaster';

import { EventUpcasterRegistry } from './event-upcaster';
import { sensorReadingUpcaster } from './sensor-reading.upcaster';
import { alertTriggeredUpcaster } from './alert-triggered.upcaster';
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
  registry.register(alertTriggeredUpcaster);

  // Timestamp + aggregateId version bump upcasters (v1→v2)
  for (const eventType of TIMESTAMP_BUMP_EVENTS) {
    registry.register(createTimestampUpcaster(eventType, 1, 2));
  }

  return registry;
}
