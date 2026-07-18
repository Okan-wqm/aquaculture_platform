/**
 * SENSOR-MEDIUM-067: the canonical reading-key codec reconciles a snake_case
 * channelKey with a camelCase SensorReadings field so calibration can never
 * silently miss a multi-word metric.
 */
import { canonicalReadingKey } from '../sensor-reading-key';

// The 9 SensorReadings fields (SSoT: sensor-reading.entity.ts SensorReadings).
const SENSOR_READINGS_KEYS = [
  'temperature',
  'ph',
  'dissolvedOxygen',
  'salinity',
  'ammonia',
  'nitrite',
  'nitrate',
  'turbidity',
  'waterLevel',
] as const;

const camelToSnake = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

describe('canonicalReadingKey (SENSOR-MEDIUM-067)', () => {
  it('maps the multi-word channel keys that were silently breaking calibration', () => {
    expect(canonicalReadingKey('dissolved_oxygen')).toBe('dissolvedOxygen');
    expect(canonicalReadingKey('water_level')).toBe('waterLevel');
  });

  it('passes single-word keys through unchanged', () => {
    expect(canonicalReadingKey('ph')).toBe('ph');
    expect(canonicalReadingKey('temperature')).toBe('temperature');
  });

  it('normalizes kebab-case and spaced keys to the same canonical form', () => {
    expect(canonicalReadingKey('dissolved-oxygen')).toBe('dissolvedOxygen');
    expect(canonicalReadingKey('water level')).toBe('waterLevel');
  });

  it('is idempotent on an already-camelCase key', () => {
    for (const key of SENSOR_READINGS_KEYS) {
      expect(canonicalReadingKey(key)).toBe(key);
    }
  });

  it('reconciles every SensorReadings field with its snake_case channelKey (round-trip)', () => {
    // The channelKey discovery/KNOWN_PARAMETERS produce for each metric is the
    // snake_case form; the codec must map it back to the exact reading key, so no
    // field is ever unreachable at the calibration join.
    for (const key of SENSOR_READINGS_KEYS) {
      expect(canonicalReadingKey(camelToSnake(key))).toBe(key);
    }
  });
});
