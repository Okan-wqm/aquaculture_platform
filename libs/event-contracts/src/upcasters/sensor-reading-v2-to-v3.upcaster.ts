import { EventUpcaster } from './event-upcaster';

/**
 * SensorReading v2 → v3 upcaster (Scope B Phase S1.1).
 *
 * v2 format: flat `readingXxx` fields, no federation correlation axes.
 * v3 format: same `readingXxx` fields PLUS optional `tankId`,
 *            `parameter`, `unit`, `relatedWaterQualityMeasurementId`.
 *
 * This is an IDENTITY upcaster — every new v3 field is optional, so a
 * v2 event deserialised with the v3 TypeScript interface is already a
 * valid v3 event with the new fields absent. The upcaster's only job
 * is bumping the `version` discriminator from `2` to `3` so the
 * downstream `EventUpcasterRegistry.upcast` loop knows it's done with
 * the chain.
 *
 * # Why not backfill `tankId` from sensor-meta cache here
 *
 * Backfilling would require a sensor-service-internal cache lookup at
 * upcast time, which contradicts the upcaster's pure-function shape
 * (`upcast(event) -> event`, no I/O). Sensor-service is the right place
 * to populate v3 fields at MINT time (Phase S1.2 wires that). Old
 * events that pre-date the change simply lack the fields, and
 * federation consumers (Phase S1.3 farm-service `Tank.sensorReadings`)
 * fall through to a sensorId-keyed lookup when `tankId` is absent.
 *
 * # Why not collapse this into the v1→v2 upcaster file
 *
 * The v1→v2 transformation renamed nested `readings.X` to flat
 * `readingX` — semantically and in failure mode it is a different
 * upcast. Keeping each version step as its own file keeps the registry
 * chain easy to reason about: ask "what does v1→v2 do?", look at one
 * file; ask "what does v2→v3 do?", look at another. A combined file
 * would force readers to context-switch between two different concerns.
 *
 * # Why fromVersion=2 not fromVersion=1
 *
 * The chained-upcaster registry walks the chain in order
 * (`fromVersion: 1, toVersion: 2` then `fromVersion: 2, toVersion: 3`),
 * so a v1 event passes through both upcasters. This upcaster's
 * `fromVersion: 2` is correct — it composes with v1→v2 transparently.
 */
export const sensorReadingV2ToV3Upcaster: EventUpcaster = {
  eventType: 'SensorReading',
  fromVersion: 2,
  toVersion: 3,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    return { ...event, version: 3 };
  },
};
