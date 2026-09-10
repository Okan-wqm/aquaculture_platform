/**
 * SENSOR-CRITICAL-111 — the projection is the only door from a persisted row
 * to a published reading event, so these assertions are the contract every
 * producer inherits.
 *
 * Each case names the production symptom it prevents rather than the shape it
 * checks: the finding was not "the mapper is wrong", it was that two producers
 * had no mapper at all and published the wire payload.
 */
import {
  projectPersistedReadings,
  type PersistedReadingMetric,
} from '../sensor-reading-projection';

const FARM = 'farm-uuid-1';
const POND = 'pond-uuid-1';
const TANK = 'tank-uuid-1';

function metric(overrides: Partial<PersistedReadingMetric> = {}): PersistedReadingMetric {
  return {
    channelKey: 'temperature',
    value: 21.5,
    farmId: FARM,
    pondId: POND,
    tankId: TANK,
    ...overrides,
  };
}

describe('projectPersistedReadings (SENSOR-CRITICAL-111)', () => {
  it('carries the scope the stored row has — the half the alert engine fails closed on', () => {
    const p = projectPersistedReadings([metric()]);

    expect(p.farmId).toBe(FARM);
    expect(p.pondId).toBe(POND);
    expect(p.tankId).toBe(TANK);
    // A farm-scoped rule is excluded in SQL when farmId is absent, so this is
    // the assertion that keeps every such rule evaluable.
    expect(p.fields).toEqual({ readingTemperature: 21.5 });
    expect(p.mappedCount).toBe(1);
  });

  it('resolves the device spellings the v1 upcaster never knew', () => {
    // The retired upcaster mapped nine camelCase keys and none of the aliases,
    // so a device publishing `dissolved_oxygen` — the most common spelling —
    // produced an empty reading. Every alias here is one that used to vanish.
    for (const key of ['do', 'o2', 'dissolved_oxygen', 'oxygen', 'DissolvedOxygen']) {
      const p = projectPersistedReadings([metric({ channelKey: key, value: 7.2 })]);
      expect(p.fields).toEqual({ readingDissolvedOxygen: 7.2 });
      expect(p.parameter).toBe('dissolvedOxygen');
    }
    for (const [key, field] of [
      ['temp', 'readingTemperature'],
      ['water_temp', 'readingTemperature'],
      ['ph_level', 'readingPh'],
      ['nh3', 'readingAmmonia'],
      ['no2', 'readingNitrite'],
      ['no3', 'readingNitrate'],
      ['ntu', 'readingTurbidity'],
      ['level', 'readingWaterLevel'],
    ] as const) {
      expect(projectPersistedReadings([metric({ channelKey: key, value: 1 })]).fields).toEqual({
        [field]: 1,
      });
    }
  });

  it('reports mappedCount 0 for an out-of-vocabulary batch instead of an empty reading', () => {
    // This is the auto-resolve vector: readings `{}` reads to the alert engine
    // as "nothing is wrong" and closes live INFO/LOW incidents as "returned to
    // normal". The producer must be able to tell "no fields" from "all normal".
    const p = projectPersistedReadings([
      metric({ channelKey: 'flow_rate' }),
      metric({ channelKey: 'orp' }),
      metric({ channelKey: 'co2' }),
    ]);

    expect(p.fields).toEqual({});
    expect(p.mappedCount).toBe(0);
    // The scope is still resolved — a caller that logs the skip can say which
    // farm went unreported.
    expect(p.farmId).toBe(FARM);
  });

  it('folds a multi-channel message into one event and withholds `parameter`', () => {
    const p = projectPersistedReadings([
      metric({ channelKey: 'temperature', value: 19 }),
      metric({ channelKey: 'ph', value: 7.8 }),
      metric({ channelKey: 'do', value: 6.4 }),
    ]);

    expect(p.fields).toEqual({
      readingTemperature: 19,
      readingPh: 7.8,
      readingDissolvedOxygen: 6.4,
    });
    expect(p.mappedCount).toBe(3);
    // "This reading is about X" has no answer for three channels; a consumer
    // reads every populated field instead of trusting a made-up one.
    expect(p.parameter).toBeUndefined();
  });

  it('keeps the scope a partially-mounted sensor does have', () => {
    // A sensor on a pond with no tank must not lose its pond because its first
    // row has a null tank.
    const p = projectPersistedReadings([
      metric({ farmId: FARM, pondId: null, tankId: null, channelKey: 'ph', value: 7 }),
      metric({ farmId: FARM, pondId: POND, tankId: null, channelKey: 'temperature', value: 20 }),
    ]);

    expect(p.farmId).toBe(FARM);
    expect(p.pondId).toBe(POND);
    expect(p.tankId).toBeUndefined();
  });

  it('treats null and empty string as absent rather than emitting them as scope', () => {
    const p = projectPersistedReadings([metric({ farmId: null, pondId: '', tankId: undefined })]);

    expect(p.farmId).toBeUndefined();
    expect(p.pondId).toBeUndefined();
    expect(p.tankId).toBeUndefined();
    expect('farmId' in p).toBe(false);
  });

  it('drops a non-finite value instead of publishing NaN as a measurement', () => {
    const p = projectPersistedReadings([
      metric({ channelKey: 'ph', value: Number.NaN }),
      metric({ channelKey: 'temperature', value: 20 }),
    ]);

    expect(p.fields).toEqual({ readingTemperature: 20 });
    expect(p.mappedCount).toBe(1);
  });

  it('projects an empty batch to nothing publishable', () => {
    const p = projectPersistedReadings([]);
    expect(p.mappedCount).toBe(0);
    expect(p.fields).toEqual({});
  });
});
