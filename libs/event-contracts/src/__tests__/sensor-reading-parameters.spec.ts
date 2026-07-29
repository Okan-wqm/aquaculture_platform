import type { SensorReadingEvent, SensorReadingParameter } from '../sensor-events';
import {
  canonicalChannelKeyForParameter,
  PARAMETER_BY_READING_FIELD,
  parameterForChannelKey,
  readingFieldForParameter,
  SENSOR_READING_PARAMETERS,
  type SensorReadingField,
} from '../sensor-reading-parameters';

/**
 * SENSOR-MEDIUM-066/068: this is the single source of truth for the
 * channelKey ↔ parameter ↔ readingField vocabulary that used to be
 * hand-copied across the NATS ingestion consumer, the SensorIngestionService
 * event builder, and the alert-engine handler's READING_FIELD_MAP. These tests
 * lock the invariants every one of those consumers now relies on.
 */
describe('sensor-reading-parameters SSoT (SENSOR-MEDIUM-066/068)', () => {
  it('lists exactly the nine canonical parameters', () => {
    expect([...SENSOR_READING_PARAMETERS]).toEqual([
      'temperature',
      'ph',
      'dissolvedOxygen',
      'salinity',
      'ammonia',
      'nitrite',
      'nitrate',
      'turbidity',
      'waterLevel',
    ]);
  });

  it('builds the flat field with the exact `reading` + Capitalized(parameter) convention', () => {
    // This is the convention the SensorReadingEvent docblock documents
    // (`event['reading' + capitalise(parameter)]`).
    expect(readingFieldForParameter('temperature')).toBe('readingTemperature');
    expect(readingFieldForParameter('ph')).toBe('readingPh');
    expect(readingFieldForParameter('dissolvedOxygen')).toBe('readingDissolvedOxygen');
    expect(readingFieldForParameter('waterLevel')).toBe('readingWaterLevel');
  });

  it('every generated reading field is an actual SensorReadingEvent key', () => {
    // Structural guard: a typed probe object with every generated field. If a
    // parameter ever produced a field name that is NOT on SensorReadingEvent,
    // this assignment would fail to compile.
    const probe: Partial<Record<SensorReadingField, number>> = {};
    for (const parameter of SENSOR_READING_PARAMETERS) {
      probe[readingFieldForParameter(parameter)] = 1;
    }
    const event: Pick<SensorReadingEvent, SensorReadingField> = {
      readingTemperature: probe.readingTemperature,
      readingPh: probe.readingPh,
      readingDissolvedOxygen: probe.readingDissolvedOxygen,
      readingSalinity: probe.readingSalinity,
      readingAmmonia: probe.readingAmmonia,
      readingNitrite: probe.readingNitrite,
      readingNitrate: probe.readingNitrate,
      readingTurbidity: probe.readingTurbidity,
      readingWaterLevel: probe.readingWaterLevel,
    };
    expect(Object.keys(event)).toHaveLength(SENSOR_READING_PARAMETERS.length);
  });

  it('PARAMETER_BY_READING_FIELD is the exact inverse of readingFieldForParameter', () => {
    for (const parameter of SENSOR_READING_PARAMETERS) {
      expect(PARAMETER_BY_READING_FIELD[readingFieldForParameter(parameter)]).toBe(parameter);
    }
    // ...and covers every parameter, no more, no less.
    expect(Object.keys(PARAMETER_BY_READING_FIELD).sort()).toEqual(
      SENSOR_READING_PARAMETERS.map(readingFieldForParameter).sort(),
    );
  });

  it('resolves canonical channel keys to their parameter', () => {
    for (const parameter of SENSOR_READING_PARAMETERS) {
      // Every parameter is itself a valid (canonical) channel key — the JSONB
      // key doubles as a channel key.
      expect(parameterForChannelKey(parameter)).toBe(parameter);
    }
  });

  it('resolves device-naming aliases and is case-insensitive', () => {
    const aliasExpectations: Array<[string, SensorReadingParameter]> = [
      ['temp', 'temperature'],
      ['water_temperature', 'temperature'],
      ['Temp', 'temperature'],
      ['ph_level', 'ph'],
      ['dissolved_oxygen', 'dissolvedOxygen'],
      ['do', 'dissolvedOxygen'],
      ['o2', 'dissolvedOxygen'],
      ['OXYGEN', 'dissolvedOxygen'],
      ['salt', 'salinity'],
      ['nh3', 'ammonia'],
      ['no2', 'nitrite'],
      ['no3', 'nitrate'],
      ['ntu', 'turbidity'],
      ['water_level', 'waterLevel'],
      ['level', 'waterLevel'],
    ];
    for (const [channelKey, expected] of aliasExpectations) {
      expect(parameterForChannelKey(channelKey)).toBe(expected);
    }
  });

  it('returns undefined for channel keys outside the nine-parameter vocabulary', () => {
    // flow_rate / orp / co2 have no flat event field yet (convergence phase ≥3).
    for (const outside of ['flow_rate', 'orp', 'co2', 'widget_count', '']) {
      expect(parameterForChannelKey(outside)).toBeUndefined();
    }
  });

  it('freezes the inverse map so consumers cannot mutate the SSoT', () => {
    expect(Object.isFrozen(PARAMETER_BY_READING_FIELD)).toBe(true);
  });

  describe('canonicalChannelKeyForParameter', () => {
    it('round-trips EVERY parameter through the channel-key vocabulary', () => {
      // This is the invariant the whole ingest-to-read path rests on. A reported
      // parameter with no channel gets one auto-provisioned under this key, and
      // the as-of projection maps that key back with parameterForChannelKey. If
      // any parameter fails to survive the round trip its values are written and
      // then never read — the silent data loss SENSOR-HIGH-085 was about.
      for (const parameter of SENSOR_READING_PARAMETERS) {
        const channelKey = canonicalChannelKeyForParameter(parameter);
        expect(parameterForChannelKey(channelKey)).toBe(parameter);
      }
    });

    it('emits the snake_case device-naming spelling, not the camelCase parameter', () => {
      // Multi-word parameters are where the two spellings diverge, and where a
      // platform-minted channel would otherwise sit next to a device's own.
      expect(canonicalChannelKeyForParameter('dissolvedOxygen')).toBe('dissolved_oxygen');
      expect(canonicalChannelKeyForParameter('waterLevel')).toBe('water_level');
      expect(canonicalChannelKeyForParameter('temperature')).toBe('temperature');
      expect(canonicalChannelKeyForParameter('ph')).toBe('ph');
    });

    it('produces keys a device could equally have registered', () => {
      // Same-key means the (tenant, sensor, channel_key) unique constraint
      // dedupes an auto-provisioned channel against the real one.
      for (const parameter of SENSOR_READING_PARAMETERS) {
        expect(canonicalChannelKeyForParameter(parameter)).toMatch(/^[a-z][a-z_]*$/);
      }
    });
  });
});
