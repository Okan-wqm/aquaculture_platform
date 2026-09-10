import { EventUpcaster } from './event-upcaster';
import { parameterForChannelKey, readingFieldForParameter } from '../sensor-reading-parameters';

/**
 * SensorReading v1 → v2 upcaster
 *
 * v1 format: `readings: { temperature?: number, ph?: number, ... }`
 * v2 format: `readingTemperature?: number, readingPh?: number, ...`
 *
 * WHY: Flat-object rule — nested `readings` object violates BaseEvent contract.
 *
 * SENSOR-CRITICAL-111 — WHY THIS NOW READS THE SHARED VOCABULARY
 *
 * No producer emits v1 any more; this path exists only for events already on
 * the stream. It used to carry its own nine-entry map keyed by CANONICAL
 * PARAMETER names (`dissolvedOxygen`, `waterLevel`), while the v1 bodies it
 * upcasts were the raw MQTT payload keyed by DEVICE CHANNEL KEYS (`do`, `o2`,
 * `dissolved_oxygen`, `level`, `temp`, `nh3`, …). The two vocabularies barely
 * intersect: only a device that happened to spell its channel exactly
 * `temperature`, `ph`, `salinity`, `ammonia`, `nitrite`, `nitrate` or
 * `turbidity` survived, and `dissolvedOxygen`/`waterLevel` in camelCase
 * essentially never appear on a wire.
 *
 * Everything else was dropped along with the whole `readings` object, so the
 * upcast produced an event with NO readings — which the alert engine reads as
 * "nothing is wrong" and uses to auto-resolve open INFO/LOW incidents as
 * "returned to normal". A silently-emptied reading was worse than a rejected
 * one.
 *
 * `parameterForChannelKey` is the alias table the producers, the NATS consumer
 * and the alert engine already share, so a replayed v1 event now resolves the
 * same way a live one does. Keys that are genuinely outside the flat shape
 * (`flow_rate`, `orp`, `co2`) still resolve to nothing — but that is now the
 * same answer every other path gives, not a second private opinion.
 */
export const sensorReadingUpcaster: EventUpcaster = {
  eventType: 'SensorReading',
  fromVersion: 1,
  toVersion: 2,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    const readings = event['readings'] as Record<string, unknown> | undefined;
    if (!readings || typeof readings !== 'object') {
      return { ...event, version: 2 };
    }

    const result: Record<string, unknown> = { ...event, version: 2 };
    delete result['readings'];

    for (const [key, value] of Object.entries(readings)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const parameter = parameterForChannelKey(key);
      if (parameter === undefined) continue;
      result[readingFieldForParameter(parameter)] = value;
    }

    return result;
  },
};
