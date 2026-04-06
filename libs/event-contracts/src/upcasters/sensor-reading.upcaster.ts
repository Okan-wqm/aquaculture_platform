import { EventUpcaster } from './event-upcaster';

/**
 * SensorReading v1 → v2 upcaster
 *
 * v1 format: `readings: { temperature?: number, ph?: number, ... }`
 * v2 format: `readingTemperature?: number, readingPh?: number, ...`
 *
 * WHY: Flat-object rule — nested `readings` object violates BaseEvent contract.
 */

/** Known reading parameters and their flat field names */
const READING_FIELD_MAP: Record<string, string> = {
  temperature: 'readingTemperature',
  ph: 'readingPh',
  dissolvedOxygen: 'readingDissolvedOxygen',
  salinity: 'readingSalinity',
  ammonia: 'readingAmmonia',
  nitrite: 'readingNitrite',
  nitrate: 'readingNitrate',
  turbidity: 'readingTurbidity',
  waterLevel: 'readingWaterLevel',
};

export const sensorReadingUpcaster: EventUpcaster = {
  eventType: 'SensorReading',
  fromVersion: 1,
  toVersion: 2,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    const readings = event['readings'] as Record<string, number | undefined> | undefined;
    if (!readings || typeof readings !== 'object') {
      return { ...event, version: 2 };
    }

    const result: Record<string, unknown> = { ...event, version: 2 };
    delete result['readings'];

    for (const [key, flatField] of Object.entries(READING_FIELD_MAP)) {
      if (readings[key] !== undefined) {
        result[flatField] = readings[key];
      }
    }

    return result;
  },
};
