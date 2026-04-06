export { EventUpcaster, EventUpcasterRegistry } from './event-upcaster';
export { sensorReadingUpcaster } from './sensor-reading.upcaster';
export { alertTriggeredUpcaster } from './alert-triggered.upcaster';

import { EventUpcasterRegistry } from './event-upcaster';
import { sensorReadingUpcaster } from './sensor-reading.upcaster';
import { alertTriggeredUpcaster } from './alert-triggered.upcaster';

/**
 * Create a registry pre-loaded with all platform event upcasters.
 * Used by NatsEventBus and any raw NATS consumers (e.g., gateway-api).
 */
export function createDefaultRegistry(): EventUpcasterRegistry {
  const registry = new EventUpcasterRegistry();
  registry.register(sensorReadingUpcaster);
  registry.register(alertTriggeredUpcaster);
  return registry;
}
